/**
 * Warehouse pack inventory API — Phase 1: query available packs for a transfer pick.
 */
const { Op } = require('sequelize');
const db = require('../../db');
const WarehousePack = require('./models');

const SPLIT_EPSILON = 1e-6;

function formatPack(row) {
  const d = row.get ? row.get({ plain: true }) : row;
  return {
    id: d.id,
    packagingNo: d.packaging_no,
    grnId: d.grn_id,
    batchIndex: d.batch_index,
    itemType: d.item_type,
    rawMaterialId: d.raw_material_id,
    packMaterialId: d.pack_material_id,
    productId: d.product_id,
    zone: d.zone,
    rack: d.rack,
    vendorBatch: d.vendor_batch,
    mfgDate: d.mfg_date,
    expDate: d.exp_date,
    qty: d.qty != null ? Number(d.qty) : 0,
    unit: d.unit,
    status: d.status,
    parentPackId: d.parent_pack_id,
    mrnId: d.mrn_id,
  };
}

/** An availability row the picker can act on — a real pack, or loose rack stock. */
function packEntry(row) {
  return { kind: 'pack', key: `pack-${row.id}`, packId: row.id, rackId: null, ...formatPack(row) };
}
function stockEntry(r) {
  return {
    kind: 'stock',
    key: `stock-rack-${r.rack_id}`,
    packId: null,
    rackId: Number(r.rack_id),
    id: Number(r.rack_id),
    packagingNo: null,
    zone: r.zone_name || null,
    rack: r.rack_code || null,
    vendorBatch: null,
    mfgDate: null,
    expDate: null,
    qty: r.qty != null ? Number(r.qty) : 0,
    unit: r.unit || null,
    status: 'available',
  };
}

/** The warehouse_inventory FK column for the requested item (whitelisted — no injection). */
function itemFkColumn(rm, pm, pr) {
  if (rm != null) return { col: 'raw_material_id', val: rm };
  if (pm != null) return { col: 'pack_material_id', val: pm };
  return { col: 'product_id', val: pr };
}

/**
 * Resolve a zone token to the locations it means. Callers pass whatever they hold: a location code
 * (`LOC-ML1`, what production_batches.scheduled_mu_zone stores) or the display label (`ML1`, what
 * warehouse_packs.zone stores). Without this, filtering by the batch's MU zone silently matched
 * nothing and the picker offered stock from every site.
 *
 * @returns {Promise<{locationIds:number[], labels:string[]}|null>} null when no filter was asked for
 */
async function resolveZoneFilter(zoneToken) {
  const z = String(zoneToken || '').trim();
  if (!z) return null;
  const [rows] = await db.query(
    `SELECT id, COALESCE(zone_label, name) AS label
       FROM warehouse_locations
      WHERE UPPER(code) = UPPER(:z)
         OR UPPER(COALESCE(zone_label, '')) = UPPER(:z)
         OR UPPER(COALESCE(name, '')) = UPPER(:z)`,
    { replacements: { z } },
  );
  const list = Array.isArray(rows) ? rows : [];
  // Unknown token → match on the literal so we filter to nothing rather than falling open.
  if (list.length === 0) return { locationIds: [], labels: [z] };
  return {
    locationIds: list.map((r) => Number(r.id)),
    labels: [...new Set(list.map((r) => r.label).filter(Boolean))],
  };
}

/**
 * Loose rack stock for an item (zone/rack/qty) — the fallback when no packs are tracked yet.
 * `zoneFilter` (from resolveZoneFilter) restricts to one site; omit it for all locations.
 */
async function loadRackStock(rm, pm, pr, zoneFilter = null) {
  const { col, val } = itemFkColumn(rm, pm, pr);
  // A zone was requested but resolved to no known location → nothing is pickable there.
  if (zoneFilter && zoneFilter.locationIds.length === 0) return [];
  const [rows] = await db.query(
    `SELECT wri.rack_id AS rack_id,
            wr.code AS rack_code,
            COALESCE(wl.zone_label, wl.name) AS zone_name,
            wi.wh_unit AS unit,
            SUM(wri.qty_wh) AS qty
       FROM warehouse_rack_items wri
       JOIN warehouse_inventory wi ON wi.id = wri.warehouse_inventory_id
       JOIN warehouse_racks wr ON wr.id = wri.rack_id
       JOIN warehouse_locations wl ON wl.id = wr.location_id
      WHERE wi.${col} = :val
        AND wri.qty_wh > 0
        AND (wri.deleted_at IS NULL)
        ${zoneFilter ? 'AND wr.location_id IN (:locationIds)' : ''}
      GROUP BY wri.rack_id, wr.code, wl.zone_label, wl.name, wi.wh_unit
      ORDER BY qty DESC`,
    { replacements: zoneFilter ? { val, locationIds: zoneFilter.locationIds } : { val } },
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * Stock the bucket columns hold that no rack row accounts for.
 *
 * warehouse_inventory carries the authoritative quantity per bucket (WH / ML1 / ML2); rack rows say
 * *where* inside a bucket it sits. A manual stock edit, an inventory import, or an MTR that could
 * not resolve a rack all raise the bucket without creating a rack row — the Inventory panel calls
 * this "not yet assigned to manufacturing racks".
 *
 * Rack-only lookups then showed nothing, so material that is genuinely at the site was unpickable.
 * These synthetic rows expose that remainder so it can be picked; they carry no rackId, which is
 * accurate — nobody has said which rack it is on.
 */
async function loadUnassignedBucketStock(rm, pm, pr, zoneFilter) {
  const { col, val } = itemFkColumn(rm, pm, pr);

  const [[agg] = []] = await db.query(
    `SELECT COALESCE(SUM(wh_stock), 0) AS wh,
            COALESCE(SUM(ml1_stock), 0) AS ml1,
            COALESCE(SUM(ml2_stock), 0) AS ml2,
            MAX(wh_unit) AS unit
       FROM warehouse_inventory WHERE ${col} = :val`,
    { replacements: { val } },
  );
  if (!agg) return [];

  // Rack quantities already accounted for, split the same way recalculateInventoryForItem splits them.
  const [rackRows] = await db.query(
    `SELECT wl.location_type,
            UPPER(COALESCE(wl.code, '') || ' ' || COALESCE(wl.name, '')) AS blob,
            SUM(wri.qty_wh) AS qty
       FROM warehouse_rack_items wri
       JOIN warehouse_inventory wi ON wi.id = wri.warehouse_inventory_id
       JOIN warehouse_racks wr ON wr.id = wri.rack_id
       JOIN warehouse_locations wl ON wl.id = wr.location_id
      WHERE wi.${col} = :val AND wri.qty_wh > 0 AND wri.deleted_at IS NULL
      GROUP BY wl.location_type, wl.code, wl.name`,
    { replacements: { val } },
  );
  const onRacks = { wh: 0, ml1: 0, ml2: 0 };
  for (const r of Array.isArray(rackRows) ? rackRows : []) {
    const qty = Number(r.qty) || 0;
    if (String(r.location_type || '').toLowerCase() !== 'production') onRacks.wh += qty;
    else if (String(r.blob || '').includes('ML2')) onRacks.ml2 += qty;
    else onRacks.ml1 += qty;
  }

  // The production zones the ML1/ML2 buckets correspond to, so the rows carry a real zone label.
  const [zones] = await db.query(
    `SELECT id, code, COALESCE(zone_label, name) AS label,
            UPPER(COALESCE(code, '') || ' ' || COALESCE(name, '')) AS blob
       FROM warehouse_locations WHERE location_type = 'production'`,
  );
  const zoneFor = (bucket) => (Array.isArray(zones) ? zones : []).find((z) => (
    bucket === 'ml2' ? String(z.blob || '').includes('ML2') : !String(z.blob || '').includes('ML2')
  )) || null;

  const unit = agg.unit || null;
  const out = [];
  for (const bucket of ['ml1', 'ml2']) {
    const loose = Number(agg[bucket] || 0) - onRacks[bucket];
    if (loose <= 1e-6) continue;
    const zone = zoneFor(bucket);
    if (zoneFilter && (!zone || !zoneFilter.locationIds.includes(Number(zone.id)))) continue;
    out.push({
      kind: 'stock',
      key: `stock-unassigned-${bucket}`,
      packId: null,
      rackId: null,
      id: null,
      packagingNo: null,
      zone: zone ? zone.label : bucket.toUpperCase(),
      rack: null,
      unassigned: true,
      vendorBatch: null,
      mfgDate: null,
      expDate: null,
      qty: Number(loose.toFixed(6)),
      unit,
      status: 'available',
    });
  }
  return out;
}

function intOrNull(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * GET /api/v1/warehouse-packs/available
 * Query: rawMaterialId | packMaterialId | productId (one required), optional zone.
 * Returns available packs FEFO-sorted (earliest expiry, then earliest MFG).
 */
async function listAvailable(req, res) {
  try {
    const rm = intOrNull(req.query.rawMaterialId);
    const pm = intOrNull(req.query.packMaterialId);
    const pr = intOrNull(req.query.productId);
    if (rm == null && pm == null && pr == null) {
      return res.status(400).json({ error: 'One of rawMaterialId, packMaterialId, or productId is required' });
    }
    const where = { status: 'available', lifecycle_status: 'active' };
    if (rm != null) where.raw_material_id = rm;
    if (pm != null) where.pack_material_id = pm;
    if (pr != null) where.product_id = pr;
    // Accepts a location code (LOC-ML1) or its label (ML1) — packs store the label, batches the code.
    const zoneFilter = await resolveZoneFilter(req.query.zone);
    if (zoneFilter) where.zone = { [Op.in]: zoneFilter.labels };
    // Only packs with positive remaining qty are pickable.
    where.qty = { [Op.gt]: 0 };
    // Only real GRN-received packs are shown as packs. Interim packs materialized from loose
    // stock (grn_id NULL) are ignored — their qty already sits in the rack's loose total, and
    // pick/split is now client-side (it never persists packs), so those are stale leftovers.
    where.grn_id = { [Op.ne]: null };

    const rows = await WarehousePack.findAll({
      where,
      order: [
        ['exp_date', 'ASC'], // FEFO — first expiry first out
        ['mfg_date', 'ASC'],
        ['packaging_no', 'ASC'],
      ],
      limit: 500,
    });

    // Show tracked packs, plus any loose rack stock NOT already covered by packs (netted per
    // rack so nothing double-counts and nothing gets hidden when only part of a rack is packed).
    const stock = await loadRackStock(rm, pm, pr, zoneFilter);
    const packQtyByRack = new Map();
    for (const p of rows) {
      const rc = String(p.get('rack') || '').trim();
      packQtyByRack.set(rc, (packQtyByRack.get(rc) || 0) + Number(p.get('qty') || 0));
    }
    const entries = rows.map(packEntry);
    for (const r of stock) {
      const used = packQtyByRack.get(String(r.rack_code || '').trim()) || 0;
      const loose = Number(r.qty || 0) - used;
      if (loose > 1e-6) entries.push(stockEntry({ ...r, qty: loose }));
    }
    // Bucket stock that no rack row accounts for (manual edits, imports, unresolved MTRs) — real
    // stock at the site that would otherwise be invisible to a rack-only lookup.
    entries.push(...await loadUnassignedBucketStock(rm, pm, pr, zoneFilter));
    return res.json(entries);
  } catch (err) {
    console.error('[warehouse-packs] listAvailable error', err);
    res.status(500).json({ error: err.message || 'Failed to load available packs' });
  }
}

/**
 * POST /api/v1/warehouse-packs/materialize
 * Turn loose rack stock into labelled packs. Body: { rawMaterialId|packMaterialId|productId,
 * rackId, qtys: number[] }. Takes the split quantities you specify; if they don't consume all
 * the loose stock on that rack, the remainder is added as its own pack — so every part is
 * labelled. The aggregate qty is unchanged (packs represent the same physical stock).
 */
async function materializeRackStock(req, res) {
  try {
    const body = req.body || {};
    const rm = intOrNull(body.rawMaterialId);
    const pm = intOrNull(body.packMaterialId);
    const pr = intOrNull(body.productId);
    if (rm == null && pm == null && pr == null) {
      return res.status(400).json({ error: 'One of rawMaterialId, packMaterialId, or productId is required' });
    }
    const rackId = intOrNull(body.rackId);
    if (rackId == null) return res.status(400).json({ error: 'rackId is required' });
    const qtys = Array.isArray(body.qtys)
      ? body.qtys.map(Number).filter((q) => Number.isFinite(q) && q > 0)
      : [];
    if (qtys.length < 1) return res.status(400).json({ error: 'Provide the quantities to split off.' });

    const { col, val } = itemFkColumn(rm, pm, pr);
    // Rack label + zone.
    const [[rack] = []] = await db.query(
      `SELECT wr.code AS rack_code, COALESCE(wl.zone_label, wl.name) AS zone_name
         FROM warehouse_racks wr JOIN warehouse_locations wl ON wl.id = wr.location_id
        WHERE wr.id = :rackId`,
      { replacements: { rackId } },
    );
    if (!rack) return res.status(404).json({ error: 'Rack not found' });

    // Loose = aggregate qty on this rack for the item, minus packs already carved out of it.
    const [[bucket] = []] = await db.query(
      `SELECT COALESCE(SUM(wri.qty_wh), 0) AS qty, MAX(wi.wh_unit) AS unit, MAX(wi.item_type) AS item_type
         FROM warehouse_rack_items wri
         JOIN warehouse_inventory wi ON wi.id = wri.warehouse_inventory_id
        WHERE wri.rack_id = :rackId AND wi.${col} = :val AND (wri.deleted_at IS NULL)`,
      { replacements: { rackId, val } },
    );
    const bucketQty = bucket ? Number(bucket.qty) || 0 : 0;
    // Match on zone AND rack: rack codes like "DEFAULT" exist in every zone, so matching the code
    // alone subtracted packs sitting at OTHER sites from this rack's loose total.
    const existingPacks = (await WarehousePack.sum('qty', {
      where: {
        status: 'available',
        lifecycle_status: 'active',
        [col]: val,
        rack: rack.rack_code,
        ...(rack.zone_name ? { zone: rack.zone_name } : {}),
      },
    })) || 0;
    const loose = bucketQty - Number(existingPacks);
    if (loose <= 1e-6) {
      return res.status(409).json({ error: 'No loose stock on this rack to split.' });
    }

    const sum = qtys.reduce((a, b) => a + b, 0);
    if (sum > loose + 1e-6) {
      return res.status(400).json({ error: `Quantities total ${sum}, which exceeds the ${loose} loose on this rack.` });
    }
    const finalQtys = [...qtys];
    const remainder = loose - sum;
    if (remainder > 1e-6) finalQtys.push(Number(remainder.toFixed(6)));

    const itemType = bucket && bucket.item_type ? bucket.item_type : rm != null ? 'RM' : pm != null ? 'PM' : 'PR';
    const unit = bucket && bucket.unit ? bucket.unit : null;
    const token = Date.now().toString(36);
    const children = [];
    for (let i = 0; i < finalQtys.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const child = await WarehousePack.create({
        packaging_no: `PKG-WH-${rackId}-${token}-${i + 1}`,
        item_type: itemType,
        raw_material_id: rm,
        pack_material_id: pm,
        product_id: pr,
        zone: rack.zone_name || null,
        rack: rack.rack_code || null,
        qty: finalQtys[i],
        unit,
        status: 'available',
      });
      children.push(child);
    }
    res.json({ children: children.map(packEntry) });
  } catch (err) {
    console.error('[warehouse-packs] materialize error', err);
    res.status(500).json({ error: err.message || 'Failed to split rack stock' });
  }
}

/**
 * POST /api/v1/warehouse-packs/:id/split
 * Break an available pack into child packs (PKG-SPLIT-…). Body: { qtys: number[] }.
 * If the child quantities fully consume the source it's marked 'split'; a leftover keeps
 * the source available with the remainder. Children inherit item/zone/rack/batch/dates.
 * Labels are generated for every child (picked and remaining alike).
 */
async function splitPack(req, res) {
  try {
    const id = intOrNull(req.params.id);
    if (id == null) return res.status(400).json({ error: 'Invalid pack id' });
    const qtys = Array.isArray(req.body && req.body.qtys)
      ? req.body.qtys.map(Number).filter((q) => Number.isFinite(q) && q > 0)
      : [];
    if (qtys.length < 1) {
      return res.status(400).json({ error: 'Provide the quantity to take from this pack.' });
    }

    const t = await db.transaction();
    try {
      const source = await WarehousePack.findByPk(id, { transaction: t });
      if (!source) {
        await t.rollback();
        return res.status(404).json({ error: 'Pack not found' });
      }
      const sd = source.get({ plain: true });
      if (sd.status !== 'available') {
        await t.rollback();
        return res.status(409).json({ error: `Pack is "${sd.status}" — only available packs can be split.` });
      }
      const sourceQty = Number(sd.qty) || 0;
      const sum = qtys.reduce((a, b) => a + b, 0);
      if (sum > sourceQty + SPLIT_EPSILON) {
        await t.rollback();
        return res
          .status(400)
          .json({ error: `Child quantities total ${sum}, which exceeds the pack's ${sourceQty} ${sd.unit || ''}.` });
      }

      const token = Date.now().toString(36);
      const children = [];
      for (let i = 0; i < qtys.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const child = await WarehousePack.create(
          {
            packaging_no: `PKG-SPLIT-${sd.id}-${token}-${i + 1}`,
            grn_id: sd.grn_id,
            batch_index: sd.batch_index,
            item_type: sd.item_type,
            raw_material_id: sd.raw_material_id,
            pack_material_id: sd.pack_material_id,
            product_id: sd.product_id,
            zone: sd.zone,
            rack: sd.rack,
            vendor_batch: sd.vendor_batch,
            mfg_date: sd.mfg_date,
            exp_date: sd.exp_date,
            qty: qtys[i],
            unit: sd.unit,
            status: 'available',
            parent_pack_id: sd.id,
          },
          { transaction: t },
        );
        children.push(child);
      }

      const remainder = sourceQty - sum;
      if (remainder <= SPLIT_EPSILON) {
        await source.update({ status: 'split', qty: 0 }, { transaction: t });
      } else {
        await source.update({ qty: remainder }, { transaction: t });
      }

      await t.commit();
      await source.reload();
      // packEntry (not formatPack) so the client gets kind/key like the availability rows.
      res.json({ source: packEntry(source), children: children.map(packEntry) });
    } catch (e) {
      await t.rollback();
      throw e;
    }
  } catch (err) {
    console.error('[warehouse-packs] split error', err);
    res.status(500).json({ error: err.message || 'Failed to split pack' });
  }
}

module.exports = { listAvailable, splitPack, materializeRackStock, formatPack };

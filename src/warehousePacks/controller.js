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

/** Loose rack stock for an item (zone/rack/qty) — the fallback when no packs are tracked yet. */
async function loadRackStock(rm, pm, pr) {
  const { col, val } = itemFkColumn(rm, pm, pr);
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
      GROUP BY wri.rack_id, wr.code, wl.zone_label, wl.name, wi.wh_unit
      ORDER BY qty DESC`,
    { replacements: { val } },
  );
  return Array.isArray(rows) ? rows : [];
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
    const zone = req.query.zone != null ? String(req.query.zone).trim() : '';
    if (zone) where.zone = zone;
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
    const stock = await loadRackStock(rm, pm, pr);
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
    const existingPacks = (await WarehousePack.sum('qty', {
      where: { status: 'available', lifecycle_status: 'active', [col]: val, rack: rack.rack_code },
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

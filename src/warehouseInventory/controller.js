/**
 * Warehouse Inventory API — list (with RM/PM/PR + item groups) and PATCH for adjust stock.
 * stock_in_hand = wh_stock + ml1_stock + ml2_stock (computed).
 * RM/PM in-transit uses warehouse_inventory.in_transit (inTransitSync: GRNs + procurement PO pipeline),
 * with GRN logistics rows as breakdown detail; PO quantity is derived from purchase_orders.items.
 */
const WarehouseInventory = require('./models');
const WarehouseInventoryLocationHistory = require('./locationHistoryModel');
const { recalculateInventoryForItem } = require('./inventoryMath');
const { logLocationMovement, logReservedChange } = require('./locationHistoryHelpers');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { Product } = require('../products/models');
const ItemGroup = require('../itemGroups/models');
const { WarehouseRackItem, WarehouseRack, WarehouseLocation } = require('../warehouseLocations/models');
const { buildStockByLocationPayload, setWarehouseRackQuantities } = require('./rackStockHelpers');
const { Op } = require('sequelize');
const GoodsReceivedNote = require('../grn/models');
const PurchaseOrder = require('../purchaseOrders/models');
const { quantityToKg } = require('./quantityToKg');
const { loadRmPmMeta, getCompletedGrnReceivedKgByKey } = require('./inTransitSync');
const db = require('../../db');

function toNum(x) {
  if (x == null) return 0;
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

let locationHistoryAuditEnsured = false;
async function ensureLocationHistoryAuditColumns() {
  if (locationHistoryAuditEnsured) return;
  locationHistoryAuditEnsured = true;
  try {
    const dialect = db.getDialect && db.getDialect();
    if (dialect === 'postgres') {
      await db.query(
        'ALTER TABLE warehouse_inventory_location_history ADD COLUMN IF NOT EXISTS changes_json JSONB'
      );
      await db.query(
        'ALTER TABLE warehouse_inventory_location_history ADD COLUMN IF NOT EXISTS note TEXT'
      );
    }
  } catch (e) {
    console.warn(
      '[warehouse-inventory] ensureLocationHistoryAuditColumns:',
      e && e.message ? e.message : e
    );
  }
}

/** Normalized snapshot for audit trail (PATCH inventory). */
function inventoryAuditSnapshot(wh) {
  const w = wh.get ? wh.get({ plain: true }) : wh;
  const whStock = toNum(w.wh_stock);
  const ml1 = toNum(w.ml1_stock);
  const ml2 = toNum(w.ml2_stock);
  return {
    wh_stock: whStock,
    ml1_stock: ml1,
    ml2_stock: ml2,
    stock_in_hand: whStock + ml1 + ml2,
    reserved: toNum(w.reserved),
    in_transit: toNum(w.in_transit),
    zone: w.zone != null ? String(w.zone) : '',
    rack: w.rack != null ? String(w.rack) : '',
    qc_status: w.qc_status != null ? String(w.qc_status) : '',
    wh_unit: w.wh_unit != null ? String(w.wh_unit) : '',
    reorder_pt: toNum(w.reorder_pt),
    avg_mo: toNum(w.avg_mo),
    batch_number: w.batch_number != null ? String(w.batch_number) : '',
    expiry_date: w.expiry_date != null ? String(w.expiry_date).slice(0, 10) : '',
  };
}

function auditFieldChanged(key, beforeVal, afterVal) {
  const numeric = [
    'wh_stock',
    'ml1_stock',
    'ml2_stock',
    'stock_in_hand',
    'reserved',
    'in_transit',
    'reorder_pt',
    'avg_mo',
  ].includes(key);
  if (numeric) {
    return Math.abs(toNum(beforeVal) - toNum(afterVal)) > 1e-6;
  }
  return String(beforeVal ?? '') !== String(afterVal ?? '');
}

function buildMemberToGroupsMap(groups) {
  const map = new Map();
  for (const g of groups) {
    const ids = Array.isArray(g.member_ids) ? g.member_ids : [];
    for (const id of ids) {
      const n = typeof id === 'number' ? id : parseInt(String(id), 10);
      if (Number.isNaN(n)) continue;
      if (!map.has(n)) map.set(n, []);
      map.get(n).push(g);
    }
  }
  return map;
}

/**
 * `warehouse_inventory.in_transit` is recomputed by inTransitSync (GRN pipeline + PO procurement
 * "mark in transit" / Delivery Pending). The list API used to show only GRN logistics rows here,
 * which missed PO-side pipeline. Use persisted total minus Under GRN (shown in its own column).
 */
function inTransitQtyForListRow(wh, grnLogisticsBreakdown, underGrnQty) {
  const persisted = toNum(wh.in_transit);
  const under = toNum(underGrnQty);
  const fromSync = Math.max(0, persisted - under);
  const grnSum = (grnLogisticsBreakdown || []).reduce((s, b) => s + toNum(b.quantity), 0);
  const pipelineOnly = Math.max(0, fromSync - grnSum);
  let breakdown = Array.isArray(grnLogisticsBreakdown) ? [...grnLogisticsBreakdown] : [];
  if (pipelineOnly > 1e-6) {
    breakdown.push({
      vendor: '',
      poId: null,
      poNo: 'Issued PO — procurement in transit (no inbound GRN row yet)',
      expectedDate: null,
      quantity: pipelineOnly,
    });
  }
  return { inTransitQty: fromSync, inTransitBreakdown: breakdown };
}

/** GRN rows in logistics statuses only (excludes Under GRN — that column is separate). Used as list breakdown detail; totals use synced wh.in_transit. */
async function getInTransitBreakdown() {
  const map = new Map();
  try {
    const grns = await GoodsReceivedNote.findAll({
      where: { status: { [Op.in]: ['In Transit', 'Pending', 'Delayed', 'On Hold'] } },
      attributes: ['id', 'vendor', 'purchase_order_id', 'po_no', 'expected_date', 'line_items'],
    });
    const rmIds = new Set();
    const pmIds = new Set();
    for (const g of grns) {
      const d = g.get ? g.get({ plain: true }) : g;
      const lines = Array.isArray(d.line_items) ? d.line_items : [];
      for (const line of lines) {
        if (line.raw_material_id != null) rmIds.add(Number(line.raw_material_id));
        if (line.pack_material_id != null) pmIds.add(Number(line.pack_material_id));
      }
    }
    const { rmMeta, pmMeta } = await loadRmPmMeta(rmIds, pmIds);
    for (const g of grns) {
      const d = g.get ? g.get({ plain: true }) : g;
      const vendor = d.vendor || '';
      const poId = d.purchase_order_id != null ? d.purchase_order_id : null;
      const poNo = d.po_no || '';
      const expectedDate = d.expected_date || null;
      const lines = Array.isArray(d.line_items) ? d.line_items : [];
      for (const line of lines) {
        const qty = toNum(line.poQty ?? line.quantity ?? line.qty);
        if (qty <= 0) continue;
        let key = null;
        if (line.raw_material_id != null) key = `rm-${line.raw_material_id}`;
        else if (line.pack_material_id != null) key = `pm-${line.pack_material_id}`;
        if (!key) continue;
        const unit = String(line.unit ?? line.UOM ?? '').trim();
        const itemType = key.startsWith('rm-') ? 'RM' : 'PM';
        const id = itemType === 'RM' ? Number(line.raw_material_id) : Number(line.pack_material_id);
        const meta = itemType === 'RM' ? rmMeta.get(id) : pmMeta.get(id);
        const qtyKg = quantityToKg(qty, unit, {
          itemType,
          masterUom: itemType === 'RM' ? meta?.uom : meta?.unit,
          sizeSpec: itemType === 'PM' ? meta?.size_spec : null,
        });
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ vendor, poId, poNo, expectedDate, quantity: qtyKg });
      }
    }
  } catch (err) {
    console.warn('[warehouse-inventory] getInTransitBreakdown error:', err.message);
  }
  return map;
}

/** Under GRN = quantities currently in GRN workflow before inventory booking. Returns Map<itemKey, number>. */
async function getUnderGrnQuantityByItem() {
  const map = new Map();
  try {
    const grns = await GoodsReceivedNote.findAll({
      where: { status: 'Under GRN' },
      attributes: ['line_items'],
    });
    const rmIds = new Set();
    const pmIds = new Set();
    for (const g of grns) {
      const d = g.get ? g.get({ plain: true }) : g;
      const lines = Array.isArray(d.line_items) ? d.line_items : [];
      for (const line of lines) {
        if (line.raw_material_id != null) rmIds.add(Number(line.raw_material_id));
        if (line.pack_material_id != null) pmIds.add(Number(line.pack_material_id));
      }
    }
    const { rmMeta, pmMeta } = await loadRmPmMeta(rmIds, pmIds);
    for (const g of grns) {
      const d = g.get ? g.get({ plain: true }) : g;
      const lines = Array.isArray(d.line_items) ? d.line_items : [];
      for (const line of lines) {
        const qty = toNum(line.poQty ?? line.quantity ?? line.qty);
        if (qty <= 0) continue;
        let key = null;
        if (line.raw_material_id != null) key = `rm-${line.raw_material_id}`;
        else if (line.pack_material_id != null) key = `pm-${line.pack_material_id}`;
        if (!key) continue;
        const unit = String(line.unit ?? line.UOM ?? '').trim();
        const itemType = key.startsWith('rm-') ? 'RM' : 'PM';
        const id = itemType === 'RM' ? Number(line.raw_material_id) : Number(line.pack_material_id);
        const meta = itemType === 'RM' ? rmMeta.get(id) : pmMeta.get(id);
        const qtyKg = quantityToKg(qty, unit, {
          itemType,
          masterUom: itemType === 'RM' ? meta?.uom : meta?.unit,
          sizeSpec: itemType === 'PM' ? meta?.size_spec : null,
        });
        map.set(key, (map.get(key) || 0) + qtyKg);
      }
    }
  } catch (err) {
    console.warn('[warehouse-inventory] getUnderGrnQuantityByItem error:', err.message);
  }
  return map;
}

/** PO quantity = sum of quantities from all purchase_orders.items by raw_material_id / pack_material_id. Returns Map<itemKey, number>. */
async function getPoQuantityByItem() {
  const map = new Map();
  const poQtyDebug = process.env.EI_DEBUG_WAREHOUSE_PO_QTY === '1';
  try {
    const pos = await PurchaseOrder.findAll({ attributes: ['id', 'status', 'items'] });
    const rmIds = new Set();
    const pmIds = new Set();
    for (const po of pos) {
      const d = po.get ? po.get({ plain: true }) : po;
      const items = Array.isArray(d.items) ? d.items : [];
      for (const line of items) {
        if (line.raw_material_id != null) rmIds.add(Number(line.raw_material_id));
        if (line.pack_material_id != null) pmIds.add(Number(line.pack_material_id));
      }
    }
    const { rmMeta, pmMeta } = await loadRmPmMeta(rmIds, pmIds);
    for (const po of pos) {
      const d = po.get ? po.get({ plain: true }) : po;
      const items = Array.isArray(d.items) ? d.items : [];
      for (const line of items) {
        const qty = toNum(line.quantity ?? line.qty ?? line.poQty);
        if (qty <= 0) continue;
        let key = null;
        if (line.raw_material_id != null) key = `rm-${line.raw_material_id}`;
        else if (line.pack_material_id != null) key = `pm-${line.pack_material_id}`;
        if (!key) continue;
        const unit = String(line.unit ?? line.UOM ?? '').trim();
        const itemType = key.startsWith('rm-') ? 'RM' : 'PM';
        const id = itemType === 'RM' ? Number(line.raw_material_id) : Number(line.pack_material_id);
        const meta = itemType === 'RM' ? rmMeta.get(id) : pmMeta.get(id);
        const qtyKg = quantityToKg(qty, unit, {
          itemType,
          masterUom: itemType === 'RM' ? meta?.uom : meta?.unit,
          sizeSpec: itemType === 'PM' ? meta?.size_spec : null,
        });
        map.set(key, (map.get(key) || 0) + qtyKg);
      }
    }
    if (poQtyDebug) {
      const perPo = [];
      for (const po of pos) {
        const d = po.get ? po.get({ plain: true }) : po;
        const items = Array.isArray(d.items) ? d.items : [];
        let skippedNoFk = 0;
        let skippedZeroQty = 0;
        for (const line of items) {
          const qty = toNum(line.quantity ?? line.qty ?? line.poQty);
          if (qty <= 0) {
            skippedZeroQty += 1;
            continue;
          }
          if (line.raw_material_id == null && line.pack_material_id == null) skippedNoFk += 1;
        }
        perPo.push({
          poId: d.id,
          status: d.status,
          lineCount: items.length,
          skippedZeroQty,
          skippedNoFkPositiveQty: skippedNoFk,
        });
      }
      const nonZero = [...map.entries()].filter(([, v]) => v > 0);
      console.log('[warehouse-po-qty DEBUG] per PO (set EI_DEBUG_WAREHOUSE_PO_QTY=0 to disable):', JSON.stringify(perPo));
      console.log('[warehouse-po-qty DEBUG] aggregated rm-/pm- keys (non-zero qty):', nonZero.slice(0, 40));
    }
  } catch (err) {
    console.warn('[warehouse-inventory] getPoQuantityByItem error:', err.message);
  }
  return map;
}

/**
 * GET /api/v1/warehouse-inventory
 * Returns { rows, itemGroups }. Each row has id (e.g. rm-1), code, name, subtitle, type, itemGroupNames, itemGroupCodes,
 * warehouseInventoryId, zone, rack, whStock, whUnit, ml1Stock, ml2Stock, stockInHand (computed), reserved,
 * inTransit, underGrn, inTransitBreakdown, poQuantity (gross PO lines minus GRN Complete received, Under GRN, in-transit), reorderPt, avgMo, status.
 */
async function list(req, res) {
  try {
    // IMPORTANT:
    // Do not recompute reserved on every GET. That caused heavy repeated RM/PM queries
    // and log spam when clients refreshed inventory.
    // Reserved values are synced at write paths (planning/production/warehouse updates).

    const limitQ = req.query.limit;
    const offsetQ = req.query.offset;
    const wantsPagination = limitQ != null || offsetQ != null;

    const normalizeInt = (v) => {
      const n = parseInt(String(v), 10);
      return Number.isNaN(n) ? null : n;
    };

    if (wantsPagination) {
      const limit = limitQ != null ? normalizeInt(limitQ) : 20;
      const offset = offsetQ != null ? normalizeInt(offsetQ) : 0;
      if (limit == null || offset == null || limit <= 0 || offset < 0) {
        return res.status(400).json({ error: 'Invalid pagination params (limit must be > 0, offset must be >= 0)' });
      }
      const payload = await listPayload({ limit, offset });
      const total = await WarehouseInventory.count();
      console.log(
        '[warehouse-inventory] GET list (paginated): rows=%d, total=%d, itemGroups=%d',
        payload.rows.length,
        total,
        payload.itemGroups.length
      );
      return res.json({ rows: payload.rows, total, limit, offset, itemGroups: payload.itemGroups });
    }

    const payload = await listPayload();
    console.log(
      '[warehouse-inventory] GET list: rows=%d, itemGroups=%d',
      payload.rows.length,
      payload.itemGroups.length
    );
    res.json(payload);
  } catch (err) {
    console.error('[warehouse-inventory] GET list error:', err);
    res.status(500).json({ error: err.message || 'Failed to list warehouse inventory' });
  }
}

/**
 * PATCH /api/v1/warehouse-inventory/:id
 * Body: any of wh_stock, ml1_stock, ml2_stock, reserved, in_transit, zone, rack, qc_status, wh_unit,
 *       reorder_pt, avg_mo, batch_number, expiry_date (YYYY-MM-DD), note (audit note).
 * Recomputes stock_in_hand = wh_stock + ml1_stock + ml2_stock.
 * Writes one INVENTORY_ADJUST history row with before/after when anything changes or note is non-empty.
 */
async function updateStock(req, res) {
  try {
    await ensureLocationHistoryAuditColumns();
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid warehouse inventory id' });
    }
    const row = await WarehouseInventory.findByPk(id);
    if (!row) {
      return res.status(404).json({ error: 'Warehouse inventory row not found' });
    }
    const wh = row.get ? row.get({ plain: true }) : row;
    const beforeSnap = inventoryAuditSnapshot(row);
    const body = req.body || {};
    const updates = {};
    const noteRaw =
      body.note != null ? String(body.note) : body.reason != null ? String(body.reason) : '';
    const note = noteRaw.trim() || null;

    let whStock = beforeSnap.wh_stock;
    let ml1Stock = beforeSnap.ml1_stock;
    let ml2Stock = beforeSnap.ml2_stock;

    if (body.wh_stock != null) {
      whStock = Number(body.wh_stock);
      updates.wh_stock = whStock;
    }
    if (body.ml1_stock != null) {
      ml1Stock = Number(body.ml1_stock);
      updates.ml1_stock = ml1Stock;
    }
    if (body.ml2_stock != null) {
      ml2Stock = Number(body.ml2_stock);
      updates.ml2_stock = ml2Stock;
    }
    if (body.reserved != null) updates.reserved = Number(body.reserved);
    if (body.in_transit != null) updates.in_transit = Number(body.in_transit);
    if (body.zone != null) updates.zone = String(body.zone);
    if (body.rack != null) updates.rack = String(body.rack);
    if (body.qc_status != null) updates.qc_status = String(body.qc_status);
    if (body.wh_unit != null) {
      const u = String(body.wh_unit).trim().slice(0, 20);
      if (u) updates.wh_unit = u;
    }
    if (body.reorder_pt != null) updates.reorder_pt = Number(body.reorder_pt);
    if (body.avg_mo != null) updates.avg_mo = Number(body.avg_mo);
    const rackQtyRaw = body.rack_quantities ?? body.rackQuantities;
    if (Array.isArray(rackQtyRaw) && rackQtyRaw.length > 0) {
      await setWarehouseRackQuantities(id, rackQtyRaw);
      const refreshed = await WarehouseInventory.findByPk(id);
      if (refreshed) {
        const r = refreshed.get ? refreshed.get({ plain: true }) : refreshed;
        whStock = toNum(r.wh_stock);
        ml1Stock = toNum(r.ml1_stock);
        ml2Stock = toNum(r.ml2_stock);
        updates.wh_stock = whStock;
        updates.ml1_stock = ml1Stock;
        updates.ml2_stock = ml2Stock;
        if (r.zone != null) updates.zone = r.zone;
        if (r.rack != null) updates.rack = r.rack;
      }
    }
    if (body.batch_number !== undefined) {
      const b = String(body.batch_number ?? '').trim().slice(0, 50);
      updates.batch_number = b || null;
    }
    if (body.expiry_date !== undefined) {
      const s = body.expiry_date == null || body.expiry_date === '' ? null : String(body.expiry_date).trim().slice(0, 10);
      updates.expiry_date = s;
    }

    updates.stock_in_hand = whStock + ml1Stock + ml2Stock;

    if (Object.keys(updates).length === 0 && !note) {
      const updatedRow = await WarehouseInventory.findByPk(id);
      const u = updatedRow.get ? updatedRow.get({ plain: true }) : updatedRow;
      return res.json({
        id: u.id,
        wh_stock: toNum(u.wh_stock),
        ml1_stock: toNum(u.ml1_stock),
        ml2_stock: toNum(u.ml2_stock),
        stock_in_hand: toNum(u.stock_in_hand),
        reserved: toNum(u.reserved),
        in_transit: toNum(u.in_transit),
        zone: u.zone,
        rack: u.rack,
        qc_status: u.qc_status,
        wh_unit: u.wh_unit,
        reorder_pt: toNum(u.reorder_pt),
        avg_mo: toNum(u.avg_mo),
        batch_number: u.batch_number ?? null,
        expiry_date: u.expiry_date ?? null,
      });
    }

    await row.update(updates);
    const updatedRow = await WarehouseInventory.findByPk(id);
    const afterSnap = inventoryAuditSnapshot(updatedRow);
    const changed = {};
    for (const key of Object.keys(beforeSnap)) {
      if (auditFieldChanged(key, beforeSnap[key], afterSnap[key])) {
        changed[key] = [beforeSnap[key], afterSnap[key]];
      }
    }

    if (Object.keys(changed).length > 0 || note) {
      await logLocationMovement({
        warehouseInventoryId: wh.id,
        itemType: wh.item_type,
        rawMaterialId: wh.raw_material_id,
        packMaterialId: wh.pack_material_id,
        productId: wh.product_id,
        fromZone: beforeSnap.zone || null,
        fromRack: beforeSnap.rack || null,
        toZone: afterSnap.zone || null,
        toRack: afterSnap.rack || null,
        qtyDelta: afterSnap.stock_in_hand - beforeSnap.stock_in_hand,
        actionType: 'INVENTORY_ADJUST',
        changesJson: { before: beforeSnap, after: afterSnap, changed },
        note,
      });
    }

    const updated = updatedRow.get ? updatedRow.get({ plain: true }) : updatedRow;
    console.log(
      '[warehouse-inventory] PATCH id=%d: wh_stock=%s ml1=%s ml2=%s stock_in_hand=%s',
      id,
      updated.wh_stock,
      updated.ml1_stock,
      updated.ml2_stock,
      updated.stock_in_hand
    );
    res.json({
      id: updated.id,
      wh_stock: toNum(updated.wh_stock),
      ml1_stock: toNum(updated.ml1_stock),
      ml2_stock: toNum(updated.ml2_stock),
      stock_in_hand: toNum(updated.stock_in_hand),
      reserved: toNum(updated.reserved),
      in_transit: toNum(updated.in_transit),
      zone: updated.zone,
      rack: updated.rack,
      qc_status: updated.qc_status,
      wh_unit: updated.wh_unit,
      reorder_pt: toNum(updated.reorder_pt),
      avg_mo: toNum(updated.avg_mo),
      batch_number: updated.batch_number ?? null,
      expiry_date: updated.expiry_date ?? null,
    });
  } catch (err) {
    console.error('[warehouse-inventory] PATCH error:', err);
    res.status(500).json({ error: err.message || 'Failed to update warehouse inventory' });
  }
}

/**
 * GET /api/v1/warehouse-inventory/:id/location-history
 * Returns chronological history of internal moves (zone/rack changes) for a given warehouse_inventory row.
 */
async function listLocationHistory(req, res) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid warehouse inventory id' });
    }

    const rows = await WarehouseInventoryLocationHistory.findAll({
      where: { warehouse_inventory_id: id },
      order: [['moved_at', 'DESC']],
    });

    const history = rows.map((r) => {
      const h = r.get ? r.get({ plain: true }) : r;
      return {
        id: h.id,
        warehouseInventoryId: h.warehouse_inventory_id,
        itemType: h.item_type,
        rawMaterialId: h.raw_material_id,
        packMaterialId: h.pack_material_id,
        productId: h.product_id,
        fromZone: h.from_zone,
        fromRack: h.from_rack,
        toZone: h.to_zone,
        toRack: h.to_rack,
        movedAt: h.moved_at,
        reservedDelta: h.reserved_delta != null ? Number(h.reserved_delta) : null,
        reservedAfter: h.reserved_after != null ? Number(h.reserved_after) : null,
        productionBatchId: h.production_batch_id ?? null,
        batchNo: h.batch_no ?? null,
        actionType: h.action_type ?? null,
        qtyDelta: h.qty_delta != null ? Number(h.qty_delta) : null,
        dispensingBundleId: h.dispensing_bundle_id ?? null,
        changesJson: h.changes_json ?? null,
        note: h.note ?? null,
      };
    });

    return res.json({ history });
  } catch (err) {
    // If the history table doesn't exist yet, fail gracefully with empty history
    const msg = err && err.message ? String(err.message) : '';
    const code = err && err.original && err.original.code ? String(err.original.code) : '';
    if (
      code === '42P01' ||
      /warehouse_inventory_location_history/i.test(msg) ||
      /relation "warehouse_inventory_location_history" does not exist/i.test(msg)
    ) {
      console.warn('[warehouse-inventory] location-history table missing, returning empty history');
      return res.json({ history: [] });
    }

    console.error('[warehouse-inventory] GET location-history error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch location history' });
  }
}

/**
 * GET /api/v1/warehouse-inventory/location-history
 * Returns consolidated history of internal moves for all items (RM/PM/PR), newest first.
 * Used by the Inventory History tab to show an itemised movement log.
 */
async function listAllLocationHistory(req, res) {
  try {
    const rows = await WarehouseInventoryLocationHistory.findAll({
      order: [['moved_at', 'DESC']],
    });

    const plain = rows.map((r) => (r.get ? r.get({ plain: true }) : r));

    const rmIds = [
      ...new Set(
        plain
          .filter((h) => h.item_type === 'RM' && h.raw_material_id != null)
          .map((h) => h.raw_material_id)
      ),
    ];
    const pmIds = [
      ...new Set(
        plain
          .filter((h) => h.item_type === 'PM' && h.pack_material_id != null)
          .map((h) => h.pack_material_id)
      ),
    ];
    const productIds = [
      ...new Set(
        plain
          .filter((h) => h.item_type === 'PR' && h.product_id != null)
          .map((h) => h.product_id)
      ),
    ];

    const [rms, pms, products] = await Promise.all([
      rmIds.length ? RawMaterial.findAll({ where: { id: rmIds } }) : [],
      pmIds.length ? PackMaterial.findAll({ where: { id: pmIds } }) : [],
      productIds.length ? Product.findAll({ where: { product_id: productIds } }) : [],
    ]);

    const rmMap = new Map(rms.map((r) => [r.id, r.get ? r.get({ plain: true }) : r]));
    const pmMap = new Map(pms.map((p) => [p.id, p.get ? p.get({ plain: true }) : p]));
    const productMap = new Map(
      products.map((p) => [p.product_id, p.get ? p.get({ plain: true }) : p])
    );

    const history = plain.map((h) => {
      let code = '';
      let name = '';
      let subtitle = '';

      if (h.item_type === 'RM' && h.raw_material_id) {
        const m = rmMap.get(h.raw_material_id);
        if (m) {
          code = m.code;
          name = m.name || m.code;
          subtitle = `${m.inci || m.name || ''} · ${m.uom || 'KG'}`;
        }
      } else if (h.item_type === 'PM' && h.pack_material_id) {
        const m = pmMap.get(h.pack_material_id);
        if (m) {
          code = m.code;
          name = m.description || m.code;
          subtitle = `${m.material || m.type || ''} · ${m.size_spec || '—'}`;
        }
      } else if (h.item_type === 'PR' && h.product_id) {
        const m = productMap.get(h.product_id);
        if (m) {
          code = m.product_code || '';
          name = m.product_name || '';
          subtitle = (m.category ? `${m.category} · ` : '') + 'PR';
        }
      }

      return {
        id: h.id,
        warehouseInventoryId: h.warehouse_inventory_id,
        itemType: h.item_type,
        rawMaterialId: h.raw_material_id,
        packMaterialId: h.pack_material_id,
        productId: h.product_id,
        fromZone: h.from_zone,
        fromRack: h.from_rack,
        toZone: h.to_zone,
        toRack: h.to_rack,
        qtyDelta: h.qty_delta,
        actionType: h.action_type,
        sourceGrnId: h.source_grn_id,
        sourceMrnId: h.source_mrn_id,
        movedAt: h.moved_at,
        reservedDelta: h.reserved_delta != null ? Number(h.reserved_delta) : null,
        reservedAfter: h.reserved_after != null ? Number(h.reserved_after) : null,
        productionBatchId: h.production_batch_id ?? null,
        batchNo: h.batch_no ?? null,
        code,
        name,
        subtitle,
        dispensingBundleId: h.dispensing_bundle_id ?? null,
        changesJson: h.changes_json ?? null,
        note: h.note ?? null,
      };
    });

    return res.json({ history });
  } catch (err) {
    // Same graceful behaviour as per-item endpoint if table is missing
    const msg = err && err.message ? String(err.message) : '';
    const code = err && err.original && err.original.code ? String(err.original.code) : '';
    if (
      code === '42P01' ||
      /warehouse_inventory_location_history/i.test(msg) ||
      /relation "warehouse_inventory_location_history" does not exist/i.test(msg)
    ) {
      console.warn(
        '[warehouse-inventory] all location-history table missing, returning empty history'
      );
      return res.json({ history: [] });
    }

    console.error('[warehouse-inventory] GET all location-history error:', err);
    res
      .status(500)
      .json({ error: err.message || 'Failed to fetch consolidated location history' });
  }
}

/**
 * GET /api/v1/warehouse-inventory/:id/rack-locations
 * Returns list of { locationId, locationCode, locationName, rackId, rackCode } where this inventory item is stored.
 */
async function getRackLocations(req, res) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid warehouse inventory id' });
    }
    const inv = await WarehouseInventory.findByPk(id);
    if (!inv) {
      return res.status(404).json({ error: 'Warehouse inventory row not found' });
    }
    const items = await WarehouseRackItem.findAll({
      where: { warehouse_inventory_id: id },
      include: [
        {
          model: WarehouseRack,
          as: 'WarehouseRack',
          required: true,
          include: [
            {
              model: WarehouseLocation,
              as: 'WarehouseLocation',
              required: true,
              attributes: ['id', 'code', 'name'],
            },
          ],
        },
      ],
    });
    const locations = items.map((it) => {
      const rack = it.WarehouseRack;
      const loc = rack && rack.WarehouseLocation ? rack.WarehouseLocation : null;
      const rPlain = rack && rack.get ? rack.get({ plain: true }) : rack;
      const locPlain = loc && loc.get ? loc.get({ plain: true }) : loc;
      const itPlain = it.get ? it.get({ plain: true }) : it;
      return {
        locationId: locPlain && locPlain.id,
        locationCode: locPlain && locPlain.code,
        locationName: locPlain && locPlain.name,
        locationType: locPlain && locPlain.location_type,
        isDefaultLocation: locPlain && locPlain.is_default === true,
        rackId: rPlain && rPlain.id,
        rackCode: rPlain && rPlain.code,
        qtyWh: toNum(itPlain.qty_wh),
      };
    });
    res.json({ locations });
  } catch (err) {
    console.error('[warehouse-inventory] GET rack-locations error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch rack locations' });
  }
}

/**
 * GET /api/v1/warehouse-inventory/:id/stock-by-location
 * Per-zone/rack WH breakdown + ML1/ML2 manufacturing buckets.
 */
async function getStockByLocation(req, res) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid warehouse inventory id' });
    }
    const payload = await buildStockByLocationPayload(id);
    if (!payload) {
      return res.status(404).json({ error: 'Warehouse inventory row not found' });
    }
    res.json(payload);
  } catch (err) {
    console.error('[warehouse-inventory] GET stock-by-location error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch stock by location' });
  }
}

/**
 * GET /api/v1/warehouse-inventory/low-threshold-alerts
 * Returns inventory rows where stock_in_hand <= reorder_pt (and reorder_pt > 0). For planning team dashboard.
 */
async function listLowThresholdAlerts(req, res) {
  try {
    const payload = await listPayload();
    const rows = (payload.rows || []).filter(
      (r) => r.reorderPt > 0 && r.stockInHand <= r.reorderPt
    );
    res.json({ rows });
  } catch (err) {
    console.error('[warehouse-inventory] listLowThresholdAlerts error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch low threshold alerts' });
  }
}

/** Call list logic and return the payload without sending response (for internal use). */
async function listPayload() {
  const pagination = arguments.length > 0 && arguments[0] ? arguments[0] : null;
  const paginationOpts = pagination && typeof pagination === 'object' ? pagination : null;

  try {
    const { syncWarehouseInTransitAll } = require('./inTransitSync');
    await syncWarehouseInTransitAll();
  } catch (e) {
    console.warn('[warehouse-inventory] syncWarehouseInTransitAll failed:', e && e.message ? e.message : e);
  }

  const whRows = await WarehouseInventory.findAll({
    order: [
      ['item_type', 'ASC'],
      ['raw_material_id', 'ASC'],
      ['pack_material_id', 'ASC'],
      ['product_id', 'ASC'],
    ],
    ...(paginationOpts && paginationOpts.limit != null ? { limit: paginationOpts.limit } : {}),
    ...(paginationOpts && paginationOpts.offset != null ? { offset: paginationOpts.offset } : {}),
  });
  const rmIds = [...new Set(whRows.map((r) => r.raw_material_id).filter(Boolean))];
  const pmIds = [...new Set(whRows.map((r) => r.pack_material_id).filter(Boolean))];
  const productIds = [...new Set(whRows.map((r) => r.product_id).filter(Boolean))];
  const [rms, pms, products, groups] = await Promise.all([
    rmIds.length ? RawMaterial.findAll({ where: { id: rmIds } }) : [],
    pmIds.length ? PackMaterial.findAll({ where: { id: pmIds } }) : [],
    productIds.length ? Product.findAll({ where: { product_id: productIds } }) : [],
    ItemGroup.findAll(),
  ]);
  const rmMap = new Map(rms.map((r) => [r.id, r.get ? r.get({ plain: true }) : r]));
  const pmMap = new Map(pms.map((p) => [p.id, p.get ? p.get({ plain: true }) : p]));
  const productMap = new Map(products.map((p) => [p.product_id, p.get ? p.get({ plain: true }) : p]));
  const rmGroupMap = buildMemberToGroupsMap(groups.filter((g) => g.type === 'RM'));
  const pmGroupMap = buildMemberToGroupsMap(groups.filter((g) => g.type === 'PM'));
  const [inTransitByItem, poQtyByItem, underGrnByItem, grnReceivedKgByItem] = await Promise.all([
    getInTransitBreakdown(),
    getPoQuantityByItem(),
    getUnderGrnQuantityByItem(),
    getCompletedGrnReceivedKgByKey(),
  ]);
  const rows = [];
  for (const w of whRows) {
    const wh = w.get ? w.get({ plain: true }) : w;
    const whStock = toNum(wh.wh_stock);
    const ml1Stock = toNum(wh.ml1_stock);
    const ml2Stock = toNum(wh.ml2_stock);
    const stockInHand = whStock + ml1Stock + ml2Stock;
    const reorderPt = toNum(wh.reorder_pt);
    let status = (wh.qc_status || 'In Stock').trim();
    if (status === 'In Stock' && reorderPt > 0) {
      if (stockInHand < reorderPt * 0.5) status = 'Critical';
      else if (stockInHand < reorderPt) status = 'Low Stock';
    }
    const qcStatusRaw = (wh.qc_status || 'In Stock').trim();
    if (wh.item_type === 'RM' && wh.raw_material_id) {
      const m = rmMap.get(wh.raw_material_id);
      if (!m) continue;
      const groupList = rmGroupMap.get(wh.raw_material_id) || [];
      const itemKey = `rm-${wh.raw_material_id}`;
      const grnLogisticsBreakdown = inTransitByItem.get(itemKey) || [];
      const underGrnQty = toNum(underGrnByItem.get(itemKey) || 0);
      const { inTransitQty, inTransitBreakdown } = inTransitQtyForListRow(
        wh,
        grnLogisticsBreakdown,
        underGrnQty
      );
      const poQtyRaw = toNum(poQtyByItem.get(itemKey) || 0);
      const grnReceivedKg = toNum(grnReceivedKgByItem.get(itemKey) || 0);
      rows.push({
        id: itemKey,
        warehouseInventoryId: wh.id,
        code: m.code,
        name: m.name || m.code,
        subtitle: `${m.inci || m.name || ''} · ${m.uom || 'KG'}`,
        type: 'RM',
        sourceId: wh.raw_material_id,
        itemGroupNames: groupList.map((g) => g.name || g.code),
        itemGroupCodes: groupList.map((g) => g.code),
        zone: wh.zone || '—',
        rack: wh.rack || '—',
        whStock,
        whUnit: wh.wh_unit || 'KG',
        ml1Stock,
        ml2Stock,
        stockInHand,
        reserved: toNum(wh.reserved),
        // Synced pipeline (GRN + procurement PO) minus Under GRN (own column); breakdown adds PO-only slice.
        inTransit: inTransitQty,
        underGrn: underGrnQty,
        inTransitBreakdown,
        // Open PO exposure: gross PO lines minus GRN Complete received, Under GRN, and in-transit pipeline.
        poQuantity: Math.max(0, poQtyRaw - grnReceivedKg - underGrnQty - inTransitQty),
        reorderPt,
        avgMo: toNum(wh.avg_mo),
        status,
        qcStatus: qcStatusRaw,
        batchNumber: wh.batch_number || null,
        expiryDate: wh.expiry_date || null,
      });
    } else if (wh.item_type === 'PM' && wh.pack_material_id) {
      const m = pmMap.get(wh.pack_material_id);
      if (!m) continue;
      const groupList = pmGroupMap.get(wh.pack_material_id) || [];
      const itemKey = `pm-${wh.pack_material_id}`;
      const grnLogisticsBreakdown = inTransitByItem.get(itemKey) || [];
      const underGrnQty = toNum(underGrnByItem.get(itemKey) || 0);
      const { inTransitQty, inTransitBreakdown } = inTransitQtyForListRow(
        wh,
        grnLogisticsBreakdown,
        underGrnQty
      );
      const poQtyRaw = toNum(poQtyByItem.get(itemKey) || 0);
      const grnReceivedKg = toNum(grnReceivedKgByItem.get(itemKey) || 0);
      rows.push({
        id: itemKey,
        warehouseInventoryId: wh.id,
        code: m.code,
        name: m.description || m.code,
        subtitle: `${m.material || m.type || ''} · ${m.size_spec || '—'}`,
        type: 'PM',
        sourceId: wh.pack_material_id,
        itemGroupNames: groupList.map((g) => g.name || g.code),
        itemGroupCodes: groupList.map((g) => g.code),
        zone: wh.zone || '—',
        rack: wh.rack || '—',
        whStock,
        whUnit: wh.wh_unit || 'KG',
        ml1Stock,
        ml2Stock,
        stockInHand,
        reserved: toNum(wh.reserved),
        // Synced pipeline (GRN + procurement PO) minus Under GRN (own column); breakdown adds PO-only slice.
        inTransit: inTransitQty,
        underGrn: underGrnQty,
        inTransitBreakdown,
        poQuantity: Math.max(0, poQtyRaw - grnReceivedKg - underGrnQty - inTransitQty),
        reorderPt,
        avgMo: toNum(wh.avg_mo),
        status,
        qcStatus: qcStatusRaw,
        batchNumber: wh.batch_number || null,
        expiryDate: wh.expiry_date || null,
      });
    } else if (wh.item_type === 'PR' && wh.product_id) {
      const m = productMap.get(wh.product_id);
      if (!m) continue;
      rows.push({
        id: `pr-${wh.product_id}`,
        warehouseInventoryId: wh.id,
        code: m.product_code || '',
        name: m.product_name || '',
        subtitle: (m.category ? `${m.category} · ` : '') + 'PR',
        type: 'FG/PR',
        sourceId: wh.product_id,
        itemGroupNames: [],
        itemGroupCodes: [],
        zone: wh.zone || '—',
        rack: wh.rack || '—',
        whStock,
        whUnit: wh.wh_unit || 'KG',
        ml1Stock,
        ml2Stock,
        stockInHand,
        reserved: toNum(wh.reserved),
        inTransit: toNum(wh.in_transit),
        underGrn: 0,
        inTransitBreakdown: [],
        poQuantity: 0,
        reorderPt,
        avgMo: toNum(wh.avg_mo),
        status,
        qcStatus: qcStatusRaw,
        batchNumber: wh.batch_number || null,
        expiryDate: wh.expiry_date || null,
      });
    }
  }
  const itemGroups = groups.map((g) => {
    const d = g.get ? g.get({ plain: true }) : g;
    return { id: String(d.id), code: d.code, name: d.name, type: d.type, member_ids: Array.isArray(d.member_ids) ? d.member_ids : [] };
  });
  return { rows, itemGroups };
}

/**
 * GET /api/v1/warehouse-inventory/usage-stats
 * Returns usage (consumption) per item: avg per day, week, month, quarter, year, and all-time total.
 * Derived from warehouse_inventory_location_history where qty_delta < 0 (outbound/consumption).
 */
async function listUsageStats(req, res) {
  try {
    const rows = await WarehouseInventoryLocationHistory.findAll({
      where: { qty_delta: { [Op.lt]: 0 } },
      attributes: ['item_type', 'raw_material_id', 'pack_material_id', 'product_id', 'qty_delta', 'moved_at'],
      order: [['moved_at', 'ASC']],
    });
    const key = (r) => {
      const h = r.get ? r.get({ plain: true }) : r;
      return `${h.item_type}|${h.raw_material_id ?? ''}|${h.pack_material_id ?? ''}|${h.product_id ?? ''}`;
    };
    const byItem = new Map();
    for (const r of rows) {
      const h = r.get ? r.get({ plain: true }) : r;
      const k = key(r);
      const qty = -toNum(h.qty_delta);
      const at = h.moved_at ? new Date(h.moved_at).getTime() : null;
      if (!byItem.has(k)) byItem.set(k, { itemType: h.item_type, rawMaterialId: h.raw_material_id, packMaterialId: h.pack_material_id, productId: h.product_id, total: 0, firstAt: at, lastAt: at });
      const rec = byItem.get(k);
      rec.total += qty;
      if (at != null) {
        if (rec.firstAt == null || at < rec.firstAt) rec.firstAt = at;
        if (rec.lastAt == null || at > rec.lastAt) rec.lastAt = at;
      }
    }
    const rmIds = [...new Set([...byItem.values()].filter((x) => x.rawMaterialId).map((x) => x.rawMaterialId))];
    const pmIds = [...new Set([...byItem.values()].filter((x) => x.packMaterialId).map((x) => x.packMaterialId))];
    const productIds = [...new Set([...byItem.values()].filter((x) => x.productId).map((x) => x.productId))];
    const [rms, pms, products] = await Promise.all([
      rmIds.length ? RawMaterial.findAll({ where: { id: rmIds }, attributes: ['id', 'code', 'name'] }) : [],
      pmIds.length ? PackMaterial.findAll({ where: { id: pmIds }, attributes: ['id', 'code', 'description'] }) : [],
      productIds.length ? Product.findAll({ where: { product_id: productIds }, attributes: ['product_id', 'product_code', 'product_name'] }) : [],
    ]);
    const rmMap = new Map(rms.map((r) => { const d = r.get ? r.get({ plain: true }) : r; return [d.id, d]; }));
    const pmMap = new Map(pms.map((p) => { const d = p.get ? p.get({ plain: true }) : p; return [d.id, d]; }));
    const productMap = new Map(products.map((p) => { const d = p.get ? p.get({ plain: true }) : p; return [d.product_id, d]; }));
    const now = Date.now();
    const msPerDay = 24 * 60 * 60 * 1000;
    const out = [];
    for (const [k, rec] of byItem) {
      const total = rec.total;
      const firstAt = rec.firstAt != null ? rec.firstAt : now;
      const lastAt = rec.lastAt != null ? rec.lastAt : now;
      const spanMs = Math.max(lastAt - firstAt, 0);
      const days = Math.max(spanMs / msPerDay, 1);
      const weeks = Math.max(days / 7, 1 / 7);
      const months = Math.max(days / 30, 1 / 30);
      const quarters = Math.max(days / 90, 1 / 90);
      const years = Math.max(days / 365, 1 / 365);
      let id = '';
      let code = '';
      let name = '';
      if (rec.itemType === 'RM' && rec.rawMaterialId != null) {
        const m = rmMap.get(rec.rawMaterialId);
        id = `rm-${rec.rawMaterialId}`;
        code = m ? m.code : '';
        name = m ? (m.name || m.code) : '';
      } else if (rec.itemType === 'PM' && rec.packMaterialId != null) {
        const m = pmMap.get(rec.packMaterialId);
        id = `pm-${rec.packMaterialId}`;
        code = m ? m.code : '';
        name = m ? (m.description || m.code) : '';
      } else if (rec.itemType === 'PR' && rec.productId != null) {
        const m = productMap.get(rec.productId);
        id = `pr-${rec.productId}`;
        code = m ? m.product_code : '';
        name = m ? m.product_name : '';
      } else {
        id = k;
      }
      out.push({
        id,
        code,
        name,
        type: rec.itemType || 'RM',
        avgDay: Math.round((total / days) * 10000) / 10000,
        avgWeek: Math.round((total / weeks) * 10000) / 10000,
        avgMonth: Math.round((total / months) * 10000) / 10000,
        avgQuarter: Math.round((total / quarters) * 10000) / 10000,
        avgYear: Math.round((total / years) * 10000) / 10000,
        totalAllTime: Math.round(total * 10000) / 10000,
      });
    }
    out.sort((a, b) => (a.code || a.id).localeCompare(b.code || b.id));
    res.json({ rows: out });
  } catch (err) {
    const msg = err && err.message ? String(err.message) : '';
    const code = err && err.original && err.original.code ? String(err.original.code) : '';
    if (code === '42P01' || /warehouse_inventory_location_history/i.test(msg)) {
      return res.json({ rows: [] });
    }
    console.error('[warehouse-inventory] listUsageStats error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch usage stats' });
  }
}

module.exports = {
  list,
  listPayload,
  updateStock,
  listLocationHistory,
  listAllLocationHistory,
  getRackLocations,
  getStockByLocation,
  listLowThresholdAlerts,
  listUsageStats,
};

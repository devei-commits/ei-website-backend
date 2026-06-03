/**
 * Keeps warehouse_inventory.in_transit aligned with inbound pipeline only (not planning reserves):
 *   GRN inbound (in-flight) + PO pipeline (Released/In Transit/shipped before GRN / delivery-pending linked).
 * Planning "Planned QTY" (reserved_batch_items for BOM-confirmed PIs) is kept separate in items-involved —
 * merging it here double-counted vs the Planned column and hid true shortages.
 *
 * RM/PM masters stay in raw_materials / pack_materials; quantities are keyed by those FKs on warehouse_inventory.
 */
const { Op, fn, col } = require('sequelize');
const WarehouseInventory = require('./models');
const GoodsReceivedNote = require('../grn/models');
const PurchaseOrder = require('../purchaseOrders/models');
const PoTracking = require('../poTracking/models');
const ProcurementRequest = require('../procurementRequests/models');
const { ReservedBatchItem } = require('../fulfillment/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { quantityToKg } = require('./quantityToKg');

const GRN_IN_TRANSIT_STATUSES = ['In Transit', 'Under GRN', 'Pending', 'Delayed', 'On Hold'];

function toNum(x) {
  if (x == null || x === '') return 0;
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

/** Stable numeric PO id for Map/Set lookups (avoids string "12" vs number 12 missing tracking rows). */
function normPurchaseOrderId(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function poStatusNormPipeline(stRaw) {
  return String(stRaw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** DB / FE may store issued PO as `Released` or `PO Released`. */
function isPoReleasedForPipeline(stRaw) {
  const s = poStatusNormPipeline(stRaw);
  return s === 'released' || s === 'po released';
}

function isPoInTransitForPipeline(stRaw) {
  return poStatusNormPipeline(stRaw) === 'in transit';
}

async function loadRmPmMeta(rmIds, pmIds) {
  const rmMeta = new Map();
  const pmMeta = new Map();
  try {
    if (rmIds.size) {
      const rows = await RawMaterial.findAll({
        where: { id: [...rmIds] },
        attributes: ['id', 'uom', 'specific_gravity'],
      });
      for (const r of rows) {
        const x = r.get ? r.get({ plain: true }) : r;
        rmMeta.set(Number(x.id), {
          uom: x.uom || '',
          specific_gravity: x.specific_gravity != null ? Number(x.specific_gravity) : null,
        });
      }
    }
    if (pmIds.size) {
      const rows = await PackMaterial.findAll({
        where: { id: [...pmIds] },
        attributes: ['id', 'unit', 'size_spec'],
      });
      for (const r of rows) {
        const x = r.get ? r.get({ plain: true }) : r;
        pmMeta.set(Number(x.id), { unit: x.unit || '', size_spec: x.size_spec || '' });
      }
    }
  } catch (err) {
    console.warn('[inTransitSync] loadRmPmMeta:', err.message);
  }
  return { rmMeta, pmMeta };
}

/** Sum in-transit **kg** per rm-{id} / pm-{id} from open inbound GRNs. */
async function getGrnInTransitQtyByKey() {
  const map = new Map();
  try {
    const grns = await GoodsReceivedNote.findAll({
      where: { status: { [Op.in]: GRN_IN_TRANSIT_STATUSES } },
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
        const kg = quantityToKg(qty, unit, {
          itemType,
          masterUom: itemType === 'RM' ? meta?.uom : meta?.unit,
          sizeSpec: itemType === 'PM' ? meta?.size_spec : null,
          specificGravity: itemType === 'RM' ? meta?.specific_gravity : undefined,
        });
        map.set(key, (map.get(key) || 0) + kg);
      }
    }
  } catch (err) {
    console.warn('[inTransitSync] getGrnInTransitQtyByKey:', err.message);
  }
  return map;
}

async function getPurchaseOrderIdsWithInboundGrn() {
  const ids = new Set();
  try {
    const grns = await GoodsReceivedNote.findAll({
      where: { status: { [Op.in]: GRN_IN_TRANSIT_STATUSES } },
      attributes: ['purchase_order_id'],
    });
    for (const g of grns) {
      const d = g.get ? g.get({ plain: true }) : g;
      if (d.purchase_order_id != null) ids.add(Number(d.purchase_order_id));
    }
  } catch (err) {
    console.warn('[inTransitSync] getPurchaseOrderIdsWithInboundGrn:', err.message);
  }
  return ids;
}

/** Match GRN Complete inventory logic: use rcvd qty, else poQty when rcvd unset/zero. */
function lineReceivedQtyFromGrnLine(line) {
  const rawRcvd = Number(line.rcvdQty ?? line.rcvd_qty);
  let rcvd = Math.max(0, Number.isFinite(rawRcvd) ? rawRcvd || 0 : 0);
  if (rcvd === 0) {
    const poFb = Math.max(0, toNum(line.poQty ?? line.po_qty));
    if (poFb > 0) rcvd = poFb;
  }
  return rcvd;
}

/**
 * Per PO id: sum received quantities on GRN Complete rows, keyed rm-{id}/pm-{id}.
 * Used so PO pipeline in_transit does not re-add stock already received (sync overwrites row in_transit after GRN Complete).
 */
async function getCompletedGrnReceivedByPurchaseOrderId() {
  /** @type {Map<number, Map<string, number>>} */
  const byPo = new Map();
  try {
    const grns = await GoodsReceivedNote.findAll({
      where: {
        status: 'GRN Complete',
        purchase_order_id: { [Op.ne]: null },
      },
      attributes: ['purchase_order_id', 'line_items'],
    });
    for (const g of grns) {
      const d = g.get ? g.get({ plain: true }) : g;
      const poId = Number(d.purchase_order_id);
      if (!Number.isFinite(poId) || poId <= 0) continue;
      const lines = Array.isArray(d.line_items) ? d.line_items : [];
      let inner = byPo.get(poId);
      if (!inner) {
        inner = new Map();
        byPo.set(poId, inner);
      }
      for (const line of lines) {
        const qNative = lineReceivedQtyFromGrnLine(line);
        if (qNative <= 0) continue;
        let key = null;
        if (line.raw_material_id != null) key = `rm-${line.raw_material_id}`;
        else if (line.pack_material_id != null) key = `pm-${line.pack_material_id}`;
        if (!key) continue;
        inner.set(key, (inner.get(key) || 0) + qNative);
      }
    }
  } catch (err) {
    console.warn('[inTransitSync] getCompletedGrnReceivedByPurchaseOrderId:', err.message);
  }
  return byPo;
}

/**
 * Add PO line quantities to map (kg), minus completed GRN received amounts for this PO (native qty converted with same unit).
 */
function addPoItemsToMapNetOfCompletedGrns(map, items, receivedByKeyForPo, rmMeta, pmMeta) {
  const lines = Array.isArray(items) ? items : [];
  /** @type {Map<string, { sum: number; unit: string }>} */
  const poTotalsByKey = new Map();
  for (const line of lines) {
    const qty = toNum(line.quantity ?? line.qty ?? line.poQty);
    if (qty <= 0) continue;
    let key = null;
    if (line.raw_material_id != null) key = `rm-${line.raw_material_id}`;
    else if (line.pack_material_id != null) key = `pm-${line.pack_material_id}`;
    if (!key) continue;
    const unit = String(line.unit ?? line.UOM ?? '').trim();
    const prev = poTotalsByKey.get(key) || { sum: 0, unit: '' };
    poTotalsByKey.set(key, { sum: prev.sum + qty, unit: unit || prev.unit });
  }
  const rec = receivedByKeyForPo || new Map();
  for (const [key, { sum, unit }] of poTotalsByKey) {
    const recNative = toNum(rec.get(key));
    const itemType = key.startsWith('rm-') ? 'RM' : 'PM';
    const id = parseInt(key.slice(3), 10);
    const meta = itemType === 'RM' ? rmMeta.get(id) : pmMeta.get(id);
    const ctx = {
      itemType,
      masterUom: itemType === 'RM' ? meta?.uom : meta?.unit,
      sizeSpec: itemType === 'PM' ? meta?.size_spec : null,
      specificGravity: itemType === 'RM' ? meta?.specific_gravity : undefined,
    };
    const poKg = quantityToKg(sum, unit, ctx);
    const recKg = quantityToKg(recNative, unit, ctx);
    const net = Math.max(0, poKg - recKg);
    if (net <= 0) continue;
    map.set(key, (map.get(key) || 0) + net);
  }
}

/**
 * PO-side pipeline: not double-counted when an inbound GRN already exists for that PO.
 * Includes: PO status In Transit; Released + PoTracking shipped (before GRN complete on tracking);
 * Released + linked procurement request in Delivery Pending (Issued PO "Mark In Transit" path).
 */
async function getPoPipelineInTransitQtyByKey() {
  const map = new Map();
  try {
    const skipPoIds = await getPurchaseOrderIdsWithInboundGrn();
    const completedRcvdByPo = await getCompletedGrnReceivedByPurchaseOrderId();
    const [pos, trackingRows, pendingPrs] = await Promise.all([
      PurchaseOrder.findAll({ attributes: ['id', 'status', 'items', 'form_data'] }),
      PoTracking.findAll({
        attributes: ['purchase_order_id', 'shipped_at', 'grn_complete_at'],
      }),
      ProcurementRequest.findAll({
        where: { status: 'Delivery Pending' },
        attributes: ['id'],
      }),
    ]);
    const trackingByPo = new Map();
    for (const t of trackingRows) {
      const d = t.get ? t.get({ plain: true }) : t;
      const pid = normPurchaseOrderId(d.purchase_order_id);
      if (pid) trackingByPo.set(pid, d);
    }
    const deliveryPendingIds = new Set(
      pendingPrs.map((pr) => {
        const d = pr.get ? pr.get({ plain: true }) : pr;
        return String(d.id);
      })
    );

    const rmIds = new Set();
    const pmIds = new Set();
    for (const po of pos) {
      const d = po.get ? po.get({ plain: true }) : po;
      const poId = normPurchaseOrderId(d.id);
      if (!poId || skipPoIds.has(poId)) continue;
      const st = String(d.status || '').trim();
      const tr = trackingByPo.get(poId);
      const fd = d.form_data && typeof d.form_data === 'object' && !Array.isArray(d.form_data) ? d.form_data : {};
      const reqId = fd.requestId != null ? String(fd.requestId) : '';
      const linkedDeliveryPending = reqId && deliveryPendingIds.has(reqId);
      const releasedShipped = isPoReleasedForPipeline(st) && tr && tr.shipped_at && !tr.grn_complete_at;
      if (!(isPoInTransitForPipeline(st) || releasedShipped || linkedDeliveryPending)) continue;
      const items = Array.isArray(d.items) ? d.items : [];
      for (const line of items) {
        if (line.raw_material_id != null) rmIds.add(Number(line.raw_material_id));
        if (line.pack_material_id != null) pmIds.add(Number(line.pack_material_id));
      }
    }
    const { rmMeta, pmMeta } = await loadRmPmMeta(rmIds, pmIds);

    for (const po of pos) {
      const d = po.get ? po.get({ plain: true }) : po;
      const poId = normPurchaseOrderId(d.id);
      if (!poId || skipPoIds.has(poId)) continue;
      const st = String(d.status || '').trim();
      const tr = trackingByPo.get(poId);
      const fd = d.form_data && typeof d.form_data === 'object' && !Array.isArray(d.form_data) ? d.form_data : {};
      const reqId = fd.requestId != null ? String(fd.requestId) : '';
      const linkedDeliveryPending = reqId && deliveryPendingIds.has(reqId);

      const releasedShipped =
        isPoReleasedForPipeline(st) && tr && tr.shipped_at && !tr.grn_complete_at;

      if (isPoInTransitForPipeline(st) || releasedShipped || linkedDeliveryPending) {
        const receivedForPo = completedRcvdByPo.get(poId) || new Map();
        addPoItemsToMapNetOfCompletedGrns(map, d.items, receivedForPo, rmMeta, pmMeta);
      }
    }
  } catch (err) {
    console.warn('[inTransitSync] getPoPipelineInTransitQtyByKey:', err.message);
  }
  return map;
}

/**
 * Sum in-transit **native qty** (line.poQty/quantity/qty, no KG conversion) per rm-{id}/pm-{id}
 * from open inbound GRNs. Used by items-involved flow math to subtract in native units from
 * raw PO line quantities so stages (planned → PO → in-transit → WH) stay in the same unit.
 */
async function getGrnInTransitQtyNativeByKey() {
  const map = new Map();
  try {
    const grns = await GoodsReceivedNote.findAll({
      where: { status: { [Op.in]: GRN_IN_TRANSIT_STATUSES } },
      attributes: ['line_items'],
    });
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
        map.set(key, (map.get(key) || 0) + qty);
      }
    }
  } catch (err) {
    console.warn('[inTransitSync] getGrnInTransitQtyNativeByKey:', err.message);
  }
  return map;
}

/**
 * PO-side pipeline in-transit in **native units** (no KG conversion), net of received qty on
 * completed GRNs for that PO. Mirrors `getPoPipelineInTransitQtyByKey` eligibility rules:
 *   PO status In Transit; Released + PoTracking shipped (pre-GRN complete); Released + linked PR Delivery Pending.
 */
async function getPoPipelineInTransitQtyNativeByKey() {
  const map = new Map();
  try {
    const skipPoIds = await getPurchaseOrderIdsWithInboundGrn();
    const completedRcvdByPo = await getCompletedGrnReceivedByPurchaseOrderId();
    const [pos, trackingRows, pendingPrs] = await Promise.all([
      PurchaseOrder.findAll({ attributes: ['id', 'status', 'items', 'form_data'] }),
      PoTracking.findAll({ attributes: ['purchase_order_id', 'shipped_at', 'grn_complete_at'] }),
      ProcurementRequest.findAll({ where: { status: 'Delivery Pending' }, attributes: ['id'] }),
    ]);
    const trackingByPo = new Map();
    for (const t of trackingRows) {
      const d = t.get ? t.get({ plain: true }) : t;
      const pid = normPurchaseOrderId(d.purchase_order_id);
      if (pid) trackingByPo.set(pid, d);
    }
    const deliveryPendingIds = new Set(
      pendingPrs.map((pr) => {
        const d = pr.get ? pr.get({ plain: true }) : pr;
        return String(d.id);
      })
    );

    for (const po of pos) {
      const d = po.get ? po.get({ plain: true }) : po;
      const poId = normPurchaseOrderId(d.id);
      if (!poId || skipPoIds.has(poId)) continue;
      const st = String(d.status || '').trim();
      const tr = trackingByPo.get(poId);
      const fd = d.form_data && typeof d.form_data === 'object' && !Array.isArray(d.form_data) ? d.form_data : {};
      const reqId = fd.requestId != null ? String(fd.requestId) : '';
      const linkedDeliveryPending = reqId && deliveryPendingIds.has(reqId);
      const releasedShipped = isPoReleasedForPipeline(st) && tr && tr.shipped_at && !tr.grn_complete_at;
      if (!(isPoInTransitForPipeline(st) || releasedShipped || linkedDeliveryPending)) continue;

      const lines = Array.isArray(d.items) ? d.items : [];
      const poTotalsByKey = new Map();
      for (const line of lines) {
        const qty = toNum(line.quantity ?? line.qty ?? line.poQty);
        if (qty <= 0) continue;
        let key = null;
        if (line.raw_material_id != null) key = `rm-${line.raw_material_id}`;
        else if (line.pack_material_id != null) key = `pm-${line.pack_material_id}`;
        if (!key) continue;
        poTotalsByKey.set(key, (poTotalsByKey.get(key) || 0) + qty);
      }
      const rec = completedRcvdByPo.get(poId) || new Map();
      for (const [key, sum] of poTotalsByKey) {
        const recNative = toNum(rec.get(key));
        const net = Math.max(0, sum - recNative);
        if (net <= 0) continue;
        map.set(key, (map.get(key) || 0) + net);
      }
    }
  } catch (err) {
    console.warn('[inTransitSync] getPoPipelineInTransitQtyNativeByKey:', err.message);
  }
  return map;
}

/**
 * Sum received qty from **completed** GRNs in native units, keyed rm-{id}/pm-{id}.
 * Uses the same rcvdQty ?? poQty fallback as `lineReceivedQtyFromGrnLine`.
 */
async function getCompletedGrnReceivedNativeByKey() {
  const map = new Map();
  try {
    const grns = await GoodsReceivedNote.findAll({
      where: { status: 'GRN Complete' },
      attributes: ['line_items'],
    });
    for (const g of grns) {
      const d = g.get ? g.get({ plain: true }) : g;
      const lines = Array.isArray(d.line_items) ? d.line_items : [];
      for (const line of lines) {
        const qty = lineReceivedQtyFromGrnLine(line);
        if (qty <= 0) continue;
        let key = null;
        if (line.raw_material_id != null) key = `rm-${line.raw_material_id}`;
        else if (line.pack_material_id != null) key = `pm-${line.pack_material_id}`;
        if (!key) continue;
        map.set(key, (map.get(key) || 0) + qty);
      }
    }
  } catch (err) {
    console.warn('[inTransitSync] getCompletedGrnReceivedNativeByKey:', err.message);
  }
  return map;
}

/**
 * Sum received **kg** from GRN Complete per rm-{id}/pm-{id} (same UOM→kg rules as PO pipeline / getPoQuantityByItem).
 * Used so warehouse "PO QTY" can net to 0 after material is booked from completed GRNs.
 */
async function getCompletedGrnReceivedKgByKey() {
  const map = new Map();
  try {
    const grns = await GoodsReceivedNote.findAll({
      where: { status: 'GRN Complete' },
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
        const qtyNative = lineReceivedQtyFromGrnLine(line);
        if (qtyNative <= 0) continue;
        let key = null;
        if (line.raw_material_id != null) key = `rm-${line.raw_material_id}`;
        else if (line.pack_material_id != null) key = `pm-${line.pack_material_id}`;
        if (!key) continue;
        const unit = String(line.unit ?? line.UOM ?? '').trim();
        const itemType = key.startsWith('rm-') ? 'RM' : 'PM';
        const id = itemType === 'RM' ? Number(line.raw_material_id) : Number(line.pack_material_id);
        const meta = itemType === 'RM' ? rmMeta.get(id) : pmMeta.get(id);
        const kg = quantityToKg(qtyNative, unit, {
          itemType,
          masterUom: itemType === 'RM' ? meta?.uom : meta?.unit,
          sizeSpec: itemType === 'PM' ? meta?.size_spec : null,
          specificGravity: itemType === 'RM' ? meta?.specific_gravity : undefined,
        });
        map.set(key, (map.get(key) || 0) + kg);
      }
    }
  } catch (err) {
    console.warn('[inTransitSync] getCompletedGrnReceivedKgByKey:', err.message);
  }
  return map;
}

async function getPlannedPlanningQtyByItem() {
  const rmMap = new Map();
  const pmMap = new Map();
  try {
    const rmSums = await ReservedBatchItem.findAll({
      attributes: ['raw_material_id', [fn('SUM', col('quantity_reserved')), 'total']],
      where: {
        planning_extracted_id: { [Op.ne]: null },
        raw_material_id: { [Op.ne]: null },
      },
      group: ['raw_material_id'],
      raw: true,
    });
    for (const row of rmSums) {
      const id = row.raw_material_id;
      if (id != null) rmMap.set(Number(id), toNum(row.total));
    }
    const pmSums = await ReservedBatchItem.findAll({
      attributes: ['pack_material_id', [fn('SUM', col('quantity_reserved')), 'total']],
      where: {
        planning_extracted_id: { [Op.ne]: null },
        pack_material_id: { [Op.ne]: null },
      },
      group: ['pack_material_id'],
      raw: true,
    });
    for (const row of pmSums) {
      const id = row.pack_material_id;
      if (id != null) pmMap.set(Number(id), toNum(row.total));
    }
  } catch (err) {
    console.warn('[inTransitSync] getPlannedPlanningQtyByItem:', err.message);
  }
  return { rmMap, pmMap };
}

function mergeKeyMapsIntoRmPm(grnMap, poMap) {
  const rmTotals = new Map();
  const pmTotals = new Map();
  const addKeyMap = (m) => {
    for (const [key, qty] of m) {
      const q = toNum(qty);
      if (q <= 0) continue;
      if (key.startsWith('rm-')) {
        const id = parseInt(key.slice(3), 10);
        if (!Number.isNaN(id)) rmTotals.set(id, (rmTotals.get(id) || 0) + q);
      } else if (key.startsWith('pm-')) {
        const id = parseInt(key.slice(3), 10);
        if (!Number.isNaN(id)) pmTotals.set(id, (pmTotals.get(id) || 0) + q);
      }
    }
  };
  addKeyMap(grnMap);
  addKeyMap(poMap);
  return { rmTotals, pmTotals };
}

/**
 * Create missing warehouse_inventory rows so procurement / GRN pipeline in-transit (kg)
 * can be persisted. Previously only existing rows were updated, so "Mark in transit" synced
 * nothing for materials that had never had a WH row (e.g. legacy masters).
 */
async function ensureWarehouseInventoryRowsForPipelineTotals(rmTotals, pmTotals) {
  const existingRm = new Set();
  const existingPm = new Set();
  try {
    const rows = await WarehouseInventory.findAll({
      where: { item_type: { [Op.in]: ['RM', 'PM'] } },
      attributes: ['item_type', 'raw_material_id', 'pack_material_id'],
    });
    for (const w of rows) {
      const d = w.get ? w.get({ plain: true }) : w;
      if (d.item_type === 'RM' && d.raw_material_id != null) existingRm.add(Number(d.raw_material_id));
      if (d.item_type === 'PM' && d.pack_material_id != null) existingPm.add(Number(d.pack_material_id));
    }
  } catch (err) {
    console.warn('[inTransitSync] ensureWarehouseInventoryRowsForPipelineTotals list:', err.message);
    return;
  }

  const pipelineWhDefaults = {
    wh_stock: 0,
    wh_unit: 'KG',
    ml1_stock: 0,
    ml2_stock: 0,
    stock_in_hand: 0,
    reserved: 0,
    in_transit: 0,
    reorder_pt: 0,
    avg_mo: 0,
    qc_status: 'Out of Stock',
  };

  for (const [rmId, qty] of rmTotals) {
    if (toNum(qty) <= 0) continue;
    const id = Number(rmId);
    if (!Number.isFinite(id) || id <= 0 || existingRm.has(id)) continue;
    try {
      await WarehouseInventory.findOrCreate({
        where: { item_type: 'RM', raw_material_id: id },
        defaults: {
          item_type: 'RM',
          raw_material_id: id,
          ...pipelineWhDefaults,
        },
      });
      existingRm.add(id);
    } catch (err) {
      console.warn('[inTransitSync] ensureWarehouseInventoryRowsForPipelineTotals RM', id, err.message);
    }
  }
  for (const [pmId, qty] of pmTotals) {
    if (toNum(qty) <= 0) continue;
    const id = Number(pmId);
    if (!Number.isFinite(id) || id <= 0 || existingPm.has(id)) continue;
    try {
      await WarehouseInventory.findOrCreate({
        where: { item_type: 'PM', pack_material_id: id },
        defaults: {
          item_type: 'PM',
          pack_material_id: id,
          ...pipelineWhDefaults,
        },
      });
      existingPm.add(id);
    } catch (err) {
      console.warn('[inTransitSync] ensureWarehouseInventoryRowsForPipelineTotals PM', id, err.message);
    }
  }
}

/**
 * Recompute and persist warehouse_inventory.in_transit for all RM/PM rows.
 */
async function syncWarehouseInTransitAll() {
  const [grnMap, poMap] = await Promise.all([
    getGrnInTransitQtyByKey(),
    getPoPipelineInTransitQtyByKey(),
  ]);
  const { rmTotals, pmTotals } = mergeKeyMapsIntoRmPm(grnMap, poMap);
  await ensureWarehouseInventoryRowsForPipelineTotals(rmTotals, pmTotals);

  const whRows = await WarehouseInventory.findAll({
    where: { item_type: { [Op.in]: ['RM', 'PM'] } },
    attributes: ['id', 'item_type', 'raw_material_id', 'pack_material_id', 'in_transit', 'wh_unit'],
  });

  const rmIds = [
    ...new Set(
      whRows
        .map((w) => {
          const d = w.get ? w.get({ plain: true }) : w;
          return d.item_type === 'RM' && d.raw_material_id != null ? Number(d.raw_material_id) : null;
        })
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ];
  const { normRmPrimaryUom, parseSpecificGravity, kgToRmPrimaryQty } = require('../lib/rmUnitConversion');
  const { RawMaterial } = require('../rawMaterials/models');
  const rmMeta = new Map();
  if (rmIds.length) {
    const rows = await RawMaterial.findAll({
      where: { id: rmIds },
      attributes: ['id', 'uom', 'specific_gravity'],
    });
    for (const r of rows) {
      const plain = r.get ? r.get({ plain: true }) : r;
      rmMeta.set(Number(plain.id), plain);
    }
  }

  for (const w of whRows) {
    const d = w.get ? w.get({ plain: true }) : w;
    let nextKg = 0;
    if (d.item_type === 'RM' && d.raw_material_id != null) {
      nextKg = rmTotals.get(Number(d.raw_material_id)) || 0;
    } else if (d.item_type === 'PM' && d.pack_material_id != null) {
      nextKg = pmTotals.get(Number(d.pack_material_id)) || 0;
    }
    let next = nextKg;
    if (d.item_type === 'RM' && d.raw_material_id != null) {
      const meta = rmMeta.get(Number(d.raw_material_id));
      const displayUnit = normRmPrimaryUom(d.wh_unit || meta?.uom);
      const sg = parseSpecificGravity(meta?.specific_gravity);
      next = kgToRmPrimaryQty(nextKg, displayUnit, sg);
    }
    const prev = toNum(d.in_transit);
    const updates = {};
    if (Math.abs(prev - next) > 1e-9) updates.in_transit = next;
    if (Object.keys(updates).length) {
      await WarehouseInventory.update(updates, { where: { id: d.id } });
    }
  }

  return { rmTotals, pmTotals };
}

module.exports = {
  syncWarehouseInTransitAll,
  getGrnInTransitQtyByKey,
  getPoPipelineInTransitQtyByKey,
  getCompletedGrnReceivedByPurchaseOrderId,
  getGrnInTransitQtyNativeByKey,
  getPoPipelineInTransitQtyNativeByKey,
  getCompletedGrnReceivedNativeByKey,
  getCompletedGrnReceivedKgByKey,
  getPlannedPlanningQtyByItem,
  mergeKeyMapsIntoRmPm,
  loadRmPmMeta,
  toNum,
  GRN_IN_TRANSIT_STATUSES,
};

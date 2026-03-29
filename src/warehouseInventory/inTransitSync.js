/**
 * Keeps warehouse_inventory.in_transit aligned with a single definition used across
 * warehouse list, planning items-involved, and production views:
 *   GRN inbound (in-flight) + PO pipeline (issued / shipped / delivery-pending linked) + planning reservations.
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

const GRN_IN_TRANSIT_STATUSES = ['In Transit', 'Under GRN', 'Pending', 'Delayed', 'On Hold'];

function toNum(x) {
  if (x == null || x === '') return 0;
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

/** Sum qty per rm-{id} / pm-{id} from open inbound GRNs. */
async function getGrnInTransitQtyByKey() {
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

function addPoItemsToMap(map, items) {
  const lines = Array.isArray(items) ? items : [];
  for (const line of lines) {
    const qty = toNum(line.quantity ?? line.qty ?? line.poQty);
    if (qty <= 0) continue;
    let key = null;
    if (line.raw_material_id != null) key = `rm-${line.raw_material_id}`;
    else if (line.pack_material_id != null) key = `pm-${line.pack_material_id}`;
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + qty);
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
      trackingByPo.set(d.purchase_order_id, d);
    }
    const deliveryPendingIds = new Set(
      pendingPrs.map((pr) => {
        const d = pr.get ? pr.get({ plain: true }) : pr;
        return String(d.id);
      })
    );

    for (const po of pos) {
      const d = po.get ? po.get({ plain: true }) : po;
      if (skipPoIds.has(d.id)) continue;
      const st = String(d.status || '').trim();
      const tr = trackingByPo.get(d.id);
      const fd = d.form_data && typeof d.form_data === 'object' && !Array.isArray(d.form_data) ? d.form_data : {};
      const reqId = fd.requestId != null ? String(fd.requestId) : '';
      const linkedDeliveryPending = reqId && deliveryPendingIds.has(reqId);

      const releasedShipped =
        st === 'Released' && tr && tr.shipped_at && !tr.grn_complete_at;

      if (st === 'In Transit' || releasedShipped || linkedDeliveryPending) {
        addPoItemsToMap(map, d.items);
      }
    }
  } catch (err) {
    console.warn('[inTransitSync] getPoPipelineInTransitQtyByKey:', err.message);
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

function mergeKeyMapsIntoRmPm(grnMap, poMap, plannedRm, plannedPm) {
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
  for (const [id, q] of plannedRm) rmTotals.set(id, (rmTotals.get(id) || 0) + toNum(q));
  for (const [id, q] of plannedPm) pmTotals.set(id, (pmTotals.get(id) || 0) + toNum(q));
  return { rmTotals, pmTotals };
}

/**
 * Recompute and persist warehouse_inventory.in_transit for all RM/PM rows.
 */
async function syncWarehouseInTransitAll() {
  const [grnMap, poMap, planned] = await Promise.all([
    getGrnInTransitQtyByKey(),
    getPoPipelineInTransitQtyByKey(),
    getPlannedPlanningQtyByItem(),
  ]);
  const { rmTotals, pmTotals } = mergeKeyMapsIntoRmPm(grnMap, poMap, planned.rmMap, planned.pmMap);

  const whRows = await WarehouseInventory.findAll({
    where: { item_type: { [Op.in]: ['RM', 'PM'] } },
    attributes: ['id', 'item_type', 'raw_material_id', 'pack_material_id', 'in_transit'],
  });

  for (const w of whRows) {
    const d = w.get ? w.get({ plain: true }) : w;
    let next = 0;
    if (d.item_type === 'RM' && d.raw_material_id != null) {
      next = rmTotals.get(Number(d.raw_material_id)) || 0;
    } else if (d.item_type === 'PM' && d.pack_material_id != null) {
      next = pmTotals.get(Number(d.pack_material_id)) || 0;
    }
    const prev = toNum(d.in_transit);
    if (Math.abs(prev - next) > 1e-9) {
      await WarehouseInventory.update({ in_transit: next }, { where: { id: d.id } });
    }
  }

  return { rmTotals, pmTotals };
}

module.exports = {
  syncWarehouseInTransitAll,
  getGrnInTransitQtyByKey,
  getPoPipelineInTransitQtyByKey,
  getPlannedPlanningQtyByItem,
  mergeKeyMapsIntoRmPm,
  toNum,
  GRN_IN_TRANSIT_STATUSES,
};

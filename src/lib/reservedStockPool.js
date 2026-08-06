/**
 * Shared reserved-stock pool used by BOTH Production and Planning batch-line reservation.
 *
 * The whole app treats `available = stock_in_hand − reserved`, where `reserved` is the SUM of
 * every reserved_batch_items row for that material (production batches + planning batches + SO).
 * A batch's own free pool must therefore be:
 *
 *     free = SIH − (total reserved for the material − THIS batch's own reservation)
 *
 * so a batch never double-counts its own reservation, and Planning + Production reservations
 * correctly compete for the same stock (a Planning-batch reservation reduces the free pool a
 * Production batch sees, and vice-versa).
 */
const { ReservedBatchItem } = require('../fulfillment/models');
const WarehouseInventory = require('../warehouseInventory/models');

function sihFromPlain(plainWh) {
  if (!plainWh) return 0;
  const direct = Number(plainWh.stock_in_hand);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  return (
    (Number(plainWh.wh_stock) || 0)
    + (Number(plainWh.ml1_stock) || 0)
    + (Number(plainWh.ml2_stock) || 0)
  );
}

/** Stock-in-hand for a material (kind = 'rm'|'pm'). */
async function warehouseSihForMaterial(kind, materialId) {
  const mid = Number(materialId);
  if (!Number.isFinite(mid) || mid <= 0) return 0;
  const wh = await WarehouseInventory.findOne({
    where: kind === 'rm'
      ? { item_type: 'RM', raw_material_id: mid }
      : { item_type: 'PM', pack_material_id: mid },
  });
  return sihFromPlain(wh && wh.get ? wh.get({ plain: true }) : wh);
}

function materialWhere(kind, materialId) {
  return kind === 'rm'
    ? { raw_material_id: Number(materialId), pack_material_id: null }
    : { pack_material_id: Number(materialId), raw_material_id: null };
}

/** SUM(quantity_reserved) across EVERY reservation for the material (all batches / SO). */
async function sumReservedTotal(kind, materialId) {
  const s = await ReservedBatchItem.sum('quantity_reserved', { where: materialWhere(kind, materialId) });
  return s != null ? Number(s) : 0;
}

/**
 * SUM(quantity_reserved) for the material reserved by ONE batch.
 * Pass exactly one of { productionBatchId, planningBatchId }.
 */
async function sumReservedForBatch(kind, materialId, { productionBatchId = null, planningBatchId = null } = {}) {
  const where = materialWhere(kind, materialId);
  if (productionBatchId != null) where.production_batch_id = Number(productionBatchId);
  else if (planningBatchId != null) where.planning_batch_id = Number(planningBatchId);
  else return 0;
  const s = await ReservedBatchItem.sum('quantity_reserved', { where });
  return s != null ? Number(s) : 0;
}

/** Reserved by everyone EXCEPT the given batch (total − own). */
async function sumReservedOther(kind, materialId, exclude) {
  const total = await sumReservedTotal(kind, materialId);
  const own = await sumReservedForBatch(kind, materialId, exclude);
  return Math.max(0, total - own);
}

/** Free pool this batch may reserve from = SIH − reserved-by-others. */
async function freeForBatch(kind, materialId, exclude) {
  const sih = await warehouseSihForMaterial(kind, materialId);
  const other = await sumReservedOther(kind, materialId, exclude);
  return { sih, other, free: Math.max(0, sih - other) };
}

module.exports = {
  warehouseSihForMaterial,
  sumReservedTotal,
  sumReservedForBatch,
  sumReservedOther,
  freeForBatch,
};

const WarehouseInventoryLocationHistory = require('./locationHistoryModel');
const { materialQtyFromDb } = require('../utils/materialQtyCompare');

/**
 * Log a location / movement history entry in a safe, centralized way.
 * All params are optional except warehouseInventoryId + itemType.
 */
async function logLocationMovement({
  warehouseInventoryId,
  itemType,
  rawMaterialId,
  packMaterialId,
  productId,
  fromZone,
  fromRack,
  toZone,
  toRack,
  qtyDelta,
  actionType,
  sourceGrnId,
  sourceMrnId,
  productionBatchId,
  batchNo,
  dispensingBundleId,
  changesJson,
  note,
  transaction,
}) {
  if (!warehouseInventoryId || !itemType) return null;

  try {
    const row = await WarehouseInventoryLocationHistory.create({
      warehouse_inventory_id: warehouseInventoryId,
      item_type: itemType,
      raw_material_id: rawMaterialId ?? null,
      pack_material_id: packMaterialId ?? null,
      product_id: productId ?? null,
      from_zone: fromZone ?? null,
      from_rack: fromRack ?? null,
      to_zone: toZone ?? null,
      to_rack: toRack ?? null,
      qty_delta: qtyDelta != null ? materialQtyFromDb(qtyDelta) : null,
      action_type: actionType || null,
      source_grn_id: sourceGrnId ?? null,
      source_mrn_id: sourceMrnId ?? null,
      production_batch_id: productionBatchId ?? null,
      batch_no: batchNo ?? null,
      dispensing_bundle_id: dispensingBundleId ?? null,
      changes_json: changesJson != null ? changesJson : null,
      note: note != null && String(note).trim() ? String(note).trim() : null,
    }, transaction ? { transaction } : {});
    return row;
  } catch (err) {
    console.error('[warehouse-inventory] Failed to record location movement', err);
    // Do not throw; callers should not break main flows because of history failures.
    return null;
  }
}

/**
 * Log a reserved change from BMR/BPR (batch reservation). Shows in history with batch id.
 */
async function logReservedChange({
  warehouseInventoryId,
  itemType,
  rawMaterialId,
  packMaterialId,
  productId,
  reservedDelta,
  reservedAfter,
  productionBatchId,
  batchNo,
  actionType,
}) {
  if (!warehouseInventoryId || !itemType) return null;
  const action = actionType || 'BMR_RESERVED';

  try {
    const row = await WarehouseInventoryLocationHistory.create({
      warehouse_inventory_id: warehouseInventoryId,
      item_type: itemType,
      raw_material_id: rawMaterialId ?? null,
      pack_material_id: packMaterialId ?? null,
      product_id: productId ?? null,
      from_zone: null,
      from_rack: null,
      to_zone: null,
      to_rack: null,
      qty_delta: reservedDelta != null ? materialQtyFromDb(reservedDelta) : null,
      action_type: action,
      source_grn_id: null,
      source_mrn_id: null,
      reserved_delta: reservedDelta != null ? materialQtyFromDb(reservedDelta) : null,
      reserved_after: reservedAfter != null ? materialQtyFromDb(reservedAfter) : null,
      production_batch_id: productionBatchId ?? null,
      batch_no: batchNo ?? null,
    });
    return row;
  } catch (err) {
    console.error('[warehouse-inventory] Failed to record reserved change', err);
    return null;
  }
}

module.exports = {
  logLocationMovement,
  logReservedChange,
};


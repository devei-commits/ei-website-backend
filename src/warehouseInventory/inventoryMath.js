/**
 * Shared helpers for warehouse inventory math and rack-level quantities.
 * Source of truth: WarehouseRackItem per-rack quantities; WarehouseInventory holds aggregates.
 */
const WarehouseInventory = require('./models');
const { WarehouseRackItem, WarehouseRack, WarehouseLocation } = require('../warehouseLocations/models');
const { inferMlBucketFromProductionZone } = require('../facilityAreas/defaultLocationService');
const {
  materialQtyAdd,
  materialQtyFromDb,
  materialQtySubNonNeg,
  materialQtyToNum,
  isMaterialQtyPositive,
} = require('../utils/materialQtyCompare');

/**
 * Pure formula: stock_in_hand = wh_stock + ml1_stock + ml2_stock.
 * Used for unit tests and by updateStock / GRN / BPR.
 */
function computeStockInHand(wh, ml1, ml2) {
  return materialQtyToNum(materialQtyAdd(materialQtyAdd(wh, ml1), ml2));
}

/**
 * Recalculate wh_stock / ml1_stock / ml2_stock / stock_in_hand from rack rows.
 * Warehouse racks → wh_stock; production racks → ml1 or ml2 by zone (ML1 / ML2).
 */
async function recalculateInventoryForItem(warehouseInventoryId, opts = {}) {
  const transaction = opts.transaction;
  const inv = await WarehouseInventory.findByPk(
    warehouseInventoryId,
    transaction ? { transaction } : {}
  );
  if (!inv) return null;

  const rows = await WarehouseRackItem.findAll({
    where: { warehouse_inventory_id: warehouseInventoryId },
    include: [
      {
        model: WarehouseRack,
        as: 'WarehouseRack',
        required: true,
        include: [{ model: WarehouseLocation, as: 'WarehouseLocation', required: true }],
      },
    ],
    ...(transaction ? { transaction } : {}),
  });

  let totalWh = '0';
  let ml1 = '0';
  let ml2 = '0';
  for (const r of rows) {
    const plain = r.get ? r.get({ plain: true }) : r;
    const qty = materialQtyFromDb(plain.qty_wh);
    const rack = r.WarehouseRack;
    const loc = rack && rack.WarehouseLocation;
    const locPlain = loc && loc.get ? loc.get({ plain: true }) : loc;
    const locType = String(locPlain?.location_type || '').toLowerCase();
    if (locType === 'production') {
      if (inferMlBucketFromProductionZone(locPlain) === 'ml2') ml2 = materialQtyAdd(ml2, qty);
      else ml1 = materialQtyAdd(ml1, qty);
    } else {
      totalWh = materialQtyAdd(totalWh, qty);
    }
  }

  const stockInHand = materialQtyAdd(materialQtyAdd(totalWh, ml1), ml2);

  await inv.update(
    {
      wh_stock: totalWh,
      ml1_stock: ml1,
      ml2_stock: ml2,
      stock_in_hand: stockInHand,
    },
    transaction ? { transaction } : {}
  );

  return inv;
}

/**
 * Apply a quantity delta to a specific rack for a given warehouse_inventory row.
 * Creates or removes WarehouseRackItem as needed, then recalculates aggregates.
 *
 * Returns { rackItem, inventory } where inventory is the updated WarehouseInventory row.
 */
async function applyDeltaToRack(warehouseInventoryId, rackId, deltaQty, opts = {}) {
  if (!warehouseInventoryId || !rackId) {
    return { rackItem: null, inventory: null };
  }
  const delta = materialQtyFromDb(deltaQty);
  const deltaNum = materialQtyToNum(delta);
  if (deltaNum === 0) {
    return { rackItem: null, inventory: null };
  }

  const transaction = opts.transaction;

  const rack = await WarehouseRack.findByPk(rackId, {
    include: [{ model: WarehouseLocation, as: 'WarehouseLocation', required: false }],
    ...(transaction ? { transaction } : {}),
  });
  if (!rack) {
    throw new Error(`Rack not found for id=${rackId}`);
  }

  let rackItem = await WarehouseRackItem.findOne({
    where: { rack_id: rackId, warehouse_inventory_id: warehouseInventoryId },
    ...(transaction ? { transaction } : {}),
  });

  if (!rackItem) {
    if (deltaNum < 0) {
      return {
        rackItem: null,
        inventory: await recalculateInventoryForItem(warehouseInventoryId, { transaction }),
      };
    }
    rackItem = await WarehouseRackItem.create(
      {
        rack_id: rackId,
        warehouse_inventory_id: warehouseInventoryId,
        qty_wh: delta,
      },
      transaction ? { transaction } : {}
    );
  } else {
    const plain = rackItem.get ? rackItem.get({ plain: true }) : rackItem;
    const currentQty = materialQtyFromDb(plain.qty_wh);
    const nextQty = materialQtyAdd(currentQty, delta);

    if (!isMaterialQtyPositive(nextQty)) {
      await rackItem.destroy(transaction ? { transaction } : {});
      rackItem = null;
    } else {
      await rackItem.update({ qty_wh: nextQty }, transaction ? { transaction } : {});
    }
  }

  const inventory = await recalculateInventoryForItem(warehouseInventoryId, { transaction });
  return { rackItem, inventory };
}

module.exports = {
  applyDeltaToRack,
  recalculateInventoryForItem,
  computeStockInHand,
};

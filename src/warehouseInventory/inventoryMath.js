/**
 * Shared helpers for warehouse inventory math and rack-level quantities.
 * Source of truth: WarehouseRackItem per-rack quantities; WarehouseInventory holds aggregates.
 */
const WarehouseInventory = require('./models');
const { WarehouseRackItem, WarehouseRack, WarehouseLocation } = require('../warehouseLocations/models');

function toNum(x) {
  if (x == null) return 0;
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Pure formula: stock_in_hand = wh_stock + ml1_stock + ml2_stock.
 * Used for unit tests and by updateStock / GRN / BPR.
 */
function computeStockInHand(wh, ml1, ml2) {
  return toNum(wh) + toNum(ml1) + toNum(ml2);
}

/**
 * Recalculate wh_stock / stock_in_hand for a warehouse_inventory row
 * by summing all WarehouseRackItem.qty_wh entries for that row.
 */
async function recalculateInventoryForItem(warehouseInventoryId) {
  const inv = await WarehouseInventory.findByPk(warehouseInventoryId);
  if (!inv) return null;

  const rows = await WarehouseRackItem.findAll({
    where: { warehouse_inventory_id: warehouseInventoryId },
  });

  let totalWh = 0;
  for (const r of rows) {
    const plain = r.get ? r.get({ plain: true }) : r;
    totalWh += toNum(plain.qty_wh);
  }

  const plainInv = inv.get ? inv.get({ plain: true }) : inv;
  const ml1 = toNum(plainInv.ml1_stock);
  const ml2 = toNum(plainInv.ml2_stock);
  const stockInHand = computeStockInHand(totalWh, ml1, ml2);

  await inv.update({
    wh_stock: totalWh,
    stock_in_hand: stockInHand,
  });

  return inv;
}

/**
 * Apply a quantity delta to a specific rack for a given warehouse_inventory row.
 * Creates or removes WarehouseRackItem as needed, then recalculates aggregates.
 *
 * Returns { rackItem, inventory } where inventory is the updated WarehouseInventory row.
 */
async function applyDeltaToRack(warehouseInventoryId, rackId, deltaQty) {
  if (!warehouseInventoryId || !rackId || !deltaQty) {
    return { rackItem: null, inventory: null };
  }

  const rack = await WarehouseRack.findByPk(rackId, {
    include: [{ model: WarehouseLocation, as: 'WarehouseLocation', required: false }],
  });
  if (!rack) {
    throw new Error(`Rack not found for id=${rackId}`);
  }

  let rackItem = await WarehouseRackItem.findOne({
    where: { rack_id: rackId, warehouse_inventory_id: warehouseInventoryId },
  });

  if (!rackItem) {
    if (deltaQty < 0) {
      // Nothing to subtract; ignore.
      return { rackItem: null, inventory: await recalculateInventoryForItem(warehouseInventoryId) };
    }
    rackItem = await WarehouseRackItem.create({
      rack_id: rackId,
      warehouse_inventory_id: warehouseInventoryId,
      qty_wh: deltaQty,
    });
  } else {
    const plain = rackItem.get ? rackItem.get({ plain: true }) : rackItem;
    const currentQty = toNum(plain.qty_wh);
    let nextQty = currentQty + deltaQty;
    if (nextQty < 0) nextQty = 0;

    if (nextQty === 0) {
      await rackItem.destroy();
      rackItem = null;
    } else {
      await rackItem.update({ qty_wh: nextQty });
    }
  }

  const inventory = await recalculateInventoryForItem(warehouseInventoryId);
  return { rackItem, inventory };
}

module.exports = {
  applyDeltaToRack,
  recalculateInventoryForItem,
  computeStockInHand,
};


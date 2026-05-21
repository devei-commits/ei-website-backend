/**
 * Apply inbound (GRN) quantity to warehouse_inventory with rack-level allocation.
 */
const WarehouseInventory = require('../warehouseInventory/models');
const { WarehouseRackItem } = require('../warehouseLocations/models');
const { mergeLocationTokens } = require('../warehouseInventory/locationTokensMerge');
const { applyDeltaToRack, computeStockInHand } = require('../warehouseInventory/inventoryMath');
const { resolveInboundWarehouseRack } = require('../facilityAreas/defaultLocationService');

function toNum(x) {
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * @returns {Promise<import('sequelize').Model>}
 */
async function applyWhInboundStock(whRow, qty, itemIds, opts = {}) {
  const transaction = opts.transaction;
  const grnId = opts.grnId;
  const dest = await resolveInboundWarehouseRack(itemIds, { transaction });

  let row = whRow;
  const plain = row.get ? row.get({ plain: true }) : row;
  const inTransitBefore = toNum(plain.in_transit);
  const inTransit = Math.max(0, inTransitBefore - qty);
  const ml1 = toNum(plain.ml1_stock);
  const ml2 = toNum(plain.ml2_stock);

  if (dest && dest.rackId) {
    const existingRacks = await WarehouseRackItem.findAll({
      where: { warehouse_inventory_id: plain.id },
      ...(transaction ? { transaction } : {}),
    });
    const orphanWh = toNum(plain.wh_stock);
    if (existingRacks.length === 0 && orphanWh > 0) {
      await applyDeltaToRack(plain.id, dest.rackId, orphanWh, { transaction });
    }
    await applyDeltaToRack(plain.id, dest.rackId, qty, { transaction });
    row = await WarehouseInventory.findByPk(plain.id, transaction ? { transaction } : {});
    const after = row.get ? row.get({ plain: true }) : row;
    const zoneMerged = mergeLocationTokens(after.zone, dest.locationName || dest.locationCode);
    const rackMerged = mergeLocationTokens(after.rack, dest.rackCode);
    await row.update(
      {
        in_transit: inTransit,
        zone: zoneMerged,
        rack: rackMerged,
        stock_in_hand: computeStockInHand(after.wh_stock, ml1, ml2),
        wh_unit: after.wh_unit || plain.wh_unit || 'KG',
      },
      transaction ? { transaction } : {}
    );
    console.log('[grn] WH inbound via rack', {
      warehouseInventoryId: plain.id,
      qty,
      rackId: dest.rackId,
      source: dest.source,
      locationCode: dest.locationCode,
    });
  } else {
    const whStock = toNum(plain.wh_stock) + qty;
    await row.update(
      {
        wh_stock: whStock,
        in_transit: inTransit,
        stock_in_hand: whStock + ml1 + ml2,
        wh_unit: plain.wh_unit || 'KG',
      },
      transaction ? { transaction } : {}
    );
    console.warn('[grn] WH inbound without rack (no default warehouse location configured)', {
      warehouseInventoryId: plain.id,
      qty,
    });
  }

  return row;
}

module.exports = { applyWhInboundStock };

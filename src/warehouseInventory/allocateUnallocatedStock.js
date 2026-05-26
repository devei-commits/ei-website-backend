/**
 * After SIH Excel import, place bucket qty not yet on racks onto the default zone/rack.
 * Does not recalculate inventory aggregates (Excel values for wh/ml1/ml2 stay as imported).
 */
const WarehouseInventory = require('./models');
const { WarehouseRackItem, WarehouseRack, WarehouseLocation } = require('../warehouseLocations/models');
const { mergeLocationTokens } = require('./locationTokensMerge');
const { syncZoneRackTextFromRackItems } = require('./rackStockHelpers');
const {
  resolveInboundWarehouseRack,
  resolveProductionRackForTransfer,
  getManufacturingLocationLabels,
  inferMlBucketFromProductionZone,
} = require('../facilityAreas/defaultLocationService');

function toNum(x) {
  if (x == null) return 0;
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

function itemIdsFromInventoryRow(plain) {
  const itemType = String(plain.item_type || '').toUpperCase();
  if (itemType === 'RM') return { rawMaterialId: plain.raw_material_id };
  if (itemType === 'PM') return { packMaterialId: plain.pack_material_id };
  if (itemType === 'PR') return { productId: plain.product_id };
  return {};
}

function rackMatchesBucket(locPlain, bucketKey) {
  const locType = String(locPlain?.location_type || '').toLowerCase();
  if (bucketKey === 'warehouse') return locType === 'warehouse';
  if (bucketKey === 'ml1' || bucketKey === 'ml2') {
    if (locType !== 'production') return false;
    return inferMlBucketFromProductionZone(locPlain) === bucketKey;
  }
  return false;
}

/**
 * Sum qty_wh on racks belonging to one SIH bucket (WH, ML1, or ML2).
 */
async function sumRackQtyForBucket(warehouseInventoryId, bucketKey, opts = {}) {
  const transaction = opts.transaction;
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

  let sum = 0;
  for (const row of rows) {
    const rack = row.WarehouseRack;
    const loc = rack && rack.WarehouseLocation;
    const locPlain = loc && loc.get ? loc.get({ plain: true }) : loc;
    if (!rackMatchesBucket(locPlain, bucketKey)) continue;
    const itPlain = row.get ? row.get({ plain: true }) : row;
    sum += toNum(itPlain.qty_wh);
  }
  return sum;
}

async function resolveDefaultRackForBucket(bucketKey, itemIds, opts = {}) {
  if (bucketKey === 'warehouse') {
    return resolveInboundWarehouseRack(itemIds, opts);
  }
  const labels = await getManufacturingLocationLabels(opts);
  const zoneCode =
    bucketKey === 'ml2' ? labels.ml2?.locationCode : labels.ml1?.locationCode;
  return resolveProductionRackForTransfer(
    { zoneCode: zoneCode || undefined, lineItems: [] },
    opts
  );
}

function targetQtyForBucket(plain, bucketKey) {
  if (bucketKey === 'warehouse') return toNum(plain.wh_stock);
  if (bucketKey === 'ml1') return toNum(plain.ml1_stock);
  if (bucketKey === 'ml2') return toNum(plain.ml2_stock);
  return 0;
}

/**
 * Add unallocated bucket qty to the default rack (WH default zone, or ML1/ML2 production zone).
 * @returns {Promise<{ allocated: number, rackId: number|null, locationCode: string|null }>}
 */
async function allocateUnallocatedToDefaultRack(whRow, bucketKey, opts = {}) {
  const transaction = opts.transaction;
  const plain = whRow.get ? whRow.get({ plain: true }) : whRow;
  const invId = plain.id;
  const targetQty = targetQtyForBucket(plain, bucketKey);
  const rackSum = await sumRackQtyForBucket(invId, bucketKey, { transaction });
  const unallocated = Math.max(0, targetQty - rackSum);

  if (unallocated <= 0) {
    return { allocated: 0, rackId: null, locationCode: null };
  }

  const itemIds = itemIdsFromInventoryRow(plain);
  const dest = await resolveDefaultRackForBucket(bucketKey, itemIds, { transaction });
  if (!dest?.rackId) {
    return { allocated: 0, rackId: null, locationCode: dest?.locationCode || null };
  }

  let rackItem = await WarehouseRackItem.findOne({
    where: { rack_id: dest.rackId, warehouse_inventory_id: invId },
    ...(transaction ? { transaction } : {}),
  });

  const currentOnRack = rackItem ? toNum(rackItem.qty_wh) : 0;
  const nextQty = currentOnRack + unallocated;

  if (nextQty <= 0) {
    if (rackItem) await rackItem.destroy(transaction ? { transaction } : {});
  } else if (!rackItem) {
    await WarehouseRackItem.create(
      {
        rack_id: dest.rackId,
        warehouse_inventory_id: invId,
        qty_wh: nextQty,
      },
      transaction ? { transaction } : {}
    );
  } else {
    await rackItem.update({ qty_wh: nextQty }, transaction ? { transaction } : {});
  }

  if (bucketKey === 'warehouse') {
    await syncZoneRackTextFromRackItems(invId, { transaction });
    const inv = await WarehouseInventory.findByPk(invId, transaction ? { transaction } : {});
    if (inv) {
      const after = inv.get ? inv.get({ plain: true }) : inv;
      await inv.update(
        {
          zone: mergeLocationTokens(after.zone, dest.locationName || dest.locationCode),
          rack: mergeLocationTokens(after.rack, dest.rackCode),
        },
        transaction ? { transaction } : {}
      );
    }
  }

  return {
    allocated: unallocated,
    rackId: dest.rackId,
    locationCode: dest.locationCode || null,
  };
}

module.exports = {
  allocateUnallocatedToDefaultRack,
  sumRackQtyForBucket,
  rackMatchesBucket,
};

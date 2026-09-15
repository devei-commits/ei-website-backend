/**
 * After SIH Excel import, place bucket qty not yet on racks onto the default zone/rack.
 * Does not recalculate inventory aggregates (Excel values for wh/ml1/ml2 stay as imported).
 */
const WarehouseInventory = require('./models');
const { WarehouseRackItem, WarehouseRack, WarehouseLocation } = require('../warehouseLocations/models');
const { mergeLocationTokens } = require('./locationTokensMerge');
const { syncZoneRackTextFromRackItems } = require('./rackStockHelpers');
const { activeRowWhere } = require('../lib/softDelete');
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
    // Same class of bug as recalculateInventoryForItem: this table isn't Sequelize-paranoid, so
    // a soft-deleted rack row (deleted_at set) stays in the table and must be excluded
    // explicitly, or it gets summed back in as if it were still real stock.
    where: activeRowWhere({ warehouse_inventory_id: warehouseInventoryId }),
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
  return resolveProductionRackForTransfer({ zoneCode: zoneCode || undefined }, opts);
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
    where: activeRowWhere({ rack_id: dest.rackId, warehouse_inventory_id: invId }),
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

/**
 * Remove excess bucket qty from racks when the aggregate (e.g. a physical-count SIH import) is
 * now LOWER than what racks currently show — the opposite of allocateUnallocatedToDefaultRack's
 * top-up. Without this, an import that lowered wh/ml1/ml2_stock left the old, now-too-high rack
 * rows untouched forever (nothing ever trimmed them): the aggregate said 0 but a rack row from a
 * real GRN/put-away weeks earlier still said 120, and pick/transfer screens — which read racks
 * directly, not the aggregate — kept offering stock that physically isn't there anymore.
 *
 * Trims the largest rack first (arbitrary but deterministic — there's no batch/FEFO ordering on
 * these loose-stock rows) until the bucket's rack sum matches the target; destroys any rack row
 * that hits zero. The SIH import/physical count is treated as authoritative here — if it says
 * less than racks show, the racks are assumed wrong, not the count.
 */
async function trimExcessRackStockToTarget(whRow, bucketKey, opts = {}) {
  const transaction = opts.transaction;
  const plain = whRow.get ? whRow.get({ plain: true }) : whRow;
  const invId = plain.id;
  const targetQty = targetQtyForBucket(plain, bucketKey);

  const rows = await WarehouseRackItem.findAll({
    where: activeRowWhere({ warehouse_inventory_id: invId }),
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

  const bucketRows = rows
    .filter((row) => {
      const rack = row.WarehouseRack;
      const loc = rack && rack.WarehouseLocation;
      const locPlain = loc && loc.get ? loc.get({ plain: true }) : loc;
      return rackMatchesBucket(locPlain, bucketKey);
    })
    .map((row) => ({ row, qty: toNum((row.get ? row.get({ plain: true }) : row).qty_wh) }))
    .sort((a, b) => b.qty - a.qty); // largest first — arbitrary but deterministic

  const rackSum = bucketRows.reduce((s, r) => s + r.qty, 0);
  let excess = rackSum - targetQty;
  if (excess <= 0) return { trimmed: 0, racksCleared: 0, racksReduced: 0 };

  let trimmed = 0;
  let racksCleared = 0;
  let racksReduced = 0;
  for (const { row, qty } of bucketRows) {
    if (excess <= 0) break;
    const take = Math.min(qty, excess);
    const remaining = qty - take;
    if (remaining <= 0) {
      await row.destroy(transaction ? { transaction } : {});
      racksCleared += 1;
    } else {
      await row.update({ qty_wh: remaining }, transaction ? { transaction } : {});
      racksReduced += 1;
    }
    trimmed += take;
    excess -= take;
  }

  if (bucketKey === 'warehouse') {
    await syncZoneRackTextFromRackItems(invId, { transaction });
  }

  return { trimmed, racksCleared, racksReduced };
}

/**
 * One entry point for either direction: tops racks up when the aggregate exceeds them, trims
 * them down when the aggregate is now lower. Callers that used to call
 * allocateUnallocatedToDefaultRack directly (assuming the aggregate only ever grows) should call
 * this instead so a downward correction (e.g. a physical-count SIH import) actually sticks.
 */
async function reconcileRackStockToTarget(whRow, bucketKey, opts = {}) {
  const plain = whRow.get ? whRow.get({ plain: true }) : whRow;
  const targetQty = targetQtyForBucket(plain, bucketKey);
  const rackSum = await sumRackQtyForBucket(plain.id, bucketKey, opts);
  if (rackSum < targetQty) {
    const result = await allocateUnallocatedToDefaultRack(whRow, bucketKey, opts);
    return { direction: 'topped_up', ...result };
  }
  if (rackSum > targetQty) {
    const result = await trimExcessRackStockToTarget(whRow, bucketKey, opts);
    return { direction: 'trimmed', ...result };
  }
  return { direction: 'none' };
}

module.exports = {
  allocateUnallocatedToDefaultRack,
  trimExcessRackStockToTarget,
  reconcileRackStockToTarget,
  sumRackQtyForBucket,
  rackMatchesBucket,
};

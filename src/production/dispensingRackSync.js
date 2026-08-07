/**
 * Keep `warehouse_rack_items` in step with dispensing consumption.
 *
 * Dispensing decrements the warehouse_inventory bucket columns (ml1_stock / ml2_stock /
 * stock_in_hand) but historically left the rack rows alone. The two then disagree by exactly the
 * quantity consumed, which has real consequences:
 *
 *   • the RM pick-from-rack picker reads rack rows, so consumed material stayed pickable;
 *   • any recalculation from rack rows (scripts/repair-warehouse-ml-buckets.js,
 *     recalculateInventoryForItem) would resurrect the consumed quantity.
 *
 * This module applies the same delta to the rack rows at the batch's manufacturing site.
 *
 * Deliberately NOT implemented as "mutate racks, then recalculate the aggregates from them": some
 * items carry bucket quantities with no rack rows at all, and a recalculation would silently zero
 * them. The aggregate update stays the authority for the amount consumed; this only brings the rack
 * rows along, capped at what they actually hold, so it can never double-decrement.
 */
const {
  muZoneCodeToMlBucket,
  inferMlBucketFromProductionZone,
  resolveProductionRackForTransfer,
} = require('../facilityAreas/defaultLocationService');
const { WarehouseRackItem, WarehouseRack, WarehouseLocation } = require('../warehouseLocations/models');
const { materialQtyFromDb, materialQtyToNum } = require('../utils/materialQtyCompare');
const { roundPlanningMaterialQty } = require('../planningExtracted/orderKgMath');

const EPS = 1e-6;

function plainOf(row) {
  return row && typeof row.get === 'function' ? row.get({ plain: true }) : row;
}

/** Rack rows for this item that sit at the given MU bucket ('ml1' | 'ml2'), largest first. */
async function productionRackRows(warehouseInventoryId, bucket, { transaction } = {}) {
  const rows = await WarehouseRackItem.findAll({
    where: { warehouse_inventory_id: Number(warehouseInventoryId) },
    include: [{
      model: WarehouseRack,
      as: 'WarehouseRack',
      required: true,
      include: [{ model: WarehouseLocation, as: 'WarehouseLocation', required: true }],
    }],
    ...(transaction ? { transaction } : {}),
  });
  return rows
    .filter((r) => {
      const loc = r.WarehouseRack && r.WarehouseRack.WarehouseLocation;
      const locPlain = plainOf(loc);
      if (String(locPlain?.location_type || '').toLowerCase() !== 'production') return false;
      return inferMlBucketFromProductionZone(locPlain) === bucket;
    })
    .filter((r) => materialQtyToNum(materialQtyFromDb(plainOf(r).qty_wh)) > EPS)
    .sort((a, b) => materialQtyToNum(materialQtyFromDb(plainOf(b).qty_wh))
      - materialQtyToNum(materialQtyFromDb(plainOf(a).qty_wh)));
}

/** Take `qty` off this item's rack rows at the MU site. Never takes more than the rows hold. */
async function reduceRackStockAtMuZone(warehouseInventoryId, muZone, qty, opts = {}) {
  const want = Number(qty) || 0;
  if (want <= EPS) return { reduced: 0, shortfall: 0, touched: [] };
  const bucket = muZoneCodeToMlBucket(muZone);
  const rows = await productionRackRows(warehouseInventoryId, bucket, opts);

  let left = want;
  const touched = [];
  for (const row of rows) {
    if (left <= EPS) break;
    const p = plainOf(row);
    const have = materialQtyToNum(materialQtyFromDb(p.qty_wh));
    const take = Math.min(left, have);
    const next = roundPlanningMaterialQty(have - take);
    if (next <= EPS) {
      await row.destroy(opts.transaction ? { transaction: opts.transaction } : {});
    } else {
      await row.update({ qty_wh: next }, opts.transaction ? { transaction: opts.transaction } : {});
    }
    left = roundPlanningMaterialQty(left - take);
    touched.push({ rackItemId: p.id, rackId: p.rack_id, took: take, remaining: next });
  }
  return { reduced: roundPlanningMaterialQty(want - left), shortfall: roundPlanningMaterialQty(left), touched };
}

/** Put `qty` back on the MU site's default rack — the mirror of a reduced/corrected dispense. */
async function restoreRackStockAtMuZone(warehouseInventoryId, muZone, qty, opts = {}) {
  const want = Number(qty) || 0;
  if (want <= EPS) return { restored: 0, rackId: null };
  const bucket = muZoneCodeToMlBucket(muZone);
  const existing = await productionRackRows(warehouseInventoryId, bucket, opts);
  const target = existing[0];
  if (target) {
    const p = plainOf(target);
    const next = roundPlanningMaterialQty(materialQtyToNum(materialQtyFromDb(p.qty_wh)) + want);
    await target.update({ qty_wh: next }, opts.transaction ? { transaction: opts.transaction } : {});
    return { restored: want, rackId: p.rack_id };
  }
  // No rack row at that site yet — put it on the site's default rack.
  const dest = await resolveProductionRackForTransfer({ zoneCode: muZone }, opts);
  if (!dest?.rackId) return { restored: 0, rackId: null };
  const [row] = await WarehouseRackItem.findOrCreate({
    where: { rack_id: dest.rackId, warehouse_inventory_id: Number(warehouseInventoryId) },
    defaults: { rack_id: dest.rackId, warehouse_inventory_id: Number(warehouseInventoryId), qty_wh: 0 },
    ...(opts.transaction ? { transaction: opts.transaction } : {}),
  });
  const cur = materialQtyToNum(materialQtyFromDb(plainOf(row).qty_wh));
  await row.update(
    { qty_wh: roundPlanningMaterialQty(cur + want) },
    opts.transaction ? { transaction: opts.transaction } : {},
  );
  return { restored: want, rackId: dest.rackId };
}

/**
 * Mirror one dispensing delta onto the rack rows.
 * @param {object} args
 * @param {number} args.warehouseInventoryId
 * @param {string} args.muZone   batch's scheduled_mu_zone (e.g. LOC-ML1)
 * @param {number} args.delta    >0 consumed, <0 returned
 */
async function syncRackStockForDispenseDelta({ warehouseInventoryId, muZone, delta }, opts = {}) {
  const invId = Number(warehouseInventoryId);
  const d = Number(delta) || 0;
  if (!Number.isFinite(invId) || invId <= 0 || !String(muZone || '').trim() || Math.abs(d) <= EPS) {
    return { applied: 0, shortfall: 0 };
  }
  if (d > 0) {
    const { reduced, shortfall, touched } = await reduceRackStockAtMuZone(invId, muZone, d, opts);
    return { applied: reduced, shortfall, touched };
  }
  const { restored, rackId } = await restoreRackStockAtMuZone(invId, muZone, Math.abs(d), opts);
  return { applied: -restored, shortfall: 0, touched: rackId ? [{ rackId, took: -restored }] : [] };
}

module.exports = {
  syncRackStockForDispenseDelta,
  reduceRackStockAtMuZone,
  restoreRackStockAtMuZone,
};

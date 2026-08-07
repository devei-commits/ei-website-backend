/**
 * Pending-reservation allocator — "reserve now, allocate on arrival".
 *
 * A batch may reserve material the facility does not physically have yet. Such a reservation is
 * stored with `quantity_requested` = full demand and `quantity_reserved` = the portion stock could
 * back at the time (often 0). The gap is *pending*.
 *
 *     pending = max(0, quantity_requested − quantity_reserved)
 *
 * This module closes that gap: whenever stock lands in the facility (GRN completion, or the manual
 * sweep script), it hands the newly free quantity to the pending reservations FIFO — oldest
 * reservation first — so the batch that waited longest is served first.
 *
 * Only `quantity_reserved` ever moves, which is exactly the column `warehouse_inventory.reserved`
 * sums and that `available = SIH − reserved` nets out. So allocation can never over-commit stock:
 * the free pool is recomputed per material as `SIH − SUM(quantity_reserved)` and is the hard cap.
 */
const { ReservedBatchItem } = require('../fulfillment/models');
const { warehouseSihForMaterial } = require('./reservedStockPool');
const { roundPlanningMaterialQty } = require('../planningExtracted/orderKgMath');
const db = require('../../db');

const EPS = 1e-6;

function plainOf(row) {
  return row && typeof row.get === 'function' ? row.get({ plain: true }) : row;
}

/** Demand this reservation asked for. NULL `quantity_requested` = legacy row → fully backed. */
function requestedOf(p) {
  const req = Number(p.quantity_requested);
  const res = Number(p.quantity_reserved) || 0;
  return Number.isFinite(req) ? Math.max(req, 0) : res;
}

function pendingOf(p) {
  return Math.max(0, requestedOf(p) - (Number(p.quantity_reserved) || 0));
}

/** A reservation that was cancelled / consumed must not be topped up when stock arrives. */
function isLiveReservation(p) {
  if (p.deleted_at) return false;
  const life = p.lifecycle_status == null ? 'active' : String(p.lifecycle_status).trim().toLowerCase();
  return life === '' || life === 'active';
}

function materialWhere(kind, materialId) {
  return kind === 'rm'
    ? { raw_material_id: Number(materialId), pack_material_id: null }
    : { pack_material_id: Number(materialId), raw_material_id: null };
}

/**
 * Recompute warehouse_inventory.reserved for one material from the reservation rows.
 *
 * Deliberately raw SQL rather than the controller's `syncWarehouseReserved`: that helper opens its
 * OWN transaction per item, which would deadlock (or read pre-commit state) when we are already
 * inside the caller's GRN transaction. This runs on whatever transaction we were handed.
 */
async function recomputeWarehouseReserved(kind, materialId, { transaction } = {}) {
  const idCol = kind === 'rm' ? 'raw_material_id' : 'pack_material_id';
  const itemType = kind === 'rm' ? 'RM' : 'PM';
  await db.query(
    `UPDATE warehouse_inventory
        SET reserved = COALESCE(
              (SELECT SUM(quantity_reserved) FROM reserved_batch_items WHERE ${idCol} = :mid), 0),
            updated_at = NOW()
      WHERE item_type = :itemType AND ${idCol} = :mid`,
    { replacements: { mid: Number(materialId), itemType }, ...(transaction ? { transaction } : {}) },
  );
}

/**
 * Hand this material's free stock to its pending reservations, oldest first.
 * @returns {Promise<{ materialId:number, kind:string, allocated:number, fills:Array }>}
 */
async function allocatePendingForMaterial(kind, materialId, { transaction } = {}) {
  const k = kind === 'pm' ? 'pm' : 'rm';
  const mid = Number(materialId);
  const empty = { materialId: mid, kind: k, allocated: 0, fills: [] };
  if (!Number.isFinite(mid) || mid <= 0) return empty;

  const rows = await ReservedBatchItem.findAll({
    where: materialWhere(k, mid),
    order: [['created_at', 'ASC'], ['id', 'ASC']],
    ...(transaction ? { transaction } : {}),
  });
  if (rows.length === 0) return empty;

  // Free pool = everything on the shelf minus everything already stock-backed. Same identity the
  // rest of the app uses, so we can never allocate stock another batch is already holding.
  const sih = await warehouseSihForMaterial(k, mid, { transaction });
  let totalReserved = 0;
  for (const r of rows) totalReserved += Number(plainOf(r).quantity_reserved) || 0;
  let free = sih - totalReserved;
  if (free <= EPS) return empty;

  const fills = [];
  let allocated = 0;
  for (const row of rows) {
    if (free <= EPS) break;
    const p = plainOf(row);
    if (!isLiveReservation(p)) continue;
    const pending = pendingOf(p);
    if (pending <= EPS) continue;

    const give = roundPlanningMaterialQty(Math.min(pending, free));
    if (give <= EPS) continue;
    const after = roundPlanningMaterialQty((Number(p.quantity_reserved) || 0) + give);
    await row.update({ quantity_reserved: after }, transaction ? { transaction } : {});
    free = roundPlanningMaterialQty(free - give);
    allocated = roundPlanningMaterialQty(allocated + give);
    fills.push({
      reservedBatchItemId: p.id,
      productionBatchId: p.production_batch_id ?? null,
      planningBatchId: p.planning_batch_id ?? null,
      planningExtractedId: p.planning_extracted_id ?? null,
      allocated: give,
      reservedAfter: after,
      requested: requestedOf(p),
      stillPending: roundPlanningMaterialQty(Math.max(0, requestedOf(p) - after)),
      unit: p.unit || (k === 'rm' ? 'KG' : 'PCS'),
    });
  }

  if (allocated > EPS) await recomputeWarehouseReserved(k, mid, { transaction });
  return { materialId: mid, kind: k, allocated, fills };
}

/**
 * Allocate for a specific set of materials — the GRN hook passes exactly what it just received.
 * @param {{ rmIds?: number[], pmIds?: number[] }} materials
 */
async function allocatePendingReservations(materials = {}, { transaction } = {}) {
  const rmIds = Array.from(new Set((materials.rmIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0)));
  const pmIds = Array.from(new Set((materials.pmIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0)));
  const results = [];
  for (const id of rmIds) results.push(await allocatePendingForMaterial('rm', id, { transaction }));
  for (const id of pmIds) results.push(await allocatePendingForMaterial('pm', id, { transaction }));
  const touched = results.filter((r) => r.allocated > EPS);

  // A batch whose last pending line just landed is now truly reserved — reflect that on the batch.
  const batchIds = [];
  for (const r of touched) {
    for (const f of r.fills) if (f.productionBatchId) batchIds.push(f.productionBatchId);
  }
  let batchFlags = { rm: 0, pm: 0 };
  if (batchIds.length > 0) {
    try {
      batchFlags = await reconcilePendingReservationBatchFlags(batchIds, { transaction });
    } catch (e) {
      console.warn('[pendingReservationAllocator] batch flag reconcile failed:', e && e.message ? e.message : e);
    }
  }

  return {
    materialsScanned: rmIds.length + pmIds.length,
    materialsAllocated: touched.length,
    totalAllocated: touched.reduce((s, r) => s + r.allocated, 0),
    batchFlags,
    results: touched,
  };
}

/**
 * A production batch that was waiting on stock becomes genuinely "reserved" the moment its last
 * pending line is filled — flip rm_reserved / pm_reserved (and nudge the status) for the batches
 * the allocator just topped up.
 *
 * Forward-only and guarded: never un-reserves, never touches a batch already past the reserve stage
 * (connected / dispensing / in production …), and only fires when the batch has reservation rows of
 * that kind AND none of them still has a pending remainder.
 */
async function reconcilePendingReservationBatchFlags(batchIds, { transaction } = {}) {
  const ids = Array.from(new Set((batchIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0)));
  if (ids.length === 0) return { rm: 0, pm: 0 };

  const settled = (matCol) => `
    EXISTS (SELECT 1 FROM reserved_batch_items r
             WHERE r.production_batch_id = pb.id AND r.${matCol} IS NOT NULL AND r.deleted_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM reserved_batch_items r
             WHERE r.production_batch_id = pb.id AND r.${matCol} IS NOT NULL AND r.deleted_at IS NULL
               AND r.quantity_requested IS NOT NULL
               AND r.quantity_requested > r.quantity_reserved + 1e-6)`;

  const [, rmMeta] = await db.query(
    `UPDATE production_batches pb
        SET rm_reserved = true,
            bmr_status = CASE WHEN pb.bmr_status = 'batch_confirmed' THEN 'rm_reserved' ELSE pb.bmr_status END,
            updated_at = NOW()
      WHERE pb.id IN (:ids)
        AND pb.rm_reserved IS DISTINCT FROM true
        AND COALESCE(pb.bmr_status, '') NOT IN
            ('rm_connected','dispensing','in_production','bulk_qc','qc_failed','cleared')
        AND ${settled('raw_material_id')}`,
    { replacements: { ids }, ...(transaction ? { transaction } : {}) },
  );

  // PM only becomes reservable once bulk QC is cleared — mirrors syncBatchReserveFlags.
  const [, pmMeta] = await db.query(
    `UPDATE production_batches pb
        SET pm_reserved = true,
            bpr_status = CASE WHEN COALESCE(pb.bpr_status, '') IN ('', 'draft') THEN 'pm_reserved' ELSE pb.bpr_status END,
            updated_at = NOW()
      WHERE pb.id IN (:ids)
        AND pb.pm_reserved IS DISTINCT FROM true
        AND LOWER(COALESCE(pb.bmr_status, '')) = 'cleared'
        AND COALESCE(pb.bpr_status, '') NOT IN
            ('pm_connected','pm_dispensing','filling','fill_qc','packaging','pack_qc','qc_failed','fg_ready')
        AND ${settled('pack_material_id')}`,
    { replacements: { ids }, ...(transaction ? { transaction } : {}) },
  );

  return { rm: rmMeta?.rowCount ?? 0, pm: pmMeta?.rowCount ?? 0 };
}

/** Every material that currently has a pending reservation — for the manual/scheduled sweep. */
async function findMaterialsWithPendingReservations({ transaction } = {}) {
  const SELECT = require('sequelize').QueryTypes.SELECT;
  const rows = await db.query(
    `SELECT DISTINCT raw_material_id, pack_material_id
       FROM reserved_batch_items
      WHERE quantity_requested IS NOT NULL
        AND quantity_requested > quantity_reserved
        AND deleted_at IS NULL
        AND (lifecycle_status = 'active' OR lifecycle_status IS NULL)`,
    { type: SELECT, ...(transaction ? { transaction } : {}) },
  );
  const rmIds = [];
  const pmIds = [];
  for (const r of rows) {
    if (r.raw_material_id != null) rmIds.push(Number(r.raw_material_id));
    else if (r.pack_material_id != null) pmIds.push(Number(r.pack_material_id));
  }
  return { rmIds, pmIds };
}

/** Sweep every material with pending demand — covers stock arrivals outside the GRN path. */
async function allocateAllPendingReservations({ transaction } = {}) {
  const materials = await findMaterialsWithPendingReservations({ transaction });
  return allocatePendingReservations(materials, { transaction });
}

module.exports = {
  allocatePendingForMaterial,
  allocatePendingReservations,
  allocateAllPendingReservations,
  findMaterialsWithPendingReservations,
  reconcilePendingReservationBatchFlags,
  pendingOf,
  requestedOf,
};

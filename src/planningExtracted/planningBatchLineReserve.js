/**
 * Per-planning-batch RM/PM reservation for the Planning "Batches" RM/PM Status popups.
 *
 * Mirrors Production's line reserve (src/production/batchLineReserve.js) but keys rows by
 * `planning_batch_id` instead of `production_batch_id`, and stamps `is_manual = true` so the
 * automatic PI rebuild leaves them alone. Per-line qty comes from the SAME helper the auto
 * rebuild uses (accumulatePlannedBatchIntoQtyMaps), so a manual reservation and the auto
 * aggregate agree to the last decimal and never double-count.
 */
const { Op } = require('sequelize');
const PlanningBatch = require('./planningBatchModel');
const PlanningExtracted = require('./models');
const { ReservedBatchItem } = require('../fulfillment/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { roundPlanningMaterialQty } = require('./orderKgMath');
const { materialQtyGte } = require('../utils/materialQtyCompare');
const { freeForBatch } = require('../lib/reservedStockPool');

const EPS = 1e-6;

function plainOf(row) {
  return row && typeof row.get === 'function' ? row.get({ plain: true }) : row;
}

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function normalizeCodes(codes) {
  if (!Array.isArray(codes)) return null;
  const set = new Set(codes.map((c) => String(c ?? '').trim()).filter(Boolean));
  return set.size > 0 ? set : null;
}

/** A planning batch whose 0-based index (sequence − 1) is in the PI's sent_batch_indices. */
function isPlanningBatchSent(planPlain, sequence) {
  const sent = Array.isArray(planPlain.sent_batch_indices) ? planPlain.sent_batch_indices : [];
  const idx0 = Number(sequence) - 1;
  return sent.some((x) => Number(x) === idx0);
}

async function loadMaterialMaps() {
  const rms = await RawMaterial.findAll({ attributes: ['id', 'code', 'name'] });
  const pms = await PackMaterial.findAll({ attributes: ['id', 'code', 'description'] });
  const rmByCode = new Map();
  const rmByName = new Map();
  const rmById = new Map();
  for (const rm of rms) {
    if (rm.code) rmByCode.set(String(rm.code), rm);
    if (rm.name) rmByName.set(String(rm.name).trim().toLowerCase(), rm);
    rmById.set(Number(rm.id), rm);
  }
  const pmByCode = new Map();
  const pmByName = new Map();
  const pmById = new Map();
  for (const pm of pms) {
    if (pm.code) pmByCode.set(String(pm.code), pm);
    if (pm.description) pmByName.set(String(pm.description).trim().toLowerCase(), pm);
    pmById.set(Number(pm.id), pm);
  }
  return { rmByCode, rmByName, rmById, pmByCode, pmByName, pmById };
}

/** Per-material planned qty for ONE planning batch, keyed by material id (same math as the auto rebuild). */
function plannedQtyForBatch(bp, planPlain, maps) {
  // Lazy to avoid a load-time cycle (controller.js requires this file for the route handlers).
  const { accumulatePlannedBatchIntoQtyMaps } = require('./controller');
  const plannedRm = new Map();
  const plannedPm = new Map();
  accumulatePlannedBatchIntoQtyMaps(
    bp, planPlain, maps.rmByCode, maps.rmByName, maps.pmByCode, maps.pmByName, plannedRm, plannedPm,
  );
  return { plannedRm, plannedPm };
}

/** Resolve the requested item codes → material ids present in the planned map. codes=null → all. */
function targetMaterialIds(kind, planned, codesFilter, maps) {
  const byCode = kind === 'rm' ? maps.rmByCode : maps.pmByCode;
  if (!codesFilter) return new Set(planned.keys());
  const ids = new Set();
  for (const code of codesFilter) {
    const mat = byCode.get(String(code).trim());
    const id = mat ? Number(mat.id) : NaN;
    if (Number.isFinite(id) && planned.has(id)) ids.add(id);
  }
  return ids;
}

function codeFor(kind, matId, maps) {
  const mat = (kind === 'rm' ? maps.rmById : maps.pmById).get(Number(matId));
  return mat ? String(mat.code || '').trim() : '';
}

/** The production batch this planning batch became once sent (owns reservations after handoff). */
async function linkedProductionBatch(planningBatchId) {
  const { ProductionBatch } = require('../production/models');
  return ProductionBatch.findOne({ where: { planning_batch_id: Number(planningBatchId) } });
}

async function loadContext(planningBatchId) {
  const batch = await PlanningBatch.findByPk(planningBatchId);
  if (!batch) throw httpError('Planning batch not found', 404);
  const bp = plainOf(batch);
  const plan = await PlanningExtracted.findByPk(bp.planning_extracted_id);
  if (!plan) throw httpError('Planning row not found for this batch', 404);
  const planPlain = plainOf(plan);
  const maps = await loadMaterialMaps();
  return { batch, bp, planPlain, maps };
}

/**
 * Reserve selected item codes (or all lines when codes omitted) for one planning batch.
 * @returns {Promise<{ reserved: Array<{code,materialId,quantity,unit}> }>}
 */
async function reservePlanningBatchLines(planningBatchId, kind, codes) {
  const k = kind === 'pm' ? 'pm' : 'rm';
  const { bp, planPlain, maps } = await loadContext(planningBatchId);

  // Once sent, a production batch owns the reservations (send-handoff moved them there). Delegate
  // the popup action to that production batch so it still works and stays single-owner (no double reserve).
  const prod = await linkedProductionBatch(planningBatchId);
  if (prod) {
    const { reserveProductionBatchLines } = require('../production/batchLineReserve');
    const { getBomLinesForBatch } = require('../production/controller');
    const bomMeta = await getBomLinesForBatch(prod.get ? prod.get({ plain: true }) : prod);
    const prodResult = await reserveProductionBatchLines(prod, k, codes, bomMeta);
    // Surface the same {reserved, pending} contract the non-delegated path returns, so callers
    // (and the popup) can report a partly-backed reservation identically either way.
    return {
      reserved: [],
      pending: Array.isArray(prodResult?.pendingReservations) ? prodResult.pendingReservations : [],
      delegatedToProduction: true,
    };
  }
  if (isPlanningBatchSent(planPlain, bp.sequence)) {
    throw httpError('This batch is sent to production but its production batch is not ready yet — try again shortly.', 409);
  }

  const { plannedRm, plannedPm } = plannedQtyForBatch(bp, planPlain, maps);
  const planned = k === 'rm' ? plannedRm : plannedPm;
  const codesFilter = normalizeCodes(codes);
  const targetIds = targetMaterialIds(k, planned, codesFilter, maps);
  if (targetIds.size === 0) throw httpError('No materials to reserve for the selected lines.', 400);

  const unit = k === 'rm' ? 'KG' : 'PCS';

  const existing = await ReservedBatchItem.findAll({
    where: k === 'rm'
      ? { planning_batch_id: Number(planningBatchId), pack_material_id: null }
      : { planning_batch_id: Number(planningBatchId), raw_material_id: null },
  });
  const existingByMat = new Map();
  for (const r of existing) {
    const p = plainOf(r);
    const mid = k === 'rm' ? Number(p.raw_material_id) : Number(p.pack_material_id);
    if (Number.isFinite(mid) && mid > 0) existingByMat.set(mid, r);
  }

  const affectedRm = new Set();
  const affectedPm = new Set();
  const reserved = [];
  const pending = [];
  for (const matId of targetIds) {
    const need = roundPlanningMaterialQty(Number(planned.get(matId)) || 0);
    if (need <= EPS) continue;
    const row = existingByMat.get(matId);
    const cur = row ? Number(plainOf(row).quantity_reserved) || 0 : 0;

    // Reserve as much as the facility can actually back right now; the rest stays PENDING on the
    // same row (quantity_requested − quantity_reserved) and is filled automatically by
    // pendingReservationAllocator as soon as the material lands. Shortage is no longer a blocker:
    // the claim on the material is recorded either way, and FIFO decides who gets arriving stock.
    const { free } = await freeForBatch(k, matId, { planningBatchId: Number(planningBatchId) });
    const backed = roundPlanningMaterialQty(Math.max(cur, Math.min(need, Math.max(0, free))));
    const shortBy = roundPlanningMaterialQty(Math.max(0, need - backed));

    if (row) {
      const p = plainOf(row);
      const curRequested = Number(p.quantity_requested);
      const requested = Number.isFinite(curRequested) ? Math.max(curRequested, need) : need;
      const updates = { quantity_requested: requested };
      if (!materialQtyGte(cur, backed)) updates.quantity_reserved = backed;
      if (!p.is_manual) updates.is_manual = true;
      await row.update(updates);
    } else {
      await ReservedBatchItem.create({
        planning_batch_id: Number(planningBatchId),
        planning_extracted_id: Number(bp.planning_extracted_id),
        raw_material_id: k === 'rm' ? matId : null,
        pack_material_id: k === 'pm' ? matId : null,
        quantity_reserved: backed,
        quantity_requested: need,
        unit,
        is_manual: true,
      });
    }
    if (k === 'rm') affectedRm.add(matId); else affectedPm.add(matId);
    const code = codeFor(k, matId, maps);
    reserved.push({ code, materialId: matId, quantity: backed, requested: need, pending: shortBy, unit });
    if (shortBy > EPS) {
      pending.push({ type: k.toUpperCase(), code: code || `${k.toUpperCase()}#${matId}`, materialId: matId, requested: need, reserved: backed, pending: shortBy, unit });
    }
  }

  const { syncWarehouseReserved } = require('./controller');
  await syncWarehouseReserved([...affectedRm], [...affectedPm]);
  return { reserved, pending };
}

/**
 * Remove manual reservations for the selected item codes on one planning batch.
 * Blocked once the batch is sent to production (then Production owns it).
 * @returns {Promise<{ unreserved: Array<{code,materialId}> }>}
 */
async function unreservePlanningBatchLines(planningBatchId, kind, codes) {
  const k = kind === 'pm' ? 'pm' : 'rm';
  const { bp, planPlain, maps } = await loadContext(planningBatchId);

  // Delegate to the production batch once it exists (single owner after send-handoff). Production's
  // own release guards apply (blocked if connected / dispensed / on an outbound MTR).
  const prod = await linkedProductionBatch(planningBatchId);
  if (prod) {
    const { unreserveProductionBatchLines } = require('../production/batchLineReserve');
    const { getBomLinesForBatch } = require('../production/controller');
    const bomMeta = await getBomLinesForBatch(prod.get ? prod.get({ plain: true }) : prod);
    await unreserveProductionBatchLines(prod, k, codes, bomMeta);
    return { unreserved: [], delegatedToProduction: true };
  }
  if (isPlanningBatchSent(planPlain, bp.sequence)) {
    throw httpError('This batch is sent to production but its production batch is not ready yet — try again shortly.', 409);
  }
  const codesFilter = normalizeCodes(codes);
  if (!codesFilter) throw httpError('Select at least one item to un-reserve.', 400);

  const rows = await ReservedBatchItem.findAll({
    where: k === 'rm'
      ? { planning_batch_id: Number(planningBatchId), pack_material_id: null, raw_material_id: { [Op.ne]: null } }
      : { planning_batch_id: Number(planningBatchId), raw_material_id: null, pack_material_id: { [Op.ne]: null } },
  });

  const affectedRm = new Set();
  const affectedPm = new Set();
  const unreserved = [];
  for (const rbi of rows) {
    const p = plainOf(rbi);
    const matId = k === 'rm' ? Number(p.raw_material_id) : Number(p.pack_material_id);
    const code = codeFor(k, matId, maps);
    if (!code || !codesFilter.has(code)) continue;
    await rbi.destroy();
    if (k === 'rm') affectedRm.add(matId); else affectedPm.add(matId);
    unreserved.push({ code, materialId: matId });
  }

  if (affectedRm.size || affectedPm.size) {
    const { syncWarehouseReserved } = require('./controller');
    await syncWarehouseReserved([...affectedRm], [...affectedPm]);
  }
  return { unreserved };
}

/** Per-batch coverage: required vs reserved per line, so the popup can show this batch's reserved. */
async function computePlanningBatchCoverage(planningBatchId) {
  const { bp, planPlain, maps } = await loadContext(planningBatchId);
  const { plannedRm, plannedPm } = plannedQtyForBatch(bp, planPlain, maps);

  // After send-handoff the reservations live under the production batch — read from there so the
  // popup's reserved figures stay correct for sent batches.
  const prod = await linkedProductionBatch(planningBatchId);
  const reservedWhere = prod
    ? { production_batch_id: prod.id }
    : { planning_batch_id: Number(planningBatchId) };
  const rows = await ReservedBatchItem.findAll({ where: reservedWhere });
  const reservedRm = new Map();
  const reservedPm = new Map();
  // Claimed = what the batch asked for (incl. the not-yet-arrived part). Reserved = stock-backed.
  const claimedRm = new Map();
  const claimedPm = new Map();
  for (const r of rows) {
    const p = plainOf(r);
    const qty = Number(p.quantity_reserved) || 0;
    const req = Number(p.quantity_requested);
    const claimed = Number.isFinite(req) ? Math.max(req, 0) : qty;
    if (p.raw_material_id != null) {
      const mid = Number(p.raw_material_id);
      reservedRm.set(mid, (reservedRm.get(mid) || 0) + qty);
      claimedRm.set(mid, (claimedRm.get(mid) || 0) + claimed);
    } else if (p.pack_material_id != null) {
      const mid = Number(p.pack_material_id);
      reservedPm.set(mid, (reservedPm.get(mid) || 0) + qty);
      claimedPm.set(mid, (claimedPm.get(mid) || 0) + claimed);
    }
  }

  const build = (planned, reservedMap, claimedMap, kind, unit) => {
    const lines = [];
    for (const [matId, req] of planned) {
      const required = roundPlanningMaterialQty(Number(req) || 0);
      const reserved = Number(reservedMap.get(matId) || 0);
      const claimed = Number(claimedMap.get(matId) || 0);
      // Awaiting arrival: claimed but not yet stock-backed. Auto-fills on GRN.
      const pending = roundPlanningMaterialQty(Math.max(0, claimed - reserved));
      lines.push({
        code: codeFor(kind, matId, maps),
        materialId: matId,
        required,
        reserved,
        claimed,
        pending,
        unit,
        fullyReserved: materialQtyGte(reserved, required),
        // The line is fully CLAIMED even while short — the shortfall is queued against arrivals.
        fullyClaimed: materialQtyGte(claimed, required),
      });
    }
    return lines;
  };

  return {
    rm: build(plannedRm, reservedRm, claimedRm, 'rm', 'KG'),
    pm: build(plannedPm, reservedPm, claimedPm, 'pm', 'PCS'),
  };
}

module.exports = {
  reservePlanningBatchLines,
  unreservePlanningBatchLines,
  computePlanningBatchCoverage,
};

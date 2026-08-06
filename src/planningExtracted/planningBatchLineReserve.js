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
    await reserveProductionBatchLines(prod, k, codes, bomMeta);
    return { reserved: [], delegatedToProduction: true };
  }
  if (isPlanningBatchSent(planPlain, bp.sequence)) {
    throw httpError('This batch is sent to production but its production batch is not ready yet — try again shortly.', 409);
  }

  const { plannedRm, plannedPm } = plannedQtyForBatch(bp, planPlain, maps);
  const planned = k === 'rm' ? plannedRm : plannedPm;
  const codesFilter = normalizeCodes(codes);
  const targetIds = targetMaterialIds(k, planned, codesFilter, maps);
  if (targetIds.size === 0) throw httpError('No materials to reserve for the selected lines.', 400);

  // Guard: every requested line must fit the free pool (SIH − reserved by everyone else).
  const shortages = [];
  const unit = k === 'rm' ? 'KG' : 'PCS';
  for (const matId of targetIds) {
    const need = roundPlanningMaterialQty(Number(planned.get(matId)) || 0);
    if (need <= EPS) continue;
    const { sih, other, free } = await freeForBatch(k, matId, { planningBatchId: Number(planningBatchId) });
    if (need > free + EPS) {
      shortages.push({ type: k.toUpperCase(), code: codeFor(k, matId, maps) || `${k.toUpperCase()}#${matId}`, unit, need, free, otherReserved: other, sih });
    }
  }
  if (shortages.length > 0) {
    const summary = shortages.slice(0, 4)
      .map((s) => `${s.code} (need ${s.need} ${s.unit}, free ${s.free} ${s.unit})`).join('; ');
    const more = shortages.length > 4 ? ` (+${shortages.length - 4} more)` : '';
    const err = httpError(`Cannot reserve — stock is already allocated elsewhere. ${summary}${more}`, 409);
    err.reserveShortages = shortages;
    throw err;
  }

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
  for (const matId of targetIds) {
    const qty = roundPlanningMaterialQty(Number(planned.get(matId)) || 0);
    if (qty <= EPS) continue;
    const row = existingByMat.get(matId);
    if (row) {
      const cur = Number(plainOf(row).quantity_reserved) || 0;
      if (!materialQtyGte(cur, qty)) {
        await row.update({ quantity_reserved: qty, is_manual: true });
      } else if (!plainOf(row).is_manual) {
        await row.update({ is_manual: true });
      }
    } else {
      await ReservedBatchItem.create({
        planning_batch_id: Number(planningBatchId),
        planning_extracted_id: Number(bp.planning_extracted_id),
        raw_material_id: k === 'rm' ? matId : null,
        pack_material_id: k === 'pm' ? matId : null,
        quantity_reserved: qty,
        unit,
        is_manual: true,
      });
    }
    if (k === 'rm') affectedRm.add(matId); else affectedPm.add(matId);
    reserved.push({ code: codeFor(k, matId, maps), materialId: matId, quantity: qty, unit });
  }

  const { syncWarehouseReserved } = require('./controller');
  await syncWarehouseReserved([...affectedRm], [...affectedPm]);
  return { reserved };
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
  for (const r of rows) {
    const p = plainOf(r);
    const qty = Number(p.quantity_reserved) || 0;
    if (p.raw_material_id != null) reservedRm.set(Number(p.raw_material_id), (reservedRm.get(Number(p.raw_material_id)) || 0) + qty);
    else if (p.pack_material_id != null) reservedPm.set(Number(p.pack_material_id), (reservedPm.get(Number(p.pack_material_id)) || 0) + qty);
  }

  const build = (planned, reservedMap, kind, unit) => {
    const lines = [];
    for (const [matId, req] of planned) {
      const required = roundPlanningMaterialQty(Number(req) || 0);
      const reserved = Number(reservedMap.get(matId) || 0);
      lines.push({
        code: codeFor(kind, matId, maps),
        materialId: matId,
        required,
        reserved,
        unit,
        fullyReserved: materialQtyGte(reserved, required),
      });
    }
    return lines;
  };

  return {
    rm: build(plannedRm, reservedRm, 'rm', 'KG'),
    pm: build(plannedPm, reservedPm, 'pm', 'PCS'),
  };
}

module.exports = {
  reservePlanningBatchLines,
  unreservePlanningBatchLines,
  computePlanningBatchCoverage,
};

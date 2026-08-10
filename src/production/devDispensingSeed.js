/**
 * TEMPORARY dev/QA utility — seed a batch's dispensing tray so downstream production steps
 * (dispensing → in production → bulk QC → filling → packaging → FG) can be exercised without
 * walking the whole warehouse flow first.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  THIS IS A MOCK. It writes `dispensing_rm` / `dispensing_pm` DIRECTLY and deliberately does NOT
 *  run `applyDispensingDeltaToWarehouseInventory`, so NO stock is consumed, no MTR is required and
 *  no location history is written. Numbers on the tray are real (same BOM math as reservation) but
 *  the material behind them was never actually moved.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Always available — there is no feature flag. Every seeded line carries `devSeeded: true` and the
 * server logs a `[dev-dispensing-seed]` warning, so mock trays stay identifiable in the data.
 *
 * Delete this file, its route, and the UI button once the downstream steps are verified.
 */
const { ProductionBatch } = require('./models');
const { roundPlanningMaterialQty } = require('../planningExtracted/orderKgMath');

/** Batch statuses at or past dispensing — seeding one of these would rewrite real progress. */
const BMR_AT_OR_PAST_DISPENSING = ['dispensing', 'in_production', 'bulk_qc', 'qc_failed', 'cleared'];
const BPR_AT_OR_PAST_DISPENSING = ['pm_dispensing', 'filling', 'fill_qc', 'packaging', 'pack_qc', 'fg_ready'];

function plainOf(row) {
  return row && typeof row.get === 'function' ? row.get({ plain: true }) : row;
}

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/** Any line already carrying dispensed qty — real operator progress we must not clobber. */
function hasRealDispensingProgress(lines) {
  return (Array.isArray(lines) ? lines : []).some((l) => (Number(l?.dispensed) || 0) > 1e-6);
}

/**
 * Build tray lines from the batch BOM using the SAME helpers reservation uses, so a seeded tray
 * and the batch's reserved quantities agree exactly.
 */
async function buildTrayLines(batchPlain, bomMeta, kind, { fill }) {
  const {
    buildRmQuantitiesMap,
    buildPmQuantitiesMap,
  } = require('./batchLineReserve');

  const quantities = kind === 'rm'
    ? await buildRmQuantitiesMap(batchPlain, bomMeta.rmLines, bomMeta.source, bomMeta.batchSizeKg, null)
    : await buildPmQuantitiesMap(batchPlain, bomMeta.pmLines, bomMeta.source, bomMeta.batchSizeKg, null);

  const qtyKindUnit = kind === 'rm' ? 'KG' : 'PCS';
  const stampedAt = new Date().toISOString();

  // Resolve display names up-front — the tray renders `inci || name || code`, so a line without
  // them shows a bare code and the operator cannot tell what the material actually is.
  const RawMaterial = require('../rawMaterials/models');
  const PackMaterial = require('../packMaterials/models');
  const ids = [...quantities.keys()];
  const masters = new Map();
  if (ids.length > 0) {
    const rows = kind === 'rm'
      ? await RawMaterial.findAll({ where: { id: ids }, attributes: ['id', 'name', 'inci'] })
      : await PackMaterial.findAll({ where: { id: ids }, attributes: ['id', 'description'] });
    for (const r of rows) {
      const p = r.get ? r.get({ plain: true }) : r;
      masters.set(Number(p.id), kind === 'rm'
        ? { name: p.name || '', inci: p.inci || '' }
        : { name: p.description || '', inci: '' });
    }
  }

  const lines = [];
  let slot = 0;
  for (const [materialId, meta] of quantities) {
    const required = roundPlanningMaterialQty(Number(meta.quantity) || 0);
    if (required <= 0) continue;
    slot += 1;
    const dispensed = fill === 'full' ? required : 0;
    const master = masters.get(Number(materialId)) || { name: '', inci: '' };
    lines.push({
      code: meta.code,
      name: master.name,
      ...(master.inci ? { inci: master.inci } : {}),
      required,
      dispensed,
      done: fill === 'full',
      unit: meta.unit || qtyKindUnit,
      ...(kind === 'rm' ? { rawMaterialId: materialId } : { packMaterialId: materialId }),
      // Container/slot are what the tray view renders per card.
      trayContainer: `TEST-TRAY-${String(batchPlain.batch_no || batchPlain.bmr_no || 'B')}`.slice(0, 40),
      traySlot: `S${String(slot).padStart(2, '0')}`,
      ...(fill === 'full' ? { dispensedAt: stampedAt } : {}),
      // Breadcrumb so a seeded line is always identifiable in the DB and in exports.
      devSeeded: true,
    });
  }
  return lines;
}

/**
 * Fast-forward one batch onto the dispensing tray.
 *
 * @param {number} batchId production_batches.id
 * @param {object} opts
 * @param {'rm'|'pm'|'both'} [opts.kind='both']  which tray(s) to seed
 * @param {'empty'|'full'}   [opts.fill='empty'] 'empty' = lines with 0 dispensed (operator dispenses
 *                                               them by hand); 'full' = every line marked dispensed
 * @param {boolean} [opts.force=false]           overwrite a tray that already has real progress
 * @param {string}  [opts.muZone]                scheduled MU zone to stamp when the batch has none
 */
async function seedDispensingTray(batchId, opts = {}) {
  const kind = ['rm', 'pm', 'both'].includes(opts.kind) ? opts.kind : 'both';
  const fill = opts.fill === 'full' ? 'full' : 'empty';
  const force = opts.force === true;

  const batch = await ProductionBatch.findByPk(batchId);
  if (!batch) throw httpError('Batch not found', 404);
  const d = plainOf(batch);

  const wantRm = kind === 'rm' || kind === 'both';
  const wantPm = kind === 'pm' || kind === 'both';

  if (!force) {
    if (wantRm && hasRealDispensingProgress(d.dispensing_rm)) {
      throw httpError('This batch already has RM dispensing progress — pass force to overwrite it.', 409);
    }
    if (wantPm && hasRealDispensingProgress(d.dispensing_pm)) {
      throw httpError('This batch already has PM dispensing progress — pass force to overwrite it.', 409);
    }
  }

  const { getBomLinesForBatch } = require('./controller');
  const bomMeta = await getBomLinesForBatch(d);
  if ((bomMeta.rmLines || []).length === 0 && (bomMeta.pmLines || []).length === 0) {
    throw httpError('No BOM lines found for this batch — cannot build a tray.', 400);
  }

  const updates = {};
  const rmLines = wantRm ? await buildTrayLines(d, bomMeta, 'rm', { fill }) : null;
  const pmLines = wantPm ? await buildTrayLines(d, bomMeta, 'pm', { fill }) : null;
  if (rmLines) updates.dispensing_rm = rmLines;
  if (pmLines) updates.dispensing_pm = pmLines;

  // Dispensing consumption needs a scheduled MU; stamp one so the real (non-mock) dispensing
  // screens work on this batch afterwards.
  const muZone = String(d.scheduled_mu_zone || '').trim();
  if (!muZone) {
    const fallback = String(opts.muZone || 'ML1').trim();
    if (fallback) updates.scheduled_mu_zone = fallback;
  }

  // Statuses move FORWARD only — never drag a batch that is already further along back to dispensing.
  if (wantRm && !BMR_AT_OR_PAST_DISPENSING.includes(String(d.bmr_status || ''))) {
    updates.bmr_status = 'dispensing';
    updates.rm_reserved = true;
    updates.rm_connected = true;
  }
  if (wantPm) {
    const bmrAfter = String(updates.bmr_status || d.bmr_status || '').toLowerCase();
    // PM only becomes dispensable once bulk QC is cleared — mirrors the real packaging gate.
    if (bmrAfter === 'cleared' && !BPR_AT_OR_PAST_DISPENSING.includes(String(d.bpr_status || ''))) {
      updates.bpr_status = 'pm_dispensing';
      updates.pm_reserved = true;
      updates.pm_connected = true;
    }
  }

  await batch.update(updates);
  await batch.reload();

  const result = {
    batchId: Number(d.id),
    bmrNo: d.bmr_no,
    bprNo: d.bpr_no,
    kind,
    fill,
    bomSource: bomMeta.source,
    rmLines: rmLines ? rmLines.length : 0,
    pmLines: pmLines ? pmLines.length : 0,
    bmrStatus: batch.get('bmr_status'),
    bprStatus: batch.get('bpr_status'),
    scheduledMuZone: batch.get('scheduled_mu_zone'),
    warehouseStockTouched: false,
    warning:
      'MOCK TRAY — no warehouse stock was consumed and no MTR was required. '
      + 'Quantities are real BOM figures but the material was never moved.',
  };
  console.warn('[dev-dispensing-seed] seeded MOCK tray', result);
  return result;
}

module.exports = { seedDispensingTray };

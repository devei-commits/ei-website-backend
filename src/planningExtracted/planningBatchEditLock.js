/**
 * Planning batch edits (size and BOM) are allowed until the batch's dispensing tray is generated in
 * Production. Sending a batch to Production, confirming the BMR and reserving stock do NOT lock it:
 * reservation coverage is recomputed from the live batch size, so a resize before dispensing just
 * changes what still has to be reserved.
 *
 * "On the dispensing tray" mirrors the Production UI's `isBatchOnDispensingTray`
 * (EI-Admin-Dashboard/src/lib/batchDispensingStatus.ts) — keep the two in sync.
 */
const BMR_ON_DISPENSING_TRAY = ['rm_connected', 'dispensing', 'in_production', 'bulk_qc', 'qc_failed', 'cleared'];
const BPR_ON_DISPENSING_TRAY = ['pm_connected', 'pm_dispensing', 'scheduled', 'filling', 'fill_qc', 'packaging', 'pack_qc', 'fg_ready'];

function normStatus(v) {
  return String(v ?? '').trim().toLowerCase();
}

/**
 * Normalise the linked production batch to `{ bmr_status, bpr_status, dispensing_rm, dispensing_pm }`.
 * Accepts a production row / plain object, or a bare BMR status string.
 */
function productionLockState(prod) {
  if (prod == null) return null;
  if (typeof prod !== 'object') {
    return { bmr_status: prod, bpr_status: null, dispensing_rm: null, dispensing_pm: null };
  }
  const d = typeof prod.get === 'function' ? prod.get({ plain: true }) : prod;
  return {
    bmr_status: d.bmr_status ?? null,
    bpr_status: d.bpr_status ?? null,
    dispensing_rm: d.dispensing_rm ?? null,
    dispensing_pm: d.dispensing_pm ?? null,
  };
}

function isProductionBatchOnDispensingTray(prod) {
  const s = productionLockState(prod);
  if (!s) return false;
  const rmCount = Array.isArray(s.dispensing_rm) ? s.dispensing_rm.length : 0;
  const pmCount = Array.isArray(s.dispensing_pm) ? s.dispensing_pm.length : 0;
  if (rmCount > 0 || pmCount > 0) return true;
  return BMR_ON_DISPENSING_TRAY.includes(normStatus(s.bmr_status))
    || BPR_ON_DISPENSING_TRAY.includes(normStatus(s.bpr_status));
}

/** @param prod linked production batch row (or its BMR status string); null when not sent yet. */
function isPlanningBatchEditableByProduction(prod) {
  return !isProductionBatchOnDispensingTray(prod);
}

function planningBatchEditLockReason(prod) {
  if (isPlanningBatchEditableByProduction(prod)) return null;
  const label = String(productionLockState(prod)?.bmr_status ?? '').trim() || 'dispensing';
  return `Batch dispensing tray is already generated in Production (${label}) and it can no longer be edited.`;
}

/**
 * Production has confirmed the BMR (advanced past `draft`). SO cancellation uses this — it must not
 * silently drop a batch Production has committed to, a stricter bar than Planning's edit lock.
 */
function isProductionBatchConfirmed(bmrStatus) {
  const status = normStatus(bmrStatus);
  return Boolean(status) && status !== 'draft';
}

/**
 * When `updateOnlyBatchId` is set, reject batch-count changes (no create/delete via bulk save).
 */
function validateUpdateOnlyBatchPayload(batches, existing, updateOnlyBatchId) {
  const targetId = Number(updateOnlyBatchId);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    const err = new Error('Invalid updateOnlyBatchId');
    err.status = 400;
    err.code = 'INVALID_UPDATE_ONLY_BATCH_ID';
    throw err;
  }
  const exists = (existing || []).some((row) => {
    const id = row.get ? row.get('id') : row.id;
    return Number(id) === targetId;
  });
  if (!exists) {
    const err = new Error('Batch to update was not found for this planning record.');
    err.status = 404;
    err.code = 'UPDATE_ONLY_BATCH_NOT_FOUND';
    throw err;
  }
  if ((batches || []).length !== (existing || []).length) {
    const err = new Error('Edit batch cannot add or remove planning batches. Update this batch only.');
    err.status = 409;
    err.code = 'BATCH_COUNT_LOCKED';
    throw err;
  }
}

/** Batch sizes are NUMERIC in the DB; compare with a tolerance rather than by equality. */
const SIZE_EPS = 1e-6;

/** The size a batch payload entry is asking for, accepting either camelCase or snake_case. */
function payloadSizeKg(entry) {
  const raw = entry?.sizeKg != null ? entry.sizeKg : entry?.size_kg;
  return raw != null ? Number(raw) : null;
}

/** Parse "200 KG" / "200" into a number. Returns 0 when the order total is unknown. */
function parseTotalKgDisplay(display) {
  return parseFloat(String(display ?? '0').replace(/[^\d.]/g, '')) || 0;
}

function indexSet(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return new Set(arr.map((x) => Number(x)).filter((n) => Number.isFinite(n)));
}

/**
 * A sent batch whose dispensing tray is generated is a commitment: material has been connected or
 * dispensed for that size, so its size must not drift afterwards. Before that point a sent batch may
 * be resized — the caller re-syncs Production's batch_size.
 *
 * @param {Array} batches   incoming payload, positional (index 0 = sequence 1)
 * @param {Array} existing  current planning_batches rows, ordered by sequence
 * @param {*} sentRaw       PI.sent_batch_indices (0-based)
 * @param {(row: any, index: number) => boolean} [isLocked]  whether that sent row is past the
 *   dispensing-tray lock. Omitted → every sent batch is treated as locked.
 */
function assertSentBatchSizesUnchanged(batches, existing, sentRaw, isLocked) {
  const sent = indexSet(sentRaw);
  if (sent.size === 0) return;
  for (let i = 0; i < (existing || []).length; i += 1) {
    if (!sent.has(i)) continue;
    const row = existing[i];
    if (typeof isLocked === 'function' && !isLocked(row, i)) continue;
    const currentSize = Number(row?.get ? row.get('size_kg') : row?.size_kg);
    if (!Number.isFinite(currentSize)) continue;
    const incoming = batches && batches[i] ? payloadSizeKg(batches[i]) : null;
    if (incoming == null || !Number.isFinite(incoming)) continue;
    if (Math.abs(incoming - currentSize) <= SIZE_EPS) continue;
    const code = (row?.get ? row.get('batch_code') : row?.batch_code) || `batch ${i + 1}`;
    const err = new Error(
      `${code} already has its dispensing tray generated at ${currentSize} kg and its size can no longer be changed.`
    );
    err.status = 409;
    err.code = 'SENT_BATCH_SIZE_LOCKED';
    throw err;
  }
}

/**
 * The batch plan must not allocate more than the order asks for.
 *
 * Buffer batches (PI.buffer_batch_indices) are deliberate over-production above the SO qty, so they
 * are excluded from the cap. `addOneBatchFromMaster` already caps a single new batch at the
 * remaining kg; this applies the same ceiling to the bulk save, which had no cap at all and would
 * accept any sizes the client sent.
 *
 * @param {Array} batches       incoming payload, positional
 * @param {string|number} totalKgDisplay  PI.total_kg_display (e.g. "200 KG")
 * @param {*} bufferRaw         PI.buffer_batch_indices (0-based)
 */
function assertBatchPlanWithinOrder(batches, totalKgDisplay, bufferRaw) {
  const totalKg = parseTotalKgDisplay(totalKgDisplay);
  // Unknown order total — nothing to validate against.
  if (!(totalKg > 0)) return;
  const buffer = indexSet(bufferRaw);
  let planned = 0;
  for (let i = 0; i < (batches || []).length; i += 1) {
    if (buffer.has(i)) continue;
    const size = payloadSizeKg(batches[i]);
    if (Number.isFinite(size) && size > 0) planned += size;
  }
  if (planned <= totalKg + SIZE_EPS) return;
  const round = (n) => Math.round(n * 1e6) / 1e6;
  const err = new Error(
    `Batch plan totals ${round(planned)} kg but the order is only ${round(totalKg)} kg. `
      + `Reduce the batch sizes, or mark the extra batches as buffer if this is intentional over-production.`
  );
  err.status = 400;
  err.code = 'BATCH_PLAN_EXCEEDS_ORDER';
  err.plannedKg = round(planned);
  err.orderKg = round(totalKg);
  throw err;
}

module.exports = {
  isPlanningBatchEditableByProduction,
  isProductionBatchOnDispensingTray,
  isProductionBatchConfirmed,
  planningBatchEditLockReason,
  validateUpdateOnlyBatchPayload,
  assertSentBatchSizesUnchanged,
  assertBatchPlanWithinOrder,
  parseTotalKgDisplay,
};

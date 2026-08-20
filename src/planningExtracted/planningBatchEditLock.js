/**
 * Planning batch edits are allowed until Production confirms the linked BMR
 * (`bmr_status` advances past `draft`). After confirmation, quantities are fixed.
 */

function isPlanningBatchEditableByProduction(bmrStatus) {
  const status = String(bmrStatus ?? '').trim().toLowerCase();
  if (!status) return true;
  return status === 'draft';
}

function planningBatchEditLockReason(bmrStatus) {
  if (isPlanningBatchEditableByProduction(bmrStatus)) return null;
  const label = String(bmrStatus ?? '').trim() || 'confirmed';
  return `Batch is confirmed by Production (${label}) and can no longer be edited.`;
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
 * A batch that has been sent to production is a commitment: sending it created the BMR at that
 * size, and the floor is making that amount. Its size must not drift afterwards.
 *
 * The BMR-status lock alone does not cover this — a freshly sent batch sits at `bmr_status: 'draft'`
 * until Production confirms it, and `isPlanningBatchEditableByProduction('draft')` is true. That gap
 * is what let a released 100 kg batch be silently rewritten to 200 kg by a bulk save.
 *
 * @param {Array} batches   incoming payload, positional (index 0 = sequence 1)
 * @param {Array} existing  current planning_batches rows, ordered by sequence
 * @param {*} sentRaw       PI.sent_batch_indices (0-based)
 */
function assertSentBatchSizesUnchanged(batches, existing, sentRaw) {
  const sent = indexSet(sentRaw);
  if (sent.size === 0) return;
  for (let i = 0; i < (existing || []).length; i += 1) {
    if (!sent.has(i)) continue;
    const row = existing[i];
    const currentSize = Number(row?.get ? row.get('size_kg') : row?.size_kg);
    if (!Number.isFinite(currentSize)) continue;
    const incoming = batches && batches[i] ? payloadSizeKg(batches[i]) : null;
    if (incoming == null || !Number.isFinite(incoming)) continue;
    if (Math.abs(incoming - currentSize) <= SIZE_EPS) continue;
    const code = (row?.get ? row.get('batch_code') : row?.batch_code) || `batch ${i + 1}`;
    const err = new Error(
      `${code} is already sent to production at ${currentSize} kg and its size can no longer be changed.`
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
  planningBatchEditLockReason,
  validateUpdateOnlyBatchPayload,
  assertSentBatchSizesUnchanged,
  assertBatchPlanWithinOrder,
  parseTotalKgDisplay,
};

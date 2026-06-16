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

module.exports = {
  isPlanningBatchEditableByProduction,
  planningBatchEditLockReason,
  validateUpdateOnlyBatchPayload,
};

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

module.exports = {
  isPlanningBatchEditableByProduction,
  planningBatchEditLockReason,
};

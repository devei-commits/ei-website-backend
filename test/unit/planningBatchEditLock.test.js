const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isPlanningBatchEditableByProduction,
  isProductionBatchConfirmed,
  planningBatchEditLockReason,
  validateUpdateOnlyBatchPayload,
} = require('../../src/planningExtracted/planningBatchEditLock');

test('isPlanningBatchEditableByProduction allows every status before the dispensing tray', () => {
  assert.equal(isPlanningBatchEditableByProduction(null), true);
  assert.equal(isPlanningBatchEditableByProduction(''), true);
  assert.equal(isPlanningBatchEditableByProduction('draft'), true);
  assert.equal(isPlanningBatchEditableByProduction('batch_confirmed'), true);
  assert.equal(isPlanningBatchEditableByProduction('rm_reserved'), true);
  assert.equal(isPlanningBatchEditableByProduction('scheduled'), true);
  assert.equal(
    isPlanningBatchEditableByProduction({ bmr_status: 'rm_reserved', bpr_status: 'pm_reserved', dispensing_rm: [], dispensing_pm: null }),
    true
  );
});

test('isPlanningBatchEditableByProduction blocks once the dispensing tray is generated', () => {
  assert.equal(isPlanningBatchEditableByProduction('rm_connected'), false);
  assert.equal(isPlanningBatchEditableByProduction('dispensing'), false);
  assert.equal(isPlanningBatchEditableByProduction('in_production'), false);
  assert.equal(isPlanningBatchEditableByProduction('cleared'), false);
  assert.equal(isPlanningBatchEditableByProduction({ bmr_status: 'batch_confirmed', dispensing_rm: [{ code: 'RM1' }] }), false);
  assert.equal(isPlanningBatchEditableByProduction({ bmr_status: 'draft', bpr_status: 'pm_dispensing' }), false);
  assert.equal(isPlanningBatchEditableByProduction({ get: () => ({ bmr_status: 'dispensing' }) }), false);
});

test('isProductionBatchConfirmed keeps the SO-cancel bar at BMR confirmation', () => {
  assert.equal(isProductionBatchConfirmed(null), false);
  assert.equal(isProductionBatchConfirmed('draft'), false);
  assert.equal(isProductionBatchConfirmed('batch_confirmed'), true);
});

test('planningBatchEditLockReason returns message when locked', () => {
  assert.equal(planningBatchEditLockReason('rm_reserved'), null);
  assert.match(planningBatchEditLockReason('dispensing'), /dispensing tray/i);
});

test('validateUpdateOnlyBatchPayload accepts matching batch count', () => {
  const existing = [{ id: 42 }, { id: 99 }];
  assert.doesNotThrow(() => validateUpdateOnlyBatchPayload([{ sizeKg: 100 }, { sizeKg: 200 }], existing, 42));
});

test('validateUpdateOnlyBatchPayload rejects batch count changes', () => {
  const existing = [{ id: 42 }];
  assert.throws(
    () => validateUpdateOnlyBatchPayload([{ sizeKg: 100 }, { sizeKg: 200 }], existing, 42),
    (err) => err.code === 'BATCH_COUNT_LOCKED'
  );
});

test('validateUpdateOnlyBatchPayload rejects unknown batch id', () => {
  const existing = [{ id: 42 }];
  assert.throws(
    () => validateUpdateOnlyBatchPayload([{ sizeKg: 100 }], existing, 77),
    (err) => err.code === 'UPDATE_ONLY_BATCH_NOT_FOUND'
  );
});

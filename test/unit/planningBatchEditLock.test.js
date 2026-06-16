const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isPlanningBatchEditableByProduction,
  planningBatchEditLockReason,
  validateUpdateOnlyBatchPayload,
} = require('../../src/planningExtracted/planningBatchEditLock');

test('isPlanningBatchEditableByProduction allows draft and missing status', () => {
  assert.equal(isPlanningBatchEditableByProduction(null), true);
  assert.equal(isPlanningBatchEditableByProduction(''), true);
  assert.equal(isPlanningBatchEditableByProduction('draft'), true);
});

test('isPlanningBatchEditableByProduction blocks production-confirmed statuses', () => {
  assert.equal(isPlanningBatchEditableByProduction('batch_confirmed'), false);
  assert.equal(isPlanningBatchEditableByProduction('rm_reserved'), false);
  assert.equal(isPlanningBatchEditableByProduction('in_production'), false);
  assert.equal(isPlanningBatchEditableByProduction('cleared'), false);
});

test('planningBatchEditLockReason returns message when locked', () => {
  assert.equal(planningBatchEditLockReason('draft'), null);
  assert.match(planningBatchEditLockReason('batch_confirmed'), /confirmed by Production/i);
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

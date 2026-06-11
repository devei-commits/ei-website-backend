const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isPlanningBatchEditableByProduction,
  planningBatchEditLockReason,
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

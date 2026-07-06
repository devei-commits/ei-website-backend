const {
  proposeVesselSplitSizes,
  assertBatchEligibleForVesselSplit,
  hasDispensingProgress,
} = require('../../src/production/vesselSplitMath');

describe('production vesselSplitMath', () => {
  it('proposes 500 + 300 KG split for 800 KG batch in 500 L vessel', () => {
    const p = proposeVesselSplitSizes(800, 800, 500);
    expect(p.needsSplit).toBe(true);
    expect(p.firstRunKg).toBe(500);
    expect(p.remainderKg).toBe(300);
  });

  it('blocks split after dispensing started', () => {
    expect(hasDispensingProgress([{ dispensed: 1, required: 10 }], [])).toBe(true);
    expect(hasDispensingProgress([{ dispensed: 0, required: 10, done: true }], [])).toBe(true);
    expect(hasDispensingProgress([{ dispensed: 0, required: 10 }], [])).toBe(false);
  });

  it('allows split only before RM connect', () => {
    expect(assertBatchEligibleForVesselSplit({ bmr_status: 'scheduled', bpr_status: 'draft' })).toBeNull();
    expect(assertBatchEligibleForVesselSplit({ bmr_status: 'dispensing', bpr_status: 'draft' })).toMatch(/dispensing/i);
  });
});

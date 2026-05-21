const {
  INTERNAL_MASTER_CODE_CORRECTION_MARGIN,
  nextNumericSuffixAfterMax,
  nextNumericCode,
} = require('../../src/lib/nextNumericMasterCode');

describe('nextNumericMasterCode', () => {
  it('applies correction margin after max suffix', () => {
    expect(INTERNAL_MASTER_CODE_CORRECTION_MARGIN).toBe(300);
    expect(nextNumericSuffixAfterMax(0)).toBe(301);
    expect(nextNumericSuffixAfterMax(42)).toBe(343);
  });

  it('nextNumericCode pads with margin', () => {
    expect(nextNumericCode(['00010', '00042'])).toBe('00343');
    expect(nextNumericCode([])).toBe('00301');
  });
});

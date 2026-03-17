/**
 * Unit tests for production batch volume: computeRequiredVolumeLiters(batchSizeKg, rmLines).
 * Volume = sum over RM lines of (batchSizeKg * pct_w_w/100) / (specific_gravity || 1). Round to 2 decimals.
 */
const { computeRequiredVolumeLiters } = require('../../src/production/controller');

describe('computeRequiredVolumeLiters', () => {
  test('returns null for missing batchSizeKg', () => {
    expect(computeRequiredVolumeLiters(0, [{ pct_w_w: 10, specific_gravity: 1 }])).toBeNull();
    expect(computeRequiredVolumeLiters(null, [{ pct_w_w: 10 }])).toBeNull();
  });

  test('returns null for empty or non-array rmLines', () => {
    expect(computeRequiredVolumeLiters(500, [])).toBeNull();
    expect(computeRequiredVolumeLiters(500, null)).toBeNull();
    expect(computeRequiredVolumeLiters(500, undefined)).toBeNull();
  });

  test('computes volume for single RM line', () => {
    const rmLines = [{ pct_w_w: 100, specific_gravity: 1 }];
    expect(computeRequiredVolumeLiters(500, rmLines)).toBe(500);
  });

  test('computes volume with specific gravity', () => {
    const rmLines = [{ pct_w_w: 100, specific_gravity: 2 }];
    expect(computeRequiredVolumeLiters(500, rmLines)).toBe(250);
  });

  test('sums multiple RM lines and rounds to 2 decimals', () => {
    const rmLines = [
      { pct_w_w: 50, specific_gravity: 1 },
      { pct_w_w: 50, specific_gravity: 1 },
    ];
    expect(computeRequiredVolumeLiters(500, rmLines)).toBe(500);
  });

  test('uses pct fallback (pct) when pct_w_w missing', () => {
    const rmLines = [{ pct: 10, specific_gravity: 1 }];
    expect(computeRequiredVolumeLiters(500, rmLines)).toBe(50);
  });

  test('treats zero or missing specific_gravity as 1', () => {
    const rmLines = [{ pct_w_w: 20, specific_gravity: 0 }];
    expect(computeRequiredVolumeLiters(500, rmLines)).toBe(100);
    const rmLines2 = [{ pct_w_w: 20 }];
    expect(computeRequiredVolumeLiters(500, rmLines2)).toBe(100);
  });

  test('skips zero pct lines', () => {
    const rmLines = [
      { pct_w_w: 50, specific_gravity: 1 },
      { pct_w_w: 0, specific_gravity: 1 },
    ];
    expect(computeRequiredVolumeLiters(500, rmLines)).toBe(250);
  });

  test('realistic BOM: water + glycerin', () => {
    const rmLines = [
      { pct_w_w: 52.3, specific_gravity: 1.0 },
      { pct_w_w: 3, specific_gravity: 1.26 },
    ];
    const vol = computeRequiredVolumeLiters(500, rmLines);
    expect(vol).toBeCloseTo(261.5 + 11.9, 1);
    expect(vol).toBe(Math.round(vol * 100) / 100);
  });

  // --- Edge cases (try to break logic) ---
  test('negative specific_gravity line is skipped', () => {
    const rmLines = [
      { pct_w_w: 50, specific_gravity: 1 },
      { pct_w_w: 50, specific_gravity: -1 },
    ];
    expect(computeRequiredVolumeLiters(500, rmLines)).toBe(250);
  });

  test('all lines skipped (negative sg) returns 0', () => {
    const rmLines = [{ pct_w_w: 100, specific_gravity: -0.5 }];
    const vol = computeRequiredVolumeLiters(500, rmLines);
    expect(vol).toBe(0);
  });

  test('rounding to 2 decimals', () => {
    const rmLines = [{ pct_w_w: 33.33, specific_gravity: 1.11 }];
    const vol = computeRequiredVolumeLiters(500, rmLines);
    expect(vol).toBe(Math.round(vol * 100) / 100);
    expect(Number(vol.toFixed(2))).toBe(vol);
  });

  test('string batchSizeKg is used as number', () => {
    const rmLines = [{ pct_w_w: 100, specific_gravity: 1 }];
    expect(computeRequiredVolumeLiters('500', rmLines)).toBe(500);
  });

  test('batchSizeKg 0 returns null (falsy)', () => {
    expect(computeRequiredVolumeLiters(0, [{ pct_w_w: 10, specific_gravity: 1 }])).toBeNull();
  });
});

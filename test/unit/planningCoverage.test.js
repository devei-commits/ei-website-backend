/**
 * Unit tests for planning items-involved math: RM/PM totalRequired, coverage, surplusShortage.
 */
const {
  computeRmQtyForBatch,
  computeKgPerUnit,
  computeUnitsForBatch,
  computePmQtyForBatch,
  computeCoverage,
  computeSurplusShortage,
} = require('../../src/lib/planningCoverage');

describe('computeRmQtyForBatch', () => {
  test('qty = (sizeKg * pct) / 100', () => {
    expect(computeRmQtyForBatch(500, 10)).toBe(50);
    expect(computeRmQtyForBatch(500, 0)).toBe(0);
    expect(computeRmQtyForBatch(100, 25)).toBe(25);
  });
});

describe('computeKgPerUnit', () => {
  test('kgPerUnit = totalKg / orderQty', () => {
    expect(computeKgPerUnit(7500, 50000)).toBe(0.15);
    expect(computeKgPerUnit(0, 100)).toBe(1);
    expect(computeKgPerUnit(100, 0)).toBe(1);
  });
});

describe('computeUnitsForBatch', () => {
  test('unitsForBatch = sizeKg / kgPerUnit', () => {
    expect(computeUnitsForBatch(500, 0.15)).toBeCloseTo(3333.333, 2);
    expect(computeUnitsForBatch(500, 0)).toBe(0);
  });
});

describe('computePmQtyForBatch', () => {
  test('qty = unitsForBatch * qtyPerUnit', () => {
    expect(computePmQtyForBatch(1000, 1)).toBe(1000);
    expect(computePmQtyForBatch(1000, 2)).toBe(2000);
    expect(computePmQtyForBatch(1000, undefined)).toBe(1000);
  });
});

describe('computeCoverage', () => {
  test('coverage = min(100, round(sih/totalRequired*100))', () => {
    expect(computeCoverage(100, 100)).toBe(100);
    expect(computeCoverage(50, 100)).toBe(50);
    expect(computeCoverage(150, 100)).toBe(100);
    expect(computeCoverage(0, 100)).toBe(0);
  });
  test('totalRequired 0 => 100', () => {
    expect(computeCoverage(50, 0)).toBe(100);
  });
});

describe('computeSurplusShortage', () => {
  test('surplusShortage = sih - totalRequired', () => {
    expect(computeSurplusShortage(100, 80)).toBe(20);
    expect(computeSurplusShortage(50, 80)).toBe(-30);
    expect(computeSurplusShortage(80, 80)).toBe(0);
  });
});

// --- Edge cases ---
describe('planningCoverage edge cases', () => {
  test('computeRmQtyForBatch: negative pct treated as 0', () => {
    expect(computeRmQtyForBatch(100, -5)).toBe(0);
  });
  test('computeKgPerUnit: orderQty 0 returns 1', () => {
    expect(computeKgPerUnit(100, 0)).toBe(1);
  });
  test('computeKgPerUnit: totalKg 0 returns 1', () => {
    expect(computeKgPerUnit(0, 100)).toBe(1);
  });
  test('computeUnitsForBatch: kgPerUnit 0 returns 0', () => {
    expect(computeUnitsForBatch(500, 0)).toBe(0);
  });
  test('computePmQtyForBatch: qtyPerUnit null uses 1', () => {
    expect(computePmQtyForBatch(100, null)).toBe(100);
  });
  test('computeCoverage: negative sih can yield negative coverage', () => {
    expect(computeCoverage(-10, 100)).toBe(-10);
  });
  test('computeSurplusShortage: negative values', () => {
    expect(computeSurplusShortage(-20, 10)).toBe(-30);
  });
});

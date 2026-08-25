/**
 * Products & Batches showed "5 / 1,000 · 100% cov" for a 5 KG batch of a 1,000-unit order — the
 * numerator was KILOGRAMS and the denominator UNITS, and the coverage came from a different figure
 * again. For a 50 KG / 1,000-unit order, 5 kg is 100 units, i.e. "100 / 1,000 · 10% cov".
 */
const {
  parseQtyLabel, kgPerUnitForPlanning, batchUnitsFromKg, coveragePctFromUnits,
} = require('../../src/fulfillment/batchPlannedUnits');

const plan = { order_qty_display: '1000 units', total_kg_display: '50 KG' };

describe('parseQtyLabel', () => {
  it('reads the number out of a display label', () => {
    expect(parseQtyLabel('1000 units')).toBe(1000);
    expect(parseQtyLabel('50 KG')).toBe(50);
    expect(parseQtyLabel('170.96 KG')).toBe(170.96);
  });
  it('is 0 when there is no number', () => {
    expect(parseQtyLabel(null)).toBe(0);
    expect(parseQtyLabel('KG')).toBe(0);
  });
});

describe('kgPerUnitForPlanning', () => {
  it('derives kg per unit from the order', () => {
    expect(kgPerUnitForPlanning(plan)).toBe(0.05);
  });
  it('refuses to divide when either side is missing or zero', () => {
    expect(kgPerUnitForPlanning({ order_qty_display: '0 units', total_kg_display: '50 KG' })).toBe(0);
    expect(kgPerUnitForPlanning({ order_qty_display: '1000 units', total_kg_display: '0 KG' })).toBe(0);
    expect(kgPerUnitForPlanning({})).toBe(0);
    expect(kgPerUnitForPlanning(null)).toBe(0);
  });
});

describe('batchUnitsFromKg', () => {
  it('converts the reported batch sizes to the units the user expected', () => {
    const kgPerUnit = kgPerUnitForPlanning(plan);
    expect(batchUnitsFromKg(5, kgPerUnit)).toBe(100);
    expect(batchUnitsFromKg(10, kgPerUnit)).toBe(200);
  });

  it('rounds to whole units — half a bottle is not shippable', () => {
    expect(batchUnitsFromKg(5.02, 0.05)).toBe(100);
  });

  it('returns null when the ratio is unknown, so the caller can fall back', () => {
    expect(batchUnitsFromKg(5, 0)).toBeNull();
    expect(batchUnitsFromKg(0, 0.05)).toBeNull();
    expect(batchUnitsFromKg(null, 0.05)).toBeNull();
  });
});

describe('coveragePctFromUnits', () => {
  it('computes coverage from units on both sides', () => {
    expect(coveragePctFromUnits(100, 1000)).toBe(10);
    expect(coveragePctFromUnits(200, 1000)).toBe(20);
  });
  it('is 0 rather than NaN or a false 100 when either side is missing', () => {
    expect(coveragePctFromUnits(0, 1000)).toBe(0);
    expect(coveragePctFromUnits(100, 0)).toBe(0);
    expect(coveragePctFromUnits(null, null)).toBe(0);
  });
});

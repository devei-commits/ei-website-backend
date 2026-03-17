/**
 * Unit tests for procurement quotation totals: totalValue = qty * pricePerUnit; order total = sum(items.totalValue).
 */
const { computeItemTotalValue, computeOrderTotalValue } = require('../../src/lib/procurementTotals');

describe('computeItemTotalValue', () => {
  test('returns qty * pricePerUnit', () => {
    expect(computeItemTotalValue(100, 10)).toBe(1000);
    expect(computeItemTotalValue(50, 2.5)).toBe(125);
  });
  test('invalid as 0', () => {
    expect(computeItemTotalValue(null, 10)).toBe(0);
    expect(computeItemTotalValue(10, 'x')).toBe(0);
  });
  test('negative qty or price multiplies', () => {
    expect(computeItemTotalValue(-10, 5)).toBe(-50);
    expect(computeItemTotalValue(10, -5)).toBe(-50);
  });
});

describe('computeOrderTotalValue', () => {
  test('sums items.totalValue', () => {
    const items = [
      { totalValue: 100 },
      { totalValue: 200 },
      { totalValue: 50 },
    ];
    expect(computeOrderTotalValue(items)).toBe(350);
  });
  test('ignores invalid totalValue', () => {
    const items = [
      { totalValue: 100 },
      { totalValue: null },
      { totalValue: 'x' },
    ];
    expect(computeOrderTotalValue(items)).toBe(100);
  });
  test('empty or non-array returns 0', () => {
    expect(computeOrderTotalValue([])).toBe(0);
    expect(computeOrderTotalValue(null)).toBe(0);
  });
  test('undefined items array treated as empty', () => {
    expect(computeOrderTotalValue(undefined)).toBe(0);
  });
});

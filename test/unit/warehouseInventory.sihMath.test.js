/**
 * Unit tests for warehouse SIH formula: computeStockInHand(wh, ml1, ml2) = wh + ml1 + ml2.
 */
const { computeStockInHand } = require('../../src/warehouseInventory/inventoryMath');

describe('computeStockInHand', () => {
  test('sums wh + ml1 + ml2', () => {
    expect(computeStockInHand(100, 10, 5)).toBe(115);
    expect(computeStockInHand(0, 0, 0)).toBe(0);
  });

  test('treats null/undefined as 0', () => {
    expect(computeStockInHand(100, null, undefined)).toBe(100);
  });

  test('handles string numbers', () => {
    expect(computeStockInHand('50', '10', '5')).toBe(65);
  });

  test('negative values are summed (no clamp)', () => {
    expect(computeStockInHand(100, -10, 0)).toBe(90);
  });

  test('NaN/undefined in one arg treated as 0', () => {
    expect(computeStockInHand(100, NaN, 5)).toBe(105);
  });

  test('all zeros', () => {
    expect(computeStockInHand(0, 0, 0)).toBe(0);
  });
});

/**
 * Unit tests for fulfillment: soValue and RM/PM qtyReserved.
 */
const { computeSoValue, computeRmQtyReserved, computePmQtyReserved } = require('../../src/lib/fulfillmentTotals');

describe('computeSoValue', () => {
  test('sums orderedQty * unitPrice', () => {
    const items = [
      { orderedQty: 100, unitPrice: 10 },
      { orderedQty: 50, unitPrice: 20 },
    ];
    expect(computeSoValue(items)).toBe(2000);
  });
  test('empty returns 0', () => {
    expect(computeSoValue([])).toBe(0);
  });
});

describe('computeRmQtyReserved', () => {
  test('uses pct_w_w/100 when quantity missing', () => {
    expect(computeRmQtyReserved({ pct_w_w: 10 }, 500)).toBe(50);
  });
});

describe('computePmQtyReserved', () => {
  test('qty = qty_per_unit * plannedQty', () => {
    expect(computePmQtyReserved({ qty_per_unit: 1 }, 500)).toBe(500);
    expect(computePmQtyReserved({ qty_per_unit: 2 }, 500)).toBe(1000);
  });
});

describe('fulfillmentTotals edge cases', () => {
  test('computeSoValue: missing orderedQty or unitPrice treated as 0', () => {
    expect(computeSoValue([{ orderedQty: 10 }, { unitPrice: 5 }])).toBe(0);
  });
  test('computeRmQtyReserved: plannedQty 0 returns 0', () => {
    expect(computeRmQtyReserved({ pct_w_w: 10 }, 0)).toBe(0);
  });
  test('computeRmQtyReserved: uses quantity when present', () => {
    expect(computeRmQtyReserved({ quantity: 2 }, 100)).toBe(200);
  });
  test('computePmQtyReserved: plannedQty null returns 0', () => {
    expect(computePmQtyReserved({ qty_per_unit: 1 }, null)).toBe(0);
  });
});

const {
  finalizeItemsInvolvedRmRow,
  procurementOrPoLineQtyToKg,
  warehouseNativeQtyToKg,
} = require('../../src/lib/itemsInvolvedRmDisplay');

describe('itemsInvolvedRmDisplay', () => {
  const rmMeta = { uom: 'L', specific_gravity: 1.25 };

  it('converts planning kg fields to litres; keeps warehouse SIH in litres', () => {
    const rowKg = {
      type: 'RM',
      totalRequired: 100,
      plannedQty: 20,
      sih: 12.5,
      inTransit: 5,
      unit: 'KG',
    };
    const out = finalizeItemsInvolvedRmRow(rowKg, rmMeta, {
      sih: 10,
      reserved: 0,
      inTransit: 4,
      whUnit: 'L',
    });
    expect(out.unit).toBe('L');
    expect(out.totalRequired).toBeCloseTo(80, 6);
    expect(out.plannedQty).toBeCloseTo(16, 6);
    expect(out.sih).toBe(10);
    expect(out.inTransit).toBe(4);
    expect(out.surplusShortage).toBeCloseTo(-66, 6);
  });

  it('warehouse native → kg for math', () => {
    expect(warehouseNativeQtyToKg(8, 'L', rmMeta)).toBeCloseTo(10, 6);
  });

  it('sums PR line in primary UoM to kg', () => {
    const kg = procurementOrPoLineQtyToKg(
      { quantity_requested: 50, unit: 'L' },
      rmMeta
    );
    expect(kg).toBeCloseTo(62.5, 6);
  });
});

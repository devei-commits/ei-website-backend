const {
  kgToRmPrimaryQty,
  rmPrimaryQtyToKg,
  applyProcurementRmPrimaryUnits,
  normRmPrimaryUom,
  procurementLineQtyInPrimary,
  resolveProcurementLineUnit,
} = require('../../src/lib/rmUnitConversion');

describe('rmUnitConversion', () => {
  it('normalizes primary UoM aliases', () => {
    expect(normRmPrimaryUom('ltr')).toBe('L');
    expect(normRmPrimaryUom('KG')).toBe('KG');
  });

  it('converts kg ↔ litres via specific gravity', () => {
    expect(kgToRmPrimaryQty(10, 'L', 1.25)).toBeCloseTo(8, 6);
    expect(rmPrimaryQtyToKg(8, 'L', 1.25)).toBeCloseTo(10, 6);
  });

  it('procurementLineQtyInPrimary converts kg PR line to litres', () => {
    const rmMeta = { uom: 'L', specific_gravity: 1.25 };
    const q = procurementLineQtyInPrimary(
      { quantity_requested: 62.5, unit: 'KG' },
      rmMeta
    );
    expect(q).toBeCloseTo(50, 6);
  });

  it('resolveProcurementLineUnit uses RM master map', () => {
    const map = new Map([[3, 'L']]);
    expect(resolveProcurementLineUnit({ raw_material_id: 3, type: 'RM' }, map)).toBe('L');
  });

  it('converts planning kg lines to RM primary on procurement persist', () => {
    const rmMap = new Map([[1, { uom: 'L', specific_gravity: 1.0 }]]);
    const out = applyProcurementRmPrimaryUnits(
      [{ type: 'RM', raw_material_id: 1, quantity_requested: 100, unit: 'KG' }],
      rmMap
    );
    expect(out[0].unit).toBe('L');
    expect(out[0].quantity_requested).toBeCloseTo(100, 6);
  });
});

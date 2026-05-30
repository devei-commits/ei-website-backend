const {
  applyAquaSkuFromQsName,
  isAquaQsFillerName,
  isAquaQsStoredFormulaLine,
  buildFormulaPctRmLine,
  AQUA_RM_INTERNAL_CODE,
} = require('../../src/products/aquaRmSku');

describe('aquaRmSku', () => {
  test('isAquaQsFillerName matches q.s. aqua label', () => {
    expect(isAquaQsFillerName('AQUA (q.s. to 100%)')).toBe(true);
    expect(isAquaQsFillerName('Aqua')).toBe(false);
  });

  test('applyAquaSkuFromQsName returns 1000612 for filler name', () => {
    expect(applyAquaSkuFromQsName('', 'AQUA (q.s. to 100%)')).toBe(AQUA_RM_INTERNAL_CODE);
    expect(applyAquaSkuFromQsName('RM-OTHER', 'Niacinamide')).toBe('RM-OTHER');
  });

  test('buildFormulaPctRmLine never keeps Excel q.s. label on the line', () => {
    const line = buildFormulaPctRmLine(
      { component_name: 'AQUA (q.s. to 100%)', component_sku: '' },
      null,
      97,
      'KG'
    );
    expect(line.inci_name).not.toMatch(/q\.s\./i);
    expect(line.rm_code).toBe(AQUA_RM_INTERNAL_CODE);
    expect(isAquaQsStoredFormulaLine(line)).toBe(false);
  });
});

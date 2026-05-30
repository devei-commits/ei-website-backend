const { groupUsesFormulaPctImport } = require('../../src/products/formulaRmBomExcelUpload');

describe('formulaRmBom pct import detection', () => {
  it('uses pct path when qty is zero and pct_w_w is set', () => {
    const rows = [
      { qty: 0, pct_w_w: 85, component_sku: 'A' },
      { qty: 0, pct_w_w: 15, component_sku: 'B' },
    ];
    expect(groupUsesFormulaPctImport(rows)).toBe(true);
  });

  it('uses legacy path when qty per unit is positive', () => {
    const rows = [{ qty: 0.85, pct_w_w: undefined, component_sku: 'A' }];
    expect(groupUsesFormulaPctImport(rows)).toBe(false);
  });
});

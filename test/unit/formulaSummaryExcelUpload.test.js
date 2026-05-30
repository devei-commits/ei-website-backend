const {
  computeProductSgFromTotalRmGm,
  mergeBomNotesPrSubCategory,
  skuBomLimitFromSummaryRow,
  normalizePackSizeUom,
} = require('../../src/products/formulaBomProductResolve');

describe('formulaSummary helpers', () => {
  describe('computeProductSgFromTotalRmGm', () => {
    it('computes SG as Total RM GM / Pack Size', () => {
      expect(computeProductSgFromTotalRmGm(33, 30)).toBeCloseTo(1.1, 3);
    });

    it('returns null when pack size is zero', () => {
      expect(computeProductSgFromTotalRmGm(33, 0)).toBeNull();
    });

    it('returns null when total RM is missing or non-positive', () => {
      expect(computeProductSgFromTotalRmGm(null, 30)).toBeNull();
      expect(computeProductSgFromTotalRmGm(-5, 30)).toBeNull();
    });
  });

  describe('mergeBomNotesPrSubCategory', () => {
    it('sets PR Sub-category while preserving other note segments', () => {
      const existing = 'QC Group: A | PR Sub-category: Old | Microbial Limits: TVC';
      const merged = mergeBomNotesPrSubCategory(existing, 'Serum');
      expect(merged).toContain('QC Group: A');
      expect(merged).toContain('PR Sub-category: Serum');
      expect(merged).toContain('Microbial Limits: TVC');
      expect(merged).not.toContain('Old');
    });

    it('returns null when all segments empty', () => {
      expect(mergeBomNotesPrSubCategory(null, '')).toBeNull();
    });
  });

  describe('skuBomLimitFromSummaryRow', () => {
    it('normalizes G to GM for SKU BOM limit', () => {
      const lim = skuBomLimitFromSummaryRow({ pack_size: 50, unit: 'G' });
      expect(lim).toEqual({ qty: 50, uom: 'GM' });
    });

    it('accepts ML pack unit', () => {
      const lim = skuBomLimitFromSummaryRow({ pack_size: 30, unit: 'ML' });
      expect(lim).toEqual({ qty: 30, uom: 'ML' });
    });

    it('returns null for invalid pack', () => {
      expect(skuBomLimitFromSummaryRow({ pack_size: 0, unit: 'ML' })).toBeNull();
    });
  });

  describe('normalizePackSizeUom', () => {
    it('normalizes litre aliases', () => {
      expect(normalizePackSizeUom('ltr')).toBe('L');
      expect(normalizePackSizeUom('KG')).toBe('KG');
    });
  });
});

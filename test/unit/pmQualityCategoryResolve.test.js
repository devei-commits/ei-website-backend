/**
 * PM quality-category resolution.
 *
 * Regression: when an item's type was not in the item-type map, the resolver echoed the raw master
 * text back as if it were a category — putting 74% of pack materials (1,916 of 2,593) into phantom
 * categories the Spec Rules screen never offers ("Labels", "Packaging - Primary",
 * "Other Components", "Shrink Sleeves"), so no category rule could ever reach them.
 */
const {
  resolvePmQualitySpecFunctionalCategory,
  resolvePmQualitySpecCategoryFromRow,
} = require('../../src/qualitySpecRules/pmCategoryResolve');

const OFFERED = ['Primary Pack', 'Closures & Pumps', 'Secondary Pack', 'Tertiary Pack', 'Ancillary'];
const cat = (pmSkuCategory, optionalPmSubCategory) =>
  resolvePmQualitySpecFunctionalCategory({ pmSkuCategory, optionalPmSubCategory });

describe('resolvePmQualitySpecFunctionalCategory', () => {
  it('maps a known item type to its functional category', () => {
    expect(cat('ppm', 'BOTTLES')).toBe('Primary Pack');
    expect(cat('ppm', 'CAPS')).toBe('Closures & Pumps');
    expect(cat('spm-monocarton', 'LOCK BOTTOM')).toBe('Secondary Pack');
    expect(cat('tpm-tertiary', 'SHIPPERS')).toBe('Tertiary Pack');
    expect(cat('tpm-ancillary', 'SPATULAS')).toBe('Ancillary');
  });

  it('falls back to the SKU series instead of echoing an unrecognised label', () => {
    // "Labels" is what 922 real items carry; it is not an item type in any series.
    expect(cat('spm-labels', 'Labels')).toBe('Secondary Pack');
    expect(cat('spm-other', 'Shrink Sleeves')).toBe('Secondary Pack');
    expect(cat('tpm-ancillary', 'Other Components')).toBe('Ancillary');
  });

  it('never returns a category the Spec Rules screen does not offer', () => {
    const probes = [
      ['spm-labels', 'Labels'], ['spm-labels', ''], ['ppm', 'Packaging - Primary'],
      ['spm-other', 'Other Components'], ['tpm-tertiary', 'Packing Material'],
      ['ppm', ''], ['ppm', 'something nobody mapped'],
    ];
    for (const [slug, sub] of probes) {
      const c = cat(slug, sub);
      expect(OFFERED).toContain(c);
    }
  });

  it('defaults a ppm item of unknown type to Primary Pack, its series default', () => {
    expect(cat('ppm', 'no such type')).toBe('Primary Pack');
  });
});

describe('resolvePmQualitySpecCategoryFromRow — sub-category', () => {
  const row = (pmSkuCategory, optionalPmSubCategory) => ({
    group: pmSkuCategory,
    material: '',
    form_data: { pmSkuCategory, optionalPmSubCategory },
  });

  it('resolves the item type as the sub-category, so PM sub-category rules can match', () => {
    expect(resolvePmQualitySpecCategoryFromRow(row('ppm', 'BOTTLES')))
      .toEqual({ category: 'Primary Pack', subCategory: 'BOTTLES' });
    expect(resolvePmQualitySpecCategoryFromRow(row('spm-monocarton', 'LOCK BOTTOM')))
      .toEqual({ category: 'Secondary Pack', subCategory: 'LOCK BOTTOM' });
  });

  it('keeps the value the master actually stores when it is not a schema item type', () => {
    // 922 real items show "Labels" on the master. Blanking it made that scope un-targetable, so a
    // rule written against what the user reads on the item matched nothing.
    const out = resolvePmQualitySpecCategoryFromRow(row('spm-labels', 'Labels'));
    expect(out.category).toBe('Secondary Pack');
    expect(out.subCategory).toBe('Labels');
  });

  it('trims stray whitespace rather than creating a near-duplicate scope', () => {
    expect(resolvePmQualitySpecCategoryFromRow(row('spm-labels', '  Labels  ')).subCategory).toBe('Labels');
  });

  it('reports no sub-category when the master records none', () => {
    expect(resolvePmQualitySpecCategoryFromRow(row('spm-labels', '')).subCategory).toBe('');
  });
});

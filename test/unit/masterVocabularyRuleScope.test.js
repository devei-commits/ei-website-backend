/**
 * Spec rules can be written in the MASTERS' vocabulary ('RAW MATERIALS' → 'SURFACTANTS' → 'ANIONIC')
 * as well as the legacy functional one ('Surfactant'), because only the former appears on the item
 * forms. Both ladders resolve, so no existing rule is orphaned.
 */
const { resolveRmMasterScopeFromRow } = require('../../src/qualitySpecRules/rmCategoryResolve');
const { resolvePmMasterScopeFromRow } = require('../../src/qualitySpecRules/pmCategoryResolve');

describe('resolveRmMasterScopeFromRow', () => {
  it('reports the vocabulary the RM master form shows', () => {
    const row = {
      category: 'RAW MATERIALS',
      group: null,
      form_data: { optionalRmSubCategory: 'SURFACTANTS', optionalRmSubSubCategory: 'ANIONIC' },
    };
    expect(resolveRmMasterScopeFromRow(row)).toEqual({
      category: 'RAW MATERIALS',
      subCategory: 'SURFACTANTS',
      subSubCategory: 'ANIONIC',
    });
  });

  it('still reports a category when the item has no sub-category — the common case', () => {
    // CLUB00034: category "Raw Material", nothing else set. 944 RM rows look like this, and none of
    // them resolved to a legacy functional category at all.
    const out = resolveRmMasterScopeFromRow({ category: 'Raw Material', group: null, form_data: {} });
    expect(out.category).toBe('RAW MATERIALS');
    expect(out.subCategory).toBe('');
  });

  it('does not invent a scope for a row with nothing to go on', () => {
    expect(resolveRmMasterScopeFromRow({ category: '', group: null, form_data: {} }).category).toBe('');
  });
});

describe('resolvePmMasterScopeFromRow', () => {
  it('reports the SKU series label and item type the PM form shows', () => {
    const row = { group: 'spm-labels', material: '', form_data: { pmSkuCategory: 'spm-labels', optionalPmSubCategory: 'SHEET FORM' } };
    expect(resolvePmMasterScopeFromRow(row)).toEqual({
      category: 'SPM — Labels (5LXXXXX)',
      subCategory: 'SHEET FORM',
      subSubCategory: '',
    });
  });

  it('keeps a legacy imported sub-category rather than blanking it', () => {
    const row = { group: 'spm-labels', material: 'Labels', form_data: { pmSkuCategory: 'spm-labels', optionalPmSubCategory: 'Labels' } };
    const out = resolvePmMasterScopeFromRow(row);
    expect(out.category).toBe('SPM — Labels (5LXXXXX)');
    expect(out.subCategory).toBe('Labels');
  });

  it('defaults an unrecognised series to the primary label rather than an empty scope', () => {
    expect(resolvePmMasterScopeFromRow({ group: '', material: '', form_data: {} }).category)
      .toBe('PPM — Primary (4XXXXX)');
  });
});

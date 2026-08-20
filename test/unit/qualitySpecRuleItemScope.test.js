/**
 * Quality Spec Rules gained a fourth, most-specific scope: a rule written against one item code.
 * It has to beat every category-ladder rule that reaches that item, in the masters and in QC.
 */
const {
  mergeQualitySpecRuleRows,
  layerQualitySpecRuleRows,
} = require('../../src/qualitySpecRules/resolver');

const row = (parameter, specLimit) => ({ parameter, specLimit });
const params = (rows) => rows.map((r) => `${r.parameter}=${r.specLimit}`);

describe('mergeQualitySpecRuleRows — item scope', () => {
  const common = [row('pH', '5-7'), row('Colour', 'White')];
  const sub = [row('pH', '6-7')];
  const subSub = [row('pH', '6.2-6.8')];

  it('lets an item rule override every category-ladder rung', () => {
    const merged = mergeQualitySpecRuleRows(common, sub, subSub, [row('pH', '6.5')]);
    expect(params(merged)).toEqual(['Colour=White', 'pH=6.5']);
  });

  it('adds parameters no category rule defines', () => {
    const merged = mergeQualitySpecRuleRows(common, sub, subSub, [row('Assay', '99%')]);
    expect(params(merged)).toContain('Assay=99%');
    expect(params(merged)).toContain('pH=6.2-6.8'); // sub-sub still wins where the item is silent
  });

  it('keeps category rows the item rule does not mention', () => {
    const merged = mergeQualitySpecRuleRows(common, [], null, [row('pH', '6.5')]);
    expect(params(merged)).toEqual(['Colour=White', 'pH=6.5']);
  });

  it('is unchanged when no item rule exists — the pre-existing three-rung behaviour', () => {
    expect(params(mergeQualitySpecRuleRows(common, sub, subSub))).toEqual(['Colour=White', 'pH=6.2-6.8']);
    expect(params(mergeQualitySpecRuleRows(common, sub, subSub, null))).toEqual(['Colour=White', 'pH=6.2-6.8']);
    expect(params(mergeQualitySpecRuleRows(common, sub, subSub, []))).toEqual(['Colour=White', 'pH=6.2-6.8']);
  });

  it('matches parameters case- and whitespace-insensitively when overriding', () => {
    const merged = mergeQualitySpecRuleRows([row('pH', '5-7')], [], null, [row('  PH  ', '6.5')]);
    expect(merged).toHaveLength(1);
    expect(merged[0].specLimit).toBe('6.5');
  });

  it('an item rule alone resolves to just its own rows', () => {
    expect(params(mergeQualitySpecRuleRows([], [], null, [row('Assay', '99%')]))).toEqual(['Assay=99%']);
  });
});

describe('layerQualitySpecRuleRows', () => {
  it('drops the base row a later rung redefines rather than showing the parameter twice', () => {
    const out = layerQualitySpecRuleRows([row('pH', '5-7')], [row('pH', '6.5')]);
    expect(out).toHaveLength(1);
    expect(out[0].specLimit).toBe('6.5');
  });

  it('ignores rows with no parameter name instead of collapsing them together', () => {
    const out = layerQualitySpecRuleRows([row('', 'x'), row('pH', '5-7')], [row('', 'y')]);
    expect(out.filter((r) => r.parameter === 'pH')).toHaveLength(1);
  });
});

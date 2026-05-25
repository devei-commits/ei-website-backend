const { askMergeKey, materialMergeKey } = require('../../src/planningQuotationAsks/mergeKey');

describe('planningQuotationAsk mergeKey', () => {
  it('materialMergeKey prefers raw_material_id for RM', () => {
    expect(materialMergeKey('RM', 42, null, 'RM-001')).toBe('rm:42');
  });

  it('materialMergeKey prefers pack_material_id for PM', () => {
    expect(materialMergeKey('PM', null, 7, 'PM-001')).toBe('pm:7');
  });

  it('askMergeKey includes vendor and moq hints', () => {
    const key = askMergeKey({
      item_type: 'RM',
      raw_material_id: 10,
      pack_material_id: null,
      item_code: 'X',
      vendor_hint: 'Acme Corp',
      moq_hint: 100,
    });
    expect(key).toBe('rm:10|||acme corp|||100');
  });

  it('askMergeKey treats empty moq as blank segment', () => {
    const key = askMergeKey({
      item_type: 'RM',
      raw_material_id: 10,
      vendor_hint: '',
      moq_hint: null,
    });
    expect(key).toBe('rm:10||||||');
  });
});

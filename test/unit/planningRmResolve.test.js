const {
  resolveRmIdFromPlanningLine,
  resolveRmIdFromMaterialSnapshotRow,
} = require('../../src/lib/planningRmResolve');

describe('resolveRmIdFromPlanningLine', () => {
  const rmByCode = new Map([
    ['RM-A', { id: 1 }],
    ['RM-B', { id: 2 }],
  ]);
  const rmByName = new Map([
    ['ingredient a', { id: 1 }],
    ['ingredient b', { id: 2 }],
  ]);

  test('prefers rm_code over stale raw_material_id after swap', () => {
    expect(
      resolveRmIdFromPlanningLine(
        { raw_material_id: 1, rm_code: 'RM-B', inci_name: 'Ingredient A' },
        rmByCode,
        rmByName
      )
    ).toBe(2);
  });

  test('uses raw_material_id when code missing', () => {
    expect(resolveRmIdFromPlanningLine({ raw_material_id: 2 }, rmByCode, rmByName)).toBe(2);
  });

  test('falls back to name when code and id missing', () => {
    expect(
      resolveRmIdFromPlanningLine({ inci_name: 'Ingredient B' }, rmByCode, rmByName)
    ).toBe(2);
  });
});

describe('resolveRmIdFromMaterialSnapshotRow', () => {
  const rmByCode = new Map([['RM-B', { id: 2 }]]);

  test('prefers code over stale raw_material_id on snapshot rows', () => {
    expect(
      resolveRmIdFromMaterialSnapshotRow(
        { raw_material_id: 1, code: 'RM-B', name: 'Old name' },
        rmByCode,
        new Map()
      )
    ).toBe(2);
  });
});

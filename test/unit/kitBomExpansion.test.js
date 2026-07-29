const {
  isKitRmLines,
  collectKitSubProductIds,
  expandKitToMaterialRows,
} = require('../../src/planningExtracted/kitBomExpansion');

describe('isKitRmLines', () => {
  test('true for explicit PR-typed lines', () => {
    expect(isKitRmLines([{ type: 'PR', product_id: 5, units_per_kit: 1 }])).toBe(true);
  });

  test('true for product_id lines with no rm identity', () => {
    expect(isKitRmLines([{ product_id: 9, units_per_kit: 2 }])).toBe(true);
  });

  test('false for normal raw-material formula lines', () => {
    expect(isKitRmLines([{ rm_code: 'RM-A', pct_w_w: 10, raw_material_id: 1 }])).toBe(false);
  });

  test('false for empty / non-array', () => {
    expect(isKitRmLines([])).toBe(false);
    expect(isKitRmLines(null)).toBe(false);
  });
});

describe('collectKitSubProductIds', () => {
  test('unique, valid ids only', () => {
    expect(
      collectKitSubProductIds([
        { product_id: 3 },
        { product_id: 3 },
        { product_id: 7 },
        { product_id: 0 },
        { product_id: null },
      ])
    ).toEqual([3, 7]);
  });
});

describe('expandKitToMaterialRows', () => {
  // Sub-PR 101 "Serum": 1 unit needs 50 GM of RM-A + 1 bottle PM-BOTTLE.
  // Sub-PR 202 "Cream": 1 unit needs 30 GM of RM-A (shared) + 20 GM RM-C + 1 jar PM-JAR.
  const subBomMap = new Map([
    [101, {
      product_id: 101,
      is_kit: false,
      sku_rm_lines: [{ rm_code: 'RM-A', raw_material_id: 1, qty_per_unit: 50, uom: 'GM' }],
      pm_lines: [{ pm_code: 'PM-BOTTLE', pack_material_id: 11, qty_per_unit: 1 }],
    }],
    [202, {
      product_id: 202,
      is_kit: false,
      sku_rm_lines: [
        { rm_code: 'RM-A', raw_material_id: 1, qty_per_unit: 30, uom: 'GM' },
        { rm_code: 'RM-C', raw_material_id: 3, qty_per_unit: 20, uom: 'GM' },
      ],
      pm_lines: [{ pm_code: 'PM-JAR', pack_material_id: 22, qty_per_unit: 1 }],
    }],
  ]);

  // Kit = 1x Serum + 1x Cream + 1 outer box (PM-BOX) per kit.
  const kitRmLines = [
    { type: 'PR', product_id: 101, units_per_kit: 1 },
    { type: 'PR', product_id: 202, units_per_kit: 1 },
  ];
  const kitPmLines = [{ pm_code: 'PM-BOX', pack_material_id: 33, qty_per_unit: 1 }];

  test('expands sub-PR RM (kg) aggregating shared materials across sub-PRs', () => {
    const { raw_materials } = expandKitToMaterialRows(kitRmLines, kitPmLines, 10, subBomMap);
    const byCode = Object.fromEntries(raw_materials.map((r) => [r.code, r]));
    // RM-A: (50 + 30) GM/kit × 10 kits = 800 GM = 0.8 kg
    expect(byCode['RM-A'].quantity).toBeCloseTo(0.8, 6);
    expect(byCode['RM-A'].unit).toBe('KG');
    expect(byCode['RM-A'].raw_material_id).toBe(1);
    // RM-C: 20 GM × 10 = 200 GM = 0.2 kg
    expect(byCode['RM-C'].quantity).toBeCloseTo(0.2, 6);
    // Only two distinct RMs (shared RM-A aggregated).
    expect(raw_materials).toHaveLength(2);
  });

  test('expands sub-PR PM + kit outer packaging (pcs)', () => {
    const { packaging_materials } = expandKitToMaterialRows(kitRmLines, kitPmLines, 10, subBomMap);
    const byCode = Object.fromEntries(packaging_materials.map((p) => [p.code, p]));
    expect(byCode['PM-BOTTLE'].quantity).toBe(10); // 1 × 1 × 10
    expect(byCode['PM-JAR'].quantity).toBe(10);
    expect(byCode['PM-BOX'].quantity).toBe(10); // kit's own outer packaging
    expect(byCode['PM-BOX'].unit).toBe('PCS');
    expect(packaging_materials).toHaveLength(3);
  });

  test('units_per_kit scales sub-material demand', () => {
    const twoSerumsPerKit = [{ type: 'PR', product_id: 101, units_per_kit: 2 }];
    const { raw_materials, packaging_materials } = expandKitToMaterialRows(
      twoSerumsPerKit,
      [],
      5,
      subBomMap
    );
    // RM-A: 50 GM × (5 kits × 2 per kit) = 500 GM = 0.5 kg
    expect(raw_materials[0].quantity).toBeCloseTo(0.5, 6);
    // PM-BOTTLE: 1 × (5 × 2) = 10
    expect(packaging_materials[0].quantity).toBe(10);
  });

  test('missing sub-PR in map contributes nothing (graceful)', () => {
    const { raw_materials, packaging_materials } = expandKitToMaterialRows(
      [{ type: 'PR', product_id: 999, units_per_kit: 1 }],
      [],
      10,
      subBomMap
    );
    expect(raw_materials).toHaveLength(0);
    expect(packaging_materials).toHaveLength(0);
  });
});

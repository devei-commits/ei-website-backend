const path = require('path');

const orderKgMath = require(path.join(__dirname, '../../src/planningExtracted/orderKgMath'));

const {
  parseFillSizeToKgPerUnit,
  estimateOrderTotalKg,
  buildPlanningSnapshotFromBom,
  buildPlanningKgFromSoLine,
  batchesRequiredForOrderKg,
  roundPlanningMaterialQty,
  PLANNING_MATERIAL_QTY_DECIMALS,
} = orderKgMath;

describe('orderKgMath', () => {
  it('roundPlanningMaterialQty keeps up to 8 decimal places', () => {
    expect(PLANNING_MATERIAL_QTY_DECIMALS).toBe(8);
    const tiny = 0.12345678901234567;
    expect(roundPlanningMaterialQty(tiny)).toBe(Number(tiny.toFixed(8)));
  });

  it('50 ml per unit × SG 1 → 0.05 kg/unit; 1000 units → 50 kg FG', () => {
    expect(parseFillSizeToKgPerUnit('50 ml', 1)).toBeCloseTo(0.05, 6);
    const total = estimateOrderTotalKg({
      orderQty: 1000,
      product: { sku_bom_limit_qty: 50, sku_bom_limit_uom: 'ML' },
      rmLines: [],
      batchSizeKg: 100,
      batchesRequired: 1,
    });
    expect(total).toBeCloseTo(50, 3);
  });

  it('RM required = pct × total FG kg (30% / 70% of 50 kg)', () => {
    const { raw_materials } = buildPlanningSnapshotFromBom(
      [
        { pct_w_w: 30, rm_code: 'A', inci_name: 'RM A' },
        { pct_w_w: 70, rm_code: 'B', inci_name: 'RM B' },
      ],
      [],
      1000,
      50,
      100,
    );
    expect(raw_materials[0].quantity).toBe(15);
    expect(raw_materials[1].quantity).toBe(35);
  });

  it('batchesRequiredForOrderKg rounds up FG kg to manufacturing batch size', () => {
    expect(batchesRequiredForOrderKg(50, 100)).toBe(1);
    expect(batchesRequiredForOrderKg(150, 100)).toBe(2);
  });

  it('SO form pack overrides empty product fill_size (avoids RM-line fallback)', () => {
    const { safeTotalKg, raw_materials } = buildPlanningKgFromSoLine({
      orderQty: 1000,
      product: { fill_size: '', batch_size_kg: 100 },
      rmLines: [
        { pct_w_w: 30, rm_code: 'A', inci_name: 'RM A' },
        { pct_w_w: 70, rm_code: 'B', inci_name: 'RM B' },
      ],
      pmLines: [],
      fillSizeOverride: '50 ml',
    });
    expect(safeTotalKg).toBeCloseTo(50, 3);
    expect(raw_materials[0].quantity).toBe(15);
    expect(raw_materials[1].quantity).toBe(35);
  });

  it('SO form pack takes precedence over product fill_size when both set', () => {
    const total = estimateOrderTotalKg({
      orderQty: 100,
      product: { fill_size: '100g' },
      rmLines: [],
      batchSizeKg: 100,
      batchesRequired: 1,
      fillSizeOverride: '50 ml',
    });
    expect(total).toBeCloseTo(5, 3);
  });
});

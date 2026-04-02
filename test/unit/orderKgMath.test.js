const path = require('path');

const orderKgMath = require(path.join(__dirname, '../../src/planningExtracted/orderKgMath'));

const {
  parseFillSizeToKgPerUnit,
  estimateOrderTotalKg,
  buildPlanningSnapshotFromBom,
  batchesRequiredForOrderKg,
} = orderKgMath;

describe('orderKgMath', () => {
  it('50 ml per unit × SG 1 → 0.05 kg/unit; 1000 units → 50 kg FG', () => {
    expect(parseFillSizeToKgPerUnit('50 ml', 1)).toBeCloseTo(0.05, 6);
    const total = estimateOrderTotalKg({
      orderQty: 1000,
      product: { fill_size: '50 ml' },
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
});

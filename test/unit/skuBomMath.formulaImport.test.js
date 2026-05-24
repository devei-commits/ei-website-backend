const path = require('path');

const {
  formulaRowsToSkuBomLines,
  flattenFormulaBomPhases,
  validateSkuBomTotals,
  validateFormulaPctNotOver100,
} = require(path.join(__dirname, '../../src/bom/skuBomMath'));

describe('formulaRowsToSkuBomLines', () => {
  it('50 GM limit, 30% + 70% → 15 GM + 35 GM', () => {
    const res = formulaRowsToSkuBomLines({
      formulaLines: [
        { inci_name: 'RM A', rm_code: 'A', pct_w_w: 30 },
        { inci_name: 'RM B', rm_code: 'B', pct_w_w: 70 },
      ],
      limitQty: 50,
      limitUom: 'GM',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0].qtyPerUnit).toBe(15);
    expect(res.rows[1].qtyPerUnit).toBe(35);
    expect(res.rows[0].uom).toBe('GM');
    const sum = res.rows.reduce((s, r) => s + r.qtyPerUnit, 0);
    expect(sum).toBeCloseTo(50, 3);
    const v = validateSkuBomTotals({
      lines: res.rows.map((r) => ({
        inci_name: r.inciName,
        rm_code: r.rmCode,
        qty_per_unit: r.qtyPerUnit,
        uom: r.uom,
      })),
      limitQty: res.limitQty,
      limitUom: res.limitUom,
    });
    expect(v.ok).toBe(true);
  });

  it('50 ML limit, three RMs → sum 50 ML', () => {
    const res = formulaRowsToSkuBomLines({
      formulaLines: [
        { inci_name: 'A', rm_code: 'A', pct_w_w: 10 },
        { inci_name: 'B', rm_code: 'B', pct_w_w: 40 },
        { inci_name: 'C', rm_code: 'C', pct_w_w: 50 },
      ],
      limitQty: 50,
      limitUom: 'ML',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const sum = res.rows.reduce((s, r) => s + r.qtyPerUnit, 0);
    expect(sum).toBeCloseTo(50, 3);
    expect(res.rows.every((r) => r.uom === 'ML')).toBe(true);
  });

  it('rejects when pct total is 95%', () => {
    const res = formulaRowsToSkuBomLines({
      formulaLines: [
        { inci_name: 'A', rm_code: 'A', pct_w_w: 50 },
        { inci_name: 'B', rm_code: 'B', pct_w_w: 45 },
      ],
      limitQty: 50,
      limitUom: 'GM',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/100%/);
  });

  it('rejects when formula has no meaningful lines', () => {
    const res = formulaRowsToSkuBomLines({
      formulaLines: [{ inci_name: '', rm_code: '', pct_w_w: 0 }],
      limitQty: 50,
      limitUom: 'GM',
    });
    expect(res.ok).toBe(false);
  });

  it('rejects invalid limit UOM', () => {
    const res = formulaRowsToSkuBomLines({
      formulaLines: [{ inci_name: 'A', rm_code: 'A', pct_w_w: 100 }],
      limitQty: 50,
      limitUom: 'PCS',
    });
    expect(res.ok).toBe(false);
  });

  it('rejects missing limit qty', () => {
    const res = formulaRowsToSkuBomLines({
      formulaLines: [{ inci_name: 'A', rm_code: 'A', pct_w_w: 100 }],
      limitQty: '',
      limitUom: 'GM',
    });
    expect(res.ok).toBe(false);
  });

  it('last-line drift correction for 33.33% × 3 on 50 GM', () => {
    const res = formulaRowsToSkuBomLines({
      formulaLines: [
        { inci_name: 'A', rm_code: 'A', pct_w_w: 33.33 },
        { inci_name: 'B', rm_code: 'B', pct_w_w: 33.33 },
        { inci_name: 'C', rm_code: 'C', pct_w_w: 33.34 },
      ],
      limitQty: 50,
      limitUom: 'GM',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const sum = res.rows.reduce((s, r) => s + r.qtyPerUnit, 0);
    expect(sum).toBeCloseTo(50, 3);
  });
});

describe('flattenFormulaBomPhases', () => {
  it('flattens phased ingredients', () => {
    const flat = flattenFormulaBomPhases([
      {
        phase: 'Main',
        ingredients: [{ inci_name: 'A', rm_code: 'A', pct_w_w: 100 }],
      },
    ]);
    expect(flat).toHaveLength(1);
    expect(flat[0].phase).toBe('Main');
    expect(flat[0].pct_w_w).toBe(100);
  });
});

describe('validateFormulaPctNotOver100', () => {
  it('allows total at or below 100%', () => {
    expect(
      validateFormulaPctNotOver100([
        { inci_name: 'A', rm_code: 'A', pct_w_w: 60 },
        { inci_name: 'B', rm_code: 'B', pct_w_w: 40 },
      ]).ok
    ).toBe(true);
    expect(
      validateFormulaPctNotOver100([{ inci_name: 'A', rm_code: 'A', pct_w_w: 80 }]).ok
    ).toBe(true);
  });

  it('rejects total over 100%', () => {
    const res = validateFormulaPctNotOver100([
      { inci_name: 'A', rm_code: 'A', pct_w_w: 60 },
      { inci_name: 'B', rm_code: 'B', pct_w_w: 50 },
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('FORMULA_PCT_OVER_100');
  });
});

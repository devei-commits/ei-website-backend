const { applySwapRatioToPct } = require('../../src/lib/swapRatio');

describe('applySwapRatioToPct', () => {
  test('splits pct by ratio', () => {
    const r = applySwapRatioToPct(10, 0.9);
    expect(r.newPct).toBe(9);
    expect(r.remainderPct).toBe(1);
  });
  test('ratio 1 gives all new', () => {
    const r = applySwapRatioToPct(10, 1);
    expect(r.newPct).toBe(10);
    expect(r.remainderPct).toBe(0);
  });
  test('ratio 0 gives all remainder', () => {
    const r = applySwapRatioToPct(10, 0);
    expect(r.newPct).toBe(0);
    expect(r.remainderPct).toBe(10);
  });

  test('ratio clamped to max 2', () => {
    const r = applySwapRatioToPct(10, 3);
    expect(r.newPct).toBe(20);
    expect(r.remainderPct).toBe(-10);
  });

  test('ratio 1.5 splits correctly', () => {
    const r = applySwapRatioToPct(10, 1.5);
    expect(r.newPct).toBe(15);
    expect(r.remainderPct).toBe(-5);
  });

  test('rounds to 2 decimals', () => {
    const r = applySwapRatioToPct(10, 0.333);
    expect(r.newPct).toBe(3.33);
    expect(r.remainderPct).toBe(6.67);
  });

  test('pct 0 gives 0, 0', () => {
    const r = applySwapRatioToPct(0, 0.5);
    expect(r.newPct).toBe(0);
    expect(r.remainderPct).toBe(0);
  });

  test('invalid pct treated as 0', () => {
    const r = applySwapRatioToPct('x', 0.5);
    expect(r.newPct).toBe(0);
    expect(r.remainderPct).toBe(0);
  });
});

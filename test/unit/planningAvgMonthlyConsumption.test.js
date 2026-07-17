'use strict';

const {
  avgMonthlyConsumptionByItem,
  AVG_MONTH_WINDOW_MONTHS,
} = require('../../src/lib/planningAvgMonthlyConsumption');

describe('avgMonthlyConsumptionByItem', () => {
  it('sums outbound qty per item and divides by the window months', () => {
    const rows = [
      { item_type: 'RM', raw_material_id: 1, qty_delta: -60 },
      { item_type: 'RM', raw_material_id: 1, qty_delta: -60 },
      { item_type: 'PM', pack_material_id: 5, qty_delta: -600 },
    ];
    const { rm, pm } = avgMonthlyConsumptionByItem(rows, 6);
    expect(rm.get(1)).toBe(20); // 120 total / 6 months
    expect(pm.get(5)).toBe(100); // 600 / 6
  });

  it('ignores inbound (positive qty_delta) and zero rows', () => {
    const rows = [
      { item_type: 'RM', raw_material_id: 2, qty_delta: 100 }, // inbound — ignored
      { item_type: 'RM', raw_material_id: 2, qty_delta: 0 },
      { item_type: 'RM', raw_material_id: 2, qty_delta: -30 },
    ];
    const { rm } = avgMonthlyConsumptionByItem(rows, 6);
    expect(rm.get(2)).toBe(5); // only the -30 counts → 30/6
  });

  it('clamps a non-positive window to 1 month', () => {
    const rows = [{ item_type: 'PM', pack_material_id: 9, qty_delta: -12 }];
    const { pm } = avgMonthlyConsumptionByItem(rows, 0);
    expect(pm.get(9)).toBe(12);
  });

  it('handles Sequelize-style rows with .get()', () => {
    const rows = [{ get: () => ({ item_type: 'RM', raw_material_id: 3, qty_delta: -18 }) }];
    const { rm } = avgMonthlyConsumptionByItem(rows, 6);
    expect(rm.get(3)).toBe(3);
  });

  it('exposes the spec default window of 6 months', () => {
    expect(AVG_MONTH_WINDOW_MONTHS).toBe(6);
  });
});

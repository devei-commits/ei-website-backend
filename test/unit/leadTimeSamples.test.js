'use strict';

const { buildLeadTimeSamples, daysBetween, isCompletedGrn } = require('../../src/lib/leadTimeSamples');

describe('daysBetween', () => {
  it('computes calendar-day difference', () => {
    expect(daysBetween('2026-01-01', '2026-01-11')).toBe(10);
  });
  it('returns null for bad dates', () => {
    expect(daysBetween(null, '2026-01-11')).toBeNull();
  });
});

describe('isCompletedGrn', () => {
  it('accepts GRN Complete status or grn_completed stage', () => {
    expect(isCompletedGrn({ status: 'GRN Complete' })).toBe(true);
    expect(isCompletedGrn({ stage: 'grn_completed' })).toBe(true);
    expect(isCompletedGrn({ status: 'Under GRN' })).toBe(false);
  });
});

describe('buildLeadTimeSamples', () => {
  const pos = [
    { id: 1, order_date: '2026-01-01', vendor_name: 'Acme', items: [{ raw_material_id: 10 }, { pack_material_id: 20 }] },
    { id: 2, order_date: '2026-02-01', vendor_name: 'Acme', items: [{ raw_material_id: 10 }] },
    { id: 3, order_date: '2026-03-01', vendor_name: 'Other', items: [{ raw_material_id: 10 }] },
  ];

  it('builds one sample per completed PO per (item, vendor)', () => {
    const grns = [
      { purchase_order_id: 1, status: 'GRN Complete', grn_date: '2026-01-11' }, // 10d
      { purchase_order_id: 2, status: 'GRN Complete', grn_date: '2026-02-16' }, // 15d
      { purchase_order_id: 3, status: 'GRN Complete', grn_date: '2026-03-21' }, // 20d, different vendor
    ];
    const byKey = buildLeadTimeSamples(pos, grns);
    expect(byKey.get('RM|10|acme').samples.map((s) => s.leadDays).sort((a, b) => a - b)).toEqual([10, 15]);
    expect(byKey.get('PM|20|acme').samples.map((s) => s.leadDays)).toEqual([10]);
    expect(byKey.get('RM|10|other').samples.map((s) => s.leadDays)).toEqual([20]);
  });

  it('ignores non-completed GRNs', () => {
    const grns = [{ purchase_order_id: 1, status: 'Under GRN', grn_date: '2026-01-11' }];
    expect(buildLeadTimeSamples(pos, grns).size).toBe(0);
  });

  it('uses the FIRST completed GRN per PO (partial-GRN rule)', () => {
    const grns = [
      { purchase_order_id: 1, status: 'GRN Complete', grn_date: '2026-01-20' }, // 19d (later drop)
      { purchase_order_id: 1, status: 'GRN Complete', grn_date: '2026-01-11' }, // 10d (first)
    ];
    const byKey = buildLeadTimeSamples(pos, grns);
    expect(byKey.get('RM|10|acme').samples.map((s) => s.leadDays)).toEqual([10]);
  });

  it('drops negative leads and POs with no order_date', () => {
    const grns = [{ purchase_order_id: 1, status: 'GRN Complete', grn_date: '2025-12-01' }]; // before order_date
    expect(buildLeadTimeSamples(pos, grns).size).toBe(0);
  });
});

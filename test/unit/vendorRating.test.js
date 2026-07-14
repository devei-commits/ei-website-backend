const { poKpis, aggregateRating, poMatchesVendor } = require('../../src/purchaseOrders/vendorRating');

describe('vendor rating KPIs', () => {
  test('perfect PO → all 1s', () => {
    const k = poKpis(
      { expected_shipment_date: '2026-07-20', rtv_status: null, short_closed_at: null },
      { grn_complete_at: '2026-07-19', vendor_confirmed_at: '2026-07-10', ack_sla_due_at: '2026-07-11' },
    );
    expect(k).toEqual({ onTime: 1, qcPass: 1, commSla: 1, fullSupply: 1 });
  });

  test('late + rtv + ack-late + short-closed → misses', () => {
    const k = poKpis(
      { expected_shipment_date: '2026-07-20', rtv_status: 'raised', short_closed_at: new Date() },
      { grn_complete_at: '2026-07-25', vendor_confirmed_at: '2026-07-15', ack_sla_due_at: '2026-07-11' },
    );
    expect(k.onTime).toBe(0);
    expect(k.qcPass).toBe(0);
    expect(k.commSla).toBe(0);
    expect(k.fullSupply).toBe(0.5);
  });

  test('missing dates → null (not measurable), acked-without-sla → 1', () => {
    const k = poKpis(
      { expected_shipment_date: null, rtv_status: null, short_closed_at: null },
      { vendor_confirmed_at: '2026-07-10', ack_sla_due_at: null },
    );
    expect(k.onTime).toBeNull();
    expect(k.commSla).toBe(1);
    expect(k.qcPass).toBe(1);
  });
});

describe('aggregateRating', () => {
  const perfect = { onTime: 1, qcPass: 1, commSla: 1, fullSupply: 1 };
  const bad = { onTime: 0, qcPass: 0, commSla: 0, fullSupply: 0.5 };

  test('perfect → 5', () => {
    expect(aggregateRating([perfect]).rating).toBe(5);
  });
  test('bad → 1', () => {
    expect(aggregateRating([bad]).rating).toBe(1);
  });
  test('mixed → 3, poCount 2', () => {
    const r = aggregateRating([perfect, bad]);
    expect(r.rating).toBe(3);
    expect(r.poCount).toBe(2);
    expect(r.kpi.fullSupply).toBe(0.75);
  });
  test('empty → null rating', () => {
    expect(aggregateRating([]).rating).toBeNull();
  });
  test('KPIs all null (not measurable) → null rating', () => {
    expect(aggregateRating([{ onTime: null, qcPass: null, commSla: null, fullSupply: null }]).rating).toBeNull();
  });
});

describe('poMatchesVendor', () => {
  test('matches by form_data.vendorClientId', () => {
    expect(poMatchesVendor({ form_data: { vendorClientId: 7 }, vendor_name: 'X' }, 7, 'Y')).toBe(true);
    expect(poMatchesVendor({ form_data: { vendorClientId: 9 }, vendor_name: 'X' }, 7, 'Y')).toBe(false);
  });
  test('falls back to case-insensitive vendor_name', () => {
    expect(poMatchesVendor({ form_data: {}, vendor_name: 'Acme' }, null, 'acme')).toBe(true);
    expect(poMatchesVendor({ form_data: {}, vendor_name: 'Acme' }, null, 'Other')).toBe(false);
  });
});

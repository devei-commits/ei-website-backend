/**
 * Presence helper is DB-backed; this test only documents expected reason keys for operators.
 */
const { findExistingZohoSalesOrderPresence } = require('../../scripts/lib/zoho-sales-order-existing');

describe('zohoSalesOrderExisting', () => {
  test('exports findExistingZohoSalesOrderPresence', () => {
    expect(typeof findExistingZohoSalesOrderPresence).toBe('function');
  });

  test('returns skip=false shape when no zoho id and no so number', async () => {
    const r = await findExistingZohoSalesOrderPresence('', '');
    expect(r.skip).toBe(false);
    expect(r.reasons).toEqual([]);
    expect(r.salesOrderId).toBeNull();
  });
});

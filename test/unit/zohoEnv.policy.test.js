describe('zohoEnv policy accessors', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  test('derives core sync toggles from env', () => {
    process.env.ZOHO_BOOKS_ENABLED = 'true';
    process.env.ZOHO_SYNC_CONTACTS = 'true';
    process.env.ZOHO_SYNC_ITEMS = 'false';
    process.env.ZOHO_SYNC_INVOICES = 'true';
    process.env.ZOHO_SYNC_USERTYPES = 'customer,doctor';

    const zohoEnv = require('../../src/services/zohoEnv');
    expect(zohoEnv.booksEnabled).toBe(true);
    expect(zohoEnv.syncUserContacts).toBe(true);
    expect(zohoEnv.syncItems).toBe(false);
    expect(zohoEnv.syncInvoices).toBe(true);
    expect(zohoEnv.shouldSyncUsertype('customer')).toBe(true);
    expect(zohoEnv.shouldSyncUsertype('doctor')).toBe(true);
    expect(zohoEnv.shouldSyncUsertype('admin')).toBe(false);
  });

  test('purchase order and bill sync toggles', () => {
    process.env.ZOHO_BOOKS_ENABLED = 'true';
    process.env.ZOHO_SYNC_PURCHASE_ORDERS = 'true';
    process.env.ZOHO_SYNC_PURCHASE_BILLS = 'false';
    process.env.ZOHO_SYNC_BILL_WITH_PO = 'true';

    const zohoEnv = require('../../src/services/zohoEnv');
    expect(zohoEnv.syncPurchaseOrders).toBe(true);
    expect(zohoEnv.syncPurchaseBills).toBe(false);
    expect(zohoEnv.syncBillWithPo).toBe(true);
  });

  test('builds seed sync policy with full sync flag', () => {
    process.env.ZOHO_BOOKS_ENABLED = 'true';
    process.env.ZOHO_SYNC_CONTACTS = 'true';
    process.env.ZOHO_SYNC_ITEMS = 'true';
    process.env.ZOHO_SYNC_INVOICES = 'true';
    process.env.ZOHO_SEED_FULL_SYNC = 'true';

    const zohoEnv = require('../../src/services/zohoEnv');
    expect(zohoEnv.seedFullSync).toBe(true);
    expect(zohoEnv.seedSyncItems).toBe(true);
    expect(zohoEnv.seedSyncContacts).toBe(true);
    expect(zohoEnv.seedSyncInvoices).toBe(true);
  });

  test('blocks seed contact sync when contact master toggle is off', () => {
    process.env.ZOHO_BOOKS_ENABLED = 'true';
    process.env.ZOHO_SEED_FULL_SYNC = 'true';
    process.env.ZOHO_SYNC_CONTACTS = 'false';

    const zohoEnv = require('../../src/services/zohoEnv');
    expect(zohoEnv.seedSyncContacts).toBe(false);
  });
});

describe('zohoContactSync usertype gating', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  test('shouldSyncZohoForUsertype respects ZOHO_SYNC_USERTYPES', () => {
    process.env.ZOHO_SYNC_USERTYPES = 'customer,accounts_team';

    const { shouldSyncZohoForUsertype } = require('../../src/users/zohoContactSync');
    expect(shouldSyncZohoForUsertype('customer')).toBe(true);
    expect(shouldSyncZohoForUsertype('accounts_team')).toBe(true);
    expect(shouldSyncZohoForUsertype('doctor')).toBe(false);
  });
});

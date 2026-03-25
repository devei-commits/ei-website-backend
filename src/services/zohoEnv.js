/**
 * Shared Zoho Books defaults from env (used by contacts, items, invoices).
 * Override per deployment / org.
 */

function str(key, fallback = '') {
  const v = process.env[key];
  return v != null && String(v).trim() !== '' ? String(v).trim() : fallback;
}

function num(key, fallback = null) {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key, fallback = false) {
  const v = process.env[key];
  if (v == null || String(v).trim() === '') return fallback;
  const t = String(v).trim().toLowerCase();
  if (t === 'true') return true;
  if (t === 'false') return false;
  return fallback;
}

function csvSet(key, fallbackCsv = '') {
  const raw = str(key, fallbackCsv);
  return new Set(
    String(raw)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Zoho Books uses large integer ids. JSON only has IEEE doubles — Number("3529895000000000064")
 * becomes 3529895000000000000. Use a JSON number only when it round-trips; otherwise keep a string.
 * @param {unknown} value
 * @returns {string | number | undefined}
 */
function zohoNumericIdForJson(value) {
  if (value === undefined || value === null) return undefined;
  const t = String(value).trim();
  if (!t) return undefined;
  if (!/^\d+$/.test(t)) return t;
  // Zoho ids are often 16+ digits; never use JSON numbers for those (IEEE double loses precision).
  if (t.length >= 16) return t;
  const n = Number(t);
  if (!Number.isFinite(n)) return t;
  if (String(n) !== t) return t;
  return n;
}

module.exports = {
  str,
  num,
  bool,
  csvSet,
  zohoNumericIdForJson,
  get booksEnabled() {
    return bool('ZOHO_BOOKS_ENABLED', false);
  },
  get syncInvoices() {
    return bool('ZOHO_SYNC_INVOICES', true);
  },
  get syncItems() {
    return bool('ZOHO_SYNC_ITEMS', true);
  },
  /** Sync purchase orders to Zoho Books POST /purchaseorders when PO is saved */
  get syncPurchaseOrders() {
    return this.booksEnabled && bool('ZOHO_SYNC_PURCHASE_ORDERS', true);
  },
  /** Sync vendor bills (purchase invoices) to Zoho Books POST /bills when eligible */
  get syncPurchaseBills() {
    return this.booksEnabled && bool('ZOHO_SYNC_PURCHASE_BILLS', true);
  },
  /** If true, create Zoho Bill right after PO sync (same request). Otherwise bill syncs when invoice fields / invoiced status are set */
  get syncBillWithPo() {
    return bool('ZOHO_SYNC_BILL_WITH_PO', false);
  },
  get syncUserContacts() {
    return this.booksEnabled && bool('ZOHO_SYNC_CONTACTS', true);
  },
  /** Vendor Client type=vendor → Zoho vendor contact (for POs / bills) */
  get syncVendorContacts() {
    return this.booksEnabled && bool('ZOHO_SYNC_VENDOR_CONTACTS', true);
  },
  /** Vendor Client type=client → Zoho customer contact */
  get syncClientContacts() {
    return this.booksEnabled && bool('ZOHO_SYNC_CLIENT_CONTACTS', true);
  },
  get syncUsertypes() {
    return csvSet('ZOHO_SYNC_USERTYPES', 'customer');
  },
  shouldSyncUsertype(usertype) {
    const normalized = usertype != null ? String(usertype).trim().toLowerCase() : '';
    return this.syncUsertypes.has(normalized);
  },
  get seedFullSync() {
    return bool('ZOHO_SEED_FULL_SYNC', false);
  },
  get seedSyncItems() {
    return (
      this.booksEnabled &&
      this.syncItems &&
      (this.seedFullSync || bool('ZOHO_SEED_SYNC_ITEMS', false))
    );
  },
  get seedSyncContacts() {
    return (
      this.booksEnabled &&
      this.syncUserContacts &&
      (this.seedFullSync || bool('ZOHO_SEED_SYNC_CONTACT', false))
    );
  },
  get seedSyncInvoices() {
    return (
      this.booksEnabled &&
      this.syncInvoices &&
      (this.seedFullSync || bool('ZOHO_SEED_SYNC_INVOICE', false))
    );
  },
  get defaultCurrencyId() {
    return str('ZOHO_DEFAULT_CURRENCY_ID');
  },
  get defaultLocationId() {
    return str('ZOHO_DEFAULT_LOCATION_ID');
  },
  get defaultPaymentTermsDays() {
    return num('ZOHO_DEFAULT_PAYMENT_TERMS', 15) ?? 15;
  },
  get invoiceUseAutoNumber() {
    return bool('ZOHO_INVOICE_USE_AUTO_NUMBER', false);
  },
  /** India GST invoice fields; leave unset if Books returns "Invalid Element gst_treatment" (omit via ZOHO_INVOICE_OMIT_GST_FIELDS or empty env). Allowed examples: consumer, business_gst, business_none, overseas. */
  get invoiceGstTreatment() {
    return str('ZOHO_INVOICE_GST_TREATMENT', '');
  },
  get invoicePlaceOfSupply() {
    return str('ZOHO_INVOICE_PLACE_OF_SUPPLY', '');
  },
  get defaultLineTaxId() {
    return str('ZOHO_DEFAULT_LINE_TAX_ID') || str('ZOHO_DEFAULT_ITEM_TAX_ID');
  },
  get defaultTdsTaxId() {
    return str('ZOHO_DEFAULT_TDS_TAX_ID');
  },
  get fallbackCustomerId() {
    return str('ZOHO_FALLBACK_CUSTOMER_ID');
  },
};

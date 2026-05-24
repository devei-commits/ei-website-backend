/**
 * Map Zoho Books purchase order payloads → local purchase_orders row shape.
 * Shared PO line mapping helpers (unit tests + future imports).
 */

const {
  findRawMaterialByMasterSku,
  findPackMaterialByMasterSku,
} = require('../../src/products/masterSkuLookup');

function toDateOnly(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  if (!s || s.toLowerCase() === 'invalid date') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

/** @param {string | undefined} status */
function mapZohoPoStatus(status) {
  const u = String(status || '')
    .trim()
    .toLowerCase();
  if (u === 'void' || u === 'cancelled' || u === 'canceled') return 'Cancelled';
  if (u === 'draft') return 'Draft';
  if (u === 'issued' || u === 'open' || u === 'approved') return 'Released';
  if (!u) return 'Draft';
  return 'Released';
}

function paymentTermsFromZoho(row) {
  if (row.payment_terms_label != null && String(row.payment_terms_label).trim()) {
    return String(row.payment_terms_label).trim();
  }
  if (row.payment_terms != null && String(row.payment_terms).trim() !== '') {
    return `NET ${String(row.payment_terms).trim()}`;
  }
  return null;
}

function lineItemsFromZoho(row) {
  const raw = row.line_items;
  return Array.isArray(raw) ? raw : [];
}

function leadTimeDaysFromZohoLine(line) {
  const fields = Array.isArray(line.item_custom_fields) ? line.item_custom_fields : [];
  for (const f of fields) {
    const api = String(f.api_name || '').trim();
    if (api === 'cf_lead_time' || String(f.label || '').toUpperCase() === 'LEAD TIME') {
      const n = parseInt(String(f.value ?? f.value_formatted ?? ''), 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return undefined;
}

function skuLooksLikePackaging(sku) {
  const t = String(sku || '').trim().toUpperCase();
  return /^5[ML]\d/.test(t) || /^4\d{4,}/.test(t);
}

/**
 * Resolve RM or PM master for a Zoho line SKU.
 * @param {string} sku
 * @returns {Promise<{ type: 'RM' | 'PM', id: number, code: string, name: string } | null>}
 */
async function resolveMasterForZohoSku(sku) {
  const t = String(sku || '').trim();
  if (!t) return null;

  const preferPm = skuLooksLikePackaging(t);
  const [rm, pm] = await Promise.all([
    findRawMaterialByMasterSku(t),
    findPackMaterialByMasterSku(t),
  ]);

  const rmPlain = rm && rm.get ? rm.get({ plain: true }) : rm;
  const pmPlain = pm && pm.get ? pm.get({ plain: true }) : pm;

  if (rmPlain && pmPlain) {
    const pick = preferPm ? pmPlain : rmPlain;
    const type = preferPm ? 'PM' : 'RM';
    return {
      type,
      id: Number(pick.id),
      code: String(pick.code || t),
      name: String(pick.name || pick.description || pick.inci || t),
    };
  }
  if (rmPlain) {
    return {
      type: 'RM',
      id: Number(rmPlain.id),
      code: String(rmPlain.code || t),
      name: String(rmPlain.name || rmPlain.inci || t),
    };
  }
  if (pmPlain) {
    return {
      type: 'PM',
      id: Number(pmPlain.id),
      code: String(pmPlain.code || t),
      name: String(pmPlain.description || pmPlain.code || t),
    };
  }
  return null;
}

/**
 * @param {Record<string, unknown>} zohoRow
 * @param {{ strict?: boolean }} opts
 * @returns {Promise<{ items: object[], unmatched: { sku: string, name: string }[] }>}
 */
async function buildPurchaseOrderItemsFromZoho(zohoRow, opts = {}) {
  const lines = lineItemsFromZoho(zohoRow);
  const items = [];
  const unmatched = [];

  for (const line of lines) {
    const sku = String(line.sku || '').trim();
    const name = String(line.name || '').trim();
    const qty = Number(line.quantity);
    const rate =
      line.rate != null
        ? Number(line.rate)
        : line.bcy_rate != null
          ? Number(line.bcy_rate)
          : NaN;
    const taxPct = line.tax_percentage != null ? Number(line.tax_percentage) : 18;
    const unit = String(line.unit || '').trim() || 'NOS';
    const leadDays = leadTimeDaysFromZohoLine(line);

    const master = await resolveMasterForZohoSku(sku);
    if (!master && sku) {
      unmatched.push({ sku, name: name || sku });
      if (opts.strict) {
        const err = new Error(`No RM/PM master for Zoho SKU: ${sku}`);
        err.code = 'UNMATCHED_SKU';
        err.sku = sku;
        throw err;
      }
    }

    const entry = {
      itemName: (master && master.name) || name || sku || 'Line item',
      itemCode: (master && master.code) || sku,
      quantity: Number.isFinite(qty) ? qty : 0,
      unit,
      rate: Number.isFinite(rate) ? String(rate) : '0',
      tax: Number.isFinite(taxPct) ? String(taxPct) : '18',
      zohoLineItemId: line.line_item_id != null ? String(line.line_item_id) : undefined,
      zohoItemId: line.item_id != null ? String(line.item_id) : undefined,
    };
    if (leadDays !== undefined) entry.lead_time_days = leadDays;
    if (master?.type === 'RM' && master.id > 0) entry.raw_material_id = master.id;
    if (master?.type === 'PM' && master.id > 0) entry.pack_material_id = master.id;

    items.push(entry);
  }

  return { items, unmatched };
}

/**
 * @param {Record<string, unknown>} zohoRow
 * @param {string} zohoId
 * @param {{ vendorClient?: { id: number, entity_code?: string, name?: string } | null }} ctx
 */
function buildFormDataFromZoho(zohoRow, zohoId, ctx = {}) {
  const vc = ctx.vendorClient;
  const cf = zohoRow.custom_field_hash && typeof zohoRow.custom_field_hash === 'object'
    ? zohoRow.custom_field_hash
    : {};
  const localStatus = mapZohoPoStatus(zohoRow.status || zohoRow.order_status);
  const fd = {
    source: 'zoho',
    zohoPurchaseOrderId: zohoId,
    zohoPurchaseorderNumber:
      zohoRow.purchaseorder_number != null ? String(zohoRow.purchaseorder_number) : '',
    orderId: zohoRow.purchaseorder_number != null ? String(zohoRow.purchaseorder_number) : '',
    poNumber: zohoRow.purchaseorder_number != null ? String(zohoRow.purchaseorder_number) : '',
    vendorName: zohoRow.vendor_name != null ? String(zohoRow.vendor_name) : '',
    orderDate: toDateOnly(zohoRow.date),
    expectedShipmentDate: toDateOnly(
      zohoRow.expected_delivery_date || zohoRow.delivery_date
    ),
    reference: zohoRow.reference_number != null ? String(zohoRow.reference_number) : '',
    paymentTerms: paymentTermsFromZoho(zohoRow) || '',
    branch: zohoRow.branch_name != null ? String(zohoRow.branch_name) : '',
    cfSource: cf.cf_source != null ? String(cf.cf_source) : zohoRow.cf_source != null ? String(zohoRow.cf_source) : '',
    zohoStatus: String(zohoRow.status || zohoRow.order_status || ''),
    zohoReceivedStatus: zohoRow.received_status != null ? String(zohoRow.received_status) : '',
    zohoBilledStatus: zohoRow.billed_status != null ? String(zohoRow.billed_status) : '',
  };
  if (vc && vc.id) {
    fd.vendorClientId = vc.id;
    if (vc.entity_code) fd.vendorEntityCode = vc.entity_code;
  }
  if (localStatus === 'Released') {
    fd.procurementApprovalStatus = 'approved';
    fd.procurementApprovedAt = toDateOnly(zohoRow.date) || new Date().toISOString();
  }
  return fd;
}

function baseOrderIdFromZoho(zohoRow, zohoId) {
  const num = zohoRow.purchaseorder_number != null ? String(zohoRow.purchaseorder_number).trim() : '';
  if (num) return num;
  return `ZOHO-PO-${zohoId}`;
}

module.exports = {
  toDateOnly,
  mapZohoPoStatus,
  paymentTermsFromZoho,
  lineItemsFromZoho,
  resolveMasterForZohoSku,
  buildPurchaseOrderItemsFromZoho,
  buildFormDataFromZoho,
  baseOrderIdFromZoho,
  skuLooksLikePackaging,
};

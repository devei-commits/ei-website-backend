/**
 * Map Zoho Books sales order payloads → local sales_orders row shape.
 * Used by scripts/zoho-pull-salesorders-to-sales-orders.js and unit tests.
 */

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
function mapZohoSoStatus(status, orderStatus) {
  const u = String(status || orderStatus || '')
    .trim()
    .toLowerCase();
  if (u === 'void' || u === 'cancelled' || u === 'canceled') return 'Cancelled';
  if (
    u === 'draft' ||
    u === 'pending_approval' ||
    u === 'pending approval' ||
    u === 'pending'
  ) {
    return 'Draft';
  }
  if (!u) return 'Draft';
  return 'Approved';
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

function customFieldFromZoho(row, apiName) {
  const hash = row.custom_field_hash && typeof row.custom_field_hash === 'object' ? row.custom_field_hash : {};
  if (hash[apiName] != null && String(hash[apiName]).trim()) return String(hash[apiName]).trim();
  const fields = Array.isArray(row.custom_fields) ? row.custom_fields : [];
  for (const f of fields) {
    if (String(f.api_name || '').trim() === apiName && f.value != null) {
      return String(f.value).trim();
    }
  }
  if (row[apiName] != null && String(row[apiName]).trim()) return String(row[apiName]).trim();
  if (row[`${apiName}_unformatted`] != null && String(row[`${apiName}_unformatted`]).trim()) {
    return String(row[`${apiName}_unformatted`]).trim();
  }
  return '';
}

function buildOrderStatusFromZoho(zohoRow) {
  return {
    orderStatus: String(zohoRow.status || zohoRow.order_status || ''),
    currentSubStatus: zohoRow.current_sub_status != null ? String(zohoRow.current_sub_status) : '',
    invoiced: zohoRow.invoiced_status != null ? String(zohoRow.invoiced_status) : '',
    payment: zohoRow.paid_status != null ? String(zohoRow.paid_status) : '',
    packed:
      zohoRow.quantity_packed != null
        ? String(zohoRow.quantity_packed)
        : zohoRow.shipped_status != null
          ? ''
          : '',
    shipped: zohoRow.shipped_status != null ? String(zohoRow.shipped_status) : '',
    deliveryMethod: zohoRow.delivery_method != null ? String(zohoRow.delivery_method) : '',
    quantity: zohoRow.quantity != null ? Number(zohoRow.quantity) : undefined,
    quantityInvoiced: zohoRow.quantity_invoiced != null ? Number(zohoRow.quantity_invoiced) : undefined,
    quantityPacked: zohoRow.quantity_packed != null ? Number(zohoRow.quantity_packed) : undefined,
    quantityShipped: zohoRow.quantity_shipped != null ? Number(zohoRow.quantity_shipped) : undefined,
  };
}

/**
 * @param {Record<string, unknown>} zohoRow
 * @param {string} zohoId
 * @param {{ client?: { id: number, entity_code?: string, name?: string } | null }} ctx
 */
function buildFormDataFromZoho(zohoRow, zohoId, ctx = {}) {
  const client = ctx.client;
  const fd = {
    source: 'zoho',
    zohoSalesorderId: zohoId,
    zohoSalesorderNumber:
      zohoRow.salesorder_number != null ? String(zohoRow.salesorder_number) : '',
    orderId: zohoRow.salesorder_number != null ? String(zohoRow.salesorder_number) : '',
    customerName: zohoRow.customer_name != null ? String(zohoRow.customer_name) : '',
    zohoCustomerId: zohoRow.customer_id != null ? String(zohoRow.customer_id) : '',
    orderDate: toDateOnly(zohoRow.date),
    expectedShipmentDate: toDateOnly(
      zohoRow.expected_shipment_date || zohoRow.shipment_date || zohoRow.delivery_date
    ),
    reference: zohoRow.reference_number != null ? String(zohoRow.reference_number) : '',
    paymentTerms: paymentTermsFromZoho(zohoRow) || '',
    branch: zohoRow.branch_name != null ? String(zohoRow.branch_name) : '',
    deliveryMethod: zohoRow.delivery_method != null ? String(zohoRow.delivery_method) : '',
    salespersonName: zohoRow.salesperson_name != null ? String(zohoRow.salesperson_name) : '',
    salesChannel:
      zohoRow.sales_channel_formatted != null
        ? String(zohoRow.sales_channel_formatted)
        : zohoRow.sales_channel != null
          ? String(zohoRow.sales_channel)
          : zohoRow.source != null
            ? String(zohoRow.source)
            : '',
    cfRetainerInvoiceNumber: customFieldFromZoho(zohoRow, 'cf_retainer_invoice_number'),
    zohoStatus: String(zohoRow.status || ''),
    zohoOrderStatus: String(zohoRow.order_status || ''),
    zohoTotal: zohoRow.total != null ? Number(zohoRow.total) : undefined,
    zohoBalance: zohoRow.balance != null ? Number(zohoRow.balance) : undefined,
  };
  if (client && client.id) {
    fd.vendorClientId = client.id;
    fd.clientId = client.id;
    if (client.entity_code) fd.clientEntityCode = client.entity_code;
  }
  return fd;
}

function baseOrderIdFromZoho(zohoRow, zohoId) {
  const num = zohoRow.salesorder_number != null ? String(zohoRow.salesorder_number).trim() : '';
  if (num) return num;
  return `ZOHO-SO-${zohoId}`;
}

/**
 * @param {Record<string, unknown>} line
 * @param {object | null} productPlain
 */
function mapZohoLineToSoItem(line, productPlain) {
  const qty = Number(line.quantity);
  const rateNum =
    line.rate != null
      ? Number(line.rate)
      : line.bcy_rate != null
        ? Number(line.bcy_rate)
        : line.item_total != null && Number(line.quantity) > 0
          ? Number(line.item_total) / Number(line.quantity)
          : NaN;
  const name = String(line.name || line.item_name || '').trim();
  const sku = String(line.sku || '').trim();
  const taxPct = line.tax_percentage != null ? Number(line.tax_percentage) : undefined;

  const entry = {
    sku: sku || (productPlain && (productPlain.zoho_sku_code || productPlain.product_code)) || '',
    productName: (productPlain && productPlain.product_name) || name || 'Line item',
    pack: String(line.unit || '').trim() || '',
    quantity: Number.isFinite(qty) ? qty : 0,
    unitPrice: Number.isFinite(rateNum) ? rateNum : 0,
    zohoLineItemId: line.line_item_id != null ? String(line.line_item_id) : undefined,
    zohoItemId: line.item_id != null ? String(line.item_id) : undefined,
  };
  if (taxPct != null && Number.isFinite(taxPct)) entry.taxPercent = taxPct;
  if (productPlain && Number(productPlain.product_id) > 0) {
    entry.product_id = Number(productPlain.product_id);
    entry.productId = Number(productPlain.product_id);
  }
  return entry;
}

module.exports = {
  toDateOnly,
  mapZohoSoStatus,
  paymentTermsFromZoho,
  lineItemsFromZoho,
  buildFormDataFromZoho,
  buildOrderStatusFromZoho,
  baseOrderIdFromZoho,
  mapZohoLineToSoItem,
  customFieldFromZoho,
};

/**
 * Shared core for importing a Zoho Books sales order into local
 * `sales_orders` (+ `planning_extracted`) and seeding `fulfillment_orders`.
 *
 * Extracted from scripts/zoho-pull-salesorders-to-sales-orders.js so the bulk CLI pull
 * and the single-SO HTTP route (POST /api/v1/sales-orders/zoho-import-by-so-no) share
 * one implementation instead of drifting apart.
 */

const { Op } = require('sequelize');

const db = require('../../db');
const SalesOrder = require('../../src/salesOrders/models');
const VendorClient = require('../../src/vendorClient/models');
const { Product } = require('../../src/products/models');
const {
  persistSalesOrderWithPlanning,
  updateSalesOrderWithPlanningRebuild,
} = require('../../src/salesOrders/controller');
const { getSalesorderById, normalizeZohoId } = require('../../src/services/zohoBooks');
const {
  toDateOnly,
  mapZohoSoStatus,
  paymentTermsFromZoho,
  lineItemsFromZoho,
  buildFormDataFromZoho,
  buildOrderStatusFromZoho,
  baseOrderIdFromZoho,
  mapZohoLineToSoItem,
} = require('./zoho-sales-order-import');
const { ensureFulfillmentOrderFromImportedSalesOrder } = require('./zoho-fulfillment-from-sales-order');

async function findByZohoSalesorderId(zohoId) {
  const [found] = await db.query(
    `SELECT id FROM sales_orders WHERE (form_data->>'zohoSalesorderId') = :zid LIMIT 1`,
    { replacements: { zid: zohoId } }
  );
  const id = found && found[0] && found[0].id;
  if (!id) return null;
  return SalesOrder.findByPk(id);
}

async function resolveClientForZohoCustomer(zohoCustomerId, customerName) {
  const zid = normalizeZohoId(zohoCustomerId);
  if (zid) {
    const byZoho = await VendorClient.findOne({
      where: { type: 'client', zoho_id: zid },
    });
    if (byZoho) return byZoho;
  }
  const cn = String(customerName || '').trim();
  if (!cn) return null;
  let row = await VendorClient.findOne({
    where: { type: 'client', name: cn },
  });
  if (!row) {
    row = await VendorClient.findOne({
      where: { type: 'client', name: { [Op.iLike]: cn } },
    });
  }
  return row;
}

async function resolveProductForZohoLine(line) {
  const zohoItemId = normalizeZohoId(line.item_id);
  const sku = line.sku != null ? String(line.sku).trim() : '';
  const or = [];
  if (zohoItemId) or.push({ zoho_item_id: zohoItemId });
  if (sku) {
    or.push({ zoho_sku_code: sku });
    or.push({ product_code: sku });
  }
  if (or.length === 0) return null;
  return Product.findOne({
    where: { [Op.or]: or },
    attributes: ['product_id', 'product_name', 'product_code', 'zoho_sku_code', 'lead_time_days'],
  });
}

async function allocateUniqueOrderId(preferredOrderId, zohoId, selfId) {
  let candidate = preferredOrderId;
  let n = 0;
  for (let guard = 0; guard < 5000; guard += 1) {
    const other = await SalesOrder.findOne({ where: { order_id: candidate } });
    if (!other) return candidate;
    const plain = other.get ? other.get({ plain: true }) : other;
    const otherZoho =
      plain.form_data &&
      typeof plain.form_data === 'object' &&
      plain.form_data.zohoSalesorderId != null
        ? String(plain.form_data.zohoSalesorderId)
        : '';
    if (selfId != null && plain.id === selfId) return candidate;
    if (otherZoho === zohoId) return candidate;
    n += 1;
    candidate = `${preferredOrderId}-Z-${zohoId}-${n}`;
  }
  throw new Error(`allocateUniqueOrderId: could not allocate order_id for zoho ${zohoId}`);
}

/**
 * @param {Record<string, unknown>} zohoRow
 * @param {{ strict?: boolean }} opts
 */
async function buildSalesOrderItemsFromZoho(zohoRow, opts = {}) {
  const lines = lineItemsFromZoho(zohoRow);
  const items = [];
  const unmatched = [];

  for (const line of lines) {
    const prod = await resolveProductForZohoLine(line);
    const plain = prod && prod.get ? prod.get({ plain: true }) : prod;
    const sku = String(line.sku || '').trim();
    if (!plain && sku) {
      unmatched.push({ sku, name: String(line.name || '').trim() || sku });
      if (opts.strict) {
        const err = new Error(`No product master for Zoho SKU: ${sku}`);
        err.code = 'UNMATCHED_SKU';
        err.sku = sku;
        throw err;
      }
    }
    items.push(mapZohoLineToSoItem(line, plain));
  }

  return { items, unmatched };
}

/** List rows often omit line_items — fetch the detail record when they do. */
async function ensureZohoRowWithLineItems(zohoRow, zohoId, opts = {}) {
  if (lineItemsFromZoho(zohoRow).length > 0) return zohoRow;
  if (opts.dryRun || String(process.env.ZOHO_SO_IMPORT_SKIP_DETAIL || '').trim() === '1') {
    return zohoRow;
  }
  try {
    const detail = await getSalesorderById(zohoId);
    if (detail && typeof detail === 'object') {
      return { ...zohoRow, ...detail };
    }
  } catch (e) {
    console.warn(
      '[zoho-import-salesorders] detail fetch failed, using list row',
      zohoId,
      e && e.message ? e.message : e
    );
  }
  return zohoRow;
}

async function zohoRowToPayload(zohoRow, zohoId, opts = {}) {
  const zohoCustomerId = normalizeZohoId(zohoRow.customer_id);
  const clientRow = await resolveClientForZohoCustomer(zohoCustomerId, zohoRow.customer_name);
  const clientPlain = clientRow && clientRow.get ? clientRow.get({ plain: true }) : clientRow;

  const { items, unmatched } = await buildSalesOrderItemsFromZoho(zohoRow, {
    strict: !!opts.strict,
  });

  const preferredOrderId = baseOrderIdFromZoho(zohoRow, zohoId);
  const existing = await findByZohoSalesorderId(zohoId);
  const order_id = await allocateUniqueOrderId(
    preferredOrderId,
    zohoId,
    existing ? existing.id : null
  );

  const form_data = buildFormDataFromZoho(zohoRow, zohoId, {
    client: clientPlain
      ? { id: clientPlain.id, entity_code: clientPlain.entity_code, name: clientPlain.name }
      : null,
  });

  const payload = {
    order_id,
    customer_name:
      (clientPlain && clientPlain.name) ||
      (zohoRow.customer_name != null ? String(zohoRow.customer_name).trim() : null) ||
      null,
    branch: zohoRow.branch_name != null ? String(zohoRow.branch_name).trim() || null : null,
    order_date: toDateOnly(zohoRow.date),
    expected_shipment_date: toDateOnly(
      zohoRow.expected_shipment_date || zohoRow.shipment_date || zohoRow.delivery_date
    ),
    reference:
      zohoRow.reference_number != null ? String(zohoRow.reference_number).trim() || null : null,
    payment_terms: paymentTermsFromZoho(zohoRow),
    status: mapZohoSoStatus(zohoRow.status, zohoRow.order_status),
    order_status: buildOrderStatusFromZoho(zohoRow),
    form_data,
    items,
    created_by: opts.createdBy || process.env.ZOHO_SO_IMPORT_CREATED_BY || 'Zoho import',
  };

  return { payload, existing, unmatched, clientFound: !!clientPlain };
}

async function upsertSalesOrder(payload, existing) {
  if (existing) {
    const prevFd = existing.get('form_data');
    const mergedFd =
      prevFd && typeof prevFd === 'object' && !Array.isArray(prevFd)
        ? { ...prevFd, ...payload.form_data }
        : payload.form_data;
    await updateSalesOrderWithPlanningRebuild(existing, { ...payload, form_data: mergedFd });
    await existing.reload();
    return { action: 'update', row: existing };
  }
  const row = await persistSalesOrderWithPlanning(payload);
  return { action: 'create', row };
}

/**
 * Full single-SO import: detail fetch → payload → upsert → seed fulfillment order.
 * Assumes the caller has already decided to proceed (duplicate checks live in the caller,
 * since the CLI and the HTTP route surface them differently).
 *
 * @returns {Promise<{action:'create'|'update', salesOrder:object, payload:object,
 *   unmatched:Array<{sku:string,name:string}>, clientFound:boolean, fulfillment:{action:string, id?:number}}>}
 */
async function importZohoSalesOrderRow(zohoRow, zohoId, opts = {}) {
  const fullRow = await ensureZohoRowWithLineItems(zohoRow, zohoId, { dryRun: false });
  const { payload, existing, unmatched, clientFound } = await zohoRowToPayload(fullRow, zohoId, opts);
  const result = await upsertSalesOrder(payload, existing);
  const fulfillment = await ensureFulfillmentOrderFromImportedSalesOrder(
    result.row,
    payload,
    fullRow,
    { dryRun: false }
  );
  return {
    action: result.action,
    salesOrder: result.row,
    payload,
    unmatched,
    clientFound,
    fulfillment,
  };
}

module.exports = {
  findByZohoSalesorderId,
  resolveClientForZohoCustomer,
  resolveProductForZohoLine,
  allocateUniqueOrderId,
  buildSalesOrderItemsFromZoho,
  ensureZohoRowWithLineItems,
  zohoRowToPayload,
  upsertSalesOrder,
  importZohoSalesOrderRow,
};

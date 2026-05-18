#!/usr/bin/env node
/**
 * Pull Zoho Books sales orders and upsert into local `sales_orders`, `planning_extracted`,
 * and `fulfillment_orders` (+ items + batch splits for the Fulfillment UI).
 *
 * Match key: `form_data.zohoSalesorderId` (stable Zoho salesorder_id).
 * Customers: `vendor_clients.zoho_id` = Zoho customer_id (type=client) → form_data.vendorClientId.
 * Line items: resolve `product_id` via products.zoho_item_id, then zoho_sku_code / product_code.
 *
 * Usage:
 *   node scripts/zoho-pull-salesorders-to-sales-orders.js [--dry-run] [--limit=N] [--max-pages=N] [--filter-by=...]
 *   node scripts/zoho-pull-salesorders-to-sales-orders.js --so-id=1252231000040833074
 *   node scripts/zoho-pull-salesorders-to-sales-orders.js --since-date=2026-04-01 [--strict]
 *
 * By default, SOs already in sales_orders / planning_extracted / fulfillment_orders are skipped (no updates).
 * Use --update-existing or ZOHO_SO_IMPORT_UPDATE_EXISTING=1 to refresh existing rows.
 *
 * Env: DATABASE_URL, Zoho OAuth/org (see zohoBooks).
 *   ZOHO_SO_IMPORT_CREATED_BY — created_by label (default: "Zoho import").
 *   ZOHO_SO_IMPORT_SKIP_DETAIL=1 — skip GET /salesorders/{id} when list rows lack line_items.
 *   ZOHO_SO_IMPORT_SEED_FULFILLMENT=1 — also upsert fulfillment_orders (default on; set 0 to skip).
 */

const path = require('path');
const { Op } = require('sequelize');

require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const db = require('../db');
const SalesOrder = require('../src/salesOrders/models');
const VendorClient = require('../src/vendorClient/models');
const { Product } = require('../src/products/models');
const {
  persistSalesOrderWithPlanning,
  updateSalesOrderWithPlanningRebuild,
} = require('../src/salesOrders/controller');
const {
  listAllSalesorders,
  getSalesorderById,
  normalizeZohoId,
  getOrgId,
} = require('../src/services/zohoBooks');
const { parseZohoPullArgs } = require('./lib/zoho-export-pull');
const {
  toDateOnly,
  mapZohoSoStatus,
  paymentTermsFromZoho,
  lineItemsFromZoho,
  buildFormDataFromZoho,
  buildOrderStatusFromZoho,
  baseOrderIdFromZoho,
  mapZohoLineToSoItem,
} = require('./lib/zoho-sales-order-import');
const { ensureFulfillmentOrderFromImportedSalesOrder } = require('./lib/zoho-fulfillment-from-sales-order');
const { findExistingZohoSalesOrderPresence } = require('./lib/zoho-sales-order-existing');

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

async function ensureZohoRowWithLineItems(zohoRow, zohoId, opts) {
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

function passesSinceDate(zohoRow, sinceDate) {
  if (!sinceDate) return true;
  const d = toDateOnly(zohoRow.date);
  if (!d) return true;
  return d >= sinceDate;
}

async function zohoRowToPayload(zohoRow, zohoId, opts) {
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
    created_by: process.env.ZOHO_SO_IMPORT_CREATED_BY || 'Zoho import',
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

async function collectZohoRows(opts) {
  if (opts.soId) {
    const id = normalizeZohoId(opts.soId);
    if (!id) throw new Error('--so-id is required');
    const detail = await getSalesorderById(id);
    if (!detail) throw new Error(`Zoho sales order not found: ${id}`);
    return [detail];
  }
  return listAllSalesorders({
    filterBy: opts.filterBy,
    maxPages: opts.maxPages,
    limit: opts.limit,
  });
}

async function main() {
  const opts = parseZohoPullArgs(process.argv.slice(2));
  const rows = await collectZohoRows(opts);

  const summary = {
    organizationId: getOrgId(),
    pulled: rows.length,
    processed: 0,
    skippedBeforeSince: 0,
    skippedNoId: 0,
    created: 0,
    updated: 0,
    clientMissing: 0,
    linesUnmatched: 0,
    fulfillmentCreated: 0,
    fulfillmentUpdated: 0,
    fulfillmentSkipped: 0,
    errors: 0,
    dryRun: !!opts.dryRun,
    strict: !!opts.strict,
    sinceDate: opts.sinceDate ?? null,
    soId: opts.soId ?? null,
  };

  for (const zohoRow of rows) {
    const zohoId = normalizeZohoId(zohoRow.salesorder_id);
    if (!zohoId) {
      summary.skippedNoId += 1;
      continue;
    }
    if (!passesSinceDate(zohoRow, opts.sinceDate)) {
      summary.skippedBeforeSince += 1;
      continue;
    }

    try {
      const fullRow = await ensureZohoRowWithLineItems(zohoRow, zohoId, { dryRun: !!opts.dryRun });
      const soNo = baseOrderIdFromZoho(fullRow, zohoId);

      if (!opts.updateExisting) {
        const presence = await findExistingZohoSalesOrderPresence(zohoId, soNo);
        if (presence.skip) {
          summary.skippedExisting += 1;
          if (opts.dryRun) {
            console.log(
              `[zoho-import-salesorders] dry-run skip existing ${soNo}`,
              presence.reasons.join(', ')
            );
          }
          continue;
        }
      }

      const { payload, existing, unmatched, clientFound } = await zohoRowToPayload(fullRow, zohoId, {
        strict: !!opts.strict,
      });
      summary.processed += 1;
      if (!clientFound) summary.clientMissing += 1;
      summary.linesUnmatched += unmatched.length;

      if (unmatched.length) {
        console.warn(
          `[zoho-import-salesorders] ${payload.order_id}: ${unmatched.length} line(s) without product master`,
          unmatched.map((u) => u.sku).join(', ')
        );
      }

      if (opts.dryRun) {
        if (existing) summary.updated += 1;
        else summary.created += 1;
        const ffDry = await ensureFulfillmentOrderFromImportedSalesOrder(
          existing || { id: 0, order_id: payload.order_id, ...payload },
          payload,
          fullRow,
          { dryRun: true }
        );
        if (ffDry.action === 'create') summary.fulfillmentCreated += 1;
        else if (ffDry.action === 'update') summary.fulfillmentUpdated += 1;
        else summary.fulfillmentSkipped += 1;
        continue;
      }

      const result = await upsertSalesOrder(payload, existing);
      if (result.action === 'create') summary.created += 1;
      else summary.updated += 1;

      const ff = await ensureFulfillmentOrderFromImportedSalesOrder(
        result.row,
        payload,
        fullRow,
        { dryRun: false }
      );
      if (ff.action === 'create') summary.fulfillmentCreated += 1;
      else if (ff.action === 'update') summary.fulfillmentUpdated += 1;
      else summary.fulfillmentSkipped += 1;
    } catch (e) {
      summary.errors += 1;
      console.error('[zoho-import-salesorders]', e?.message || e, {
        zohoId,
        soNumber: zohoRow.salesorder_number,
      });
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (summary.errors > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[zoho-import-salesorders]', e?.message || e);
  process.exit(1);
});

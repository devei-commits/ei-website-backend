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

require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const {
  listAllSalesorders,
  getSalesorderById,
  normalizeZohoId,
  getOrgId,
} = require('../src/services/zohoBooks');
const { parseZohoPullArgs } = require('./lib/zoho-export-pull');
const { toDateOnly, baseOrderIdFromZoho } = require('./lib/zoho-sales-order-import');
const { ensureFulfillmentOrderFromImportedSalesOrder } = require('./lib/zoho-fulfillment-from-sales-order');
const { findExistingZohoSalesOrderPresence } = require('./lib/zoho-sales-order-existing');
const {
  ensureZohoRowWithLineItems,
  zohoRowToPayload,
  upsertSalesOrder,
} = require('./lib/zoho-sales-order-upsert');

function passesSinceDate(zohoRow, sinceDate) {
  if (!sinceDate) return true;
  const d = toDateOnly(zohoRow.date);
  if (!d) return true;
  return d >= sinceDate;
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

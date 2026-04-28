#!/usr/bin/env node
/**
 * Pull Zoho Books invoices and upsert into local `fulfillment_invoices`.
 *
 * Matching precedence:
 * 1) Existing `fulfillment_invoices.zoho_invoice_id`
 * 2) Existing `fulfillment_invoices.invoice_no`
 *
 * Fulfillment order resolution for new rows:
 * - invoice.salesorder_id -> sales_orders.form_data.zohoSalesorderId -> fulfillment_orders.sales_order_id
 * - invoice.salesorder_number -> fulfillment_orders.so_no
 * - invoice.salesorder_number -> sales_orders.order_id -> fulfillment_orders.sales_order_id
 *
 * Usage:
 *   node scripts/zoho-pull-invoices-to-fulfillment-invoices.js [--dry-run] [--max-pages=N] [--limit=N] [--filter-by=...]
 */
const path = require('path');
const { Op } = require('sequelize');

require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const db = require('../db');
const SalesOrder = require('../src/salesOrders/models');
const { FulfillmentOrder, FulfillmentInvoice } = require('../src/fulfillment/models');
const { listAllInvoices, normalizeZohoId, getOrgId } = require('../src/services/zohoBooks');
const { parseZohoPullArgs } = require('./lib/zoho-export-pull');

function toDateOnly(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  if (!s || s.toLowerCase() === 'invalid date') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function toNumber(...vals) {
  for (const v of vals) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeStatus(status) {
  const s = String(status || '')
    .trim()
    .toLowerCase();
  if (!s) return 'draft';
  if (['draft', 'confirmed', 'sent', 'paid', 'partial', 'void'].includes(s)) return s;
  return 'confirmed';
}

async function findSalesOrderIdByZohoSalesorderId(zohoSalesorderId) {
  const [rows] = await db.query(
    `SELECT id FROM sales_orders WHERE (form_data->>'zohoSalesorderId') = :zid LIMIT 1`,
    { replacements: { zid: zohoSalesorderId } }
  );
  return rows && rows[0] && rows[0].id ? Number(rows[0].id) : null;
}

async function resolveFulfillmentOrderForInvoice(invoice) {
  const zohoSalesorderId = normalizeZohoId(invoice?.salesorder_id);
  const soNumber = String(invoice?.salesorder_number || '').trim();

  if (zohoSalesorderId) {
    const soId = await findSalesOrderIdByZohoSalesorderId(zohoSalesorderId);
    if (soId) {
      const fo = await FulfillmentOrder.findOne({ where: { sales_order_id: soId } });
      if (fo) return fo;
    }
  }

  if (soNumber) {
    const foBySoNo = await FulfillmentOrder.findOne({ where: { so_no: soNumber } });
    if (foBySoNo) return foBySoNo;

    const salesOrder = await SalesOrder.findOne({ where: { order_id: soNumber }, attributes: ['id'] });
    if (salesOrder) {
      const foBySalesOrderId = await FulfillmentOrder.findOne({ where: { sales_order_id: salesOrder.id } });
      if (foBySalesOrderId) return foBySalesOrderId;
    }
  }

  return null;
}

async function main() {
  const opts = parseZohoPullArgs(process.argv.slice(2));
  const rows = await listAllInvoices({
    filterBy: opts.filterBy,
    maxPages: opts.maxPages,
    limit: opts.limit,
  });

  const summary = {
    organizationId: getOrgId(),
    pulled: rows.length,
    processed: rows.length,
    created: 0,
    updated: 0,
    skippedNoZohoId: 0,
    skippedNoInvoiceNo: 0,
    skippedNoFulfillmentOrder: 0,
    errors: 0,
    dryRun: !!opts.dryRun,
    limit: opts.limit ?? null,
  };

  for (const row of rows) {
    const zohoInvoiceId = normalizeZohoId(row?.invoice_id);
    if (!zohoInvoiceId) {
      summary.skippedNoZohoId += 1;
      continue;
    }

    const invoiceNo = String(row?.invoice_number || row?.invoice_no || '').trim();
    if (!invoiceNo) {
      summary.skippedNoInvoiceNo += 1;
      continue;
    }

    try {
      let existing = await FulfillmentInvoice.findOne({
        where: {
          [Op.or]: [{ zoho_invoice_id: zohoInvoiceId }, { invoice_no: invoiceNo }],
        },
      });

      const fulfillmentOrder =
        existing && existing.fulfillment_order_id
          ? await FulfillmentOrder.findByPk(existing.fulfillment_order_id)
          : await resolveFulfillmentOrderForInvoice(row);

      if (!fulfillmentOrder) {
        summary.skippedNoFulfillmentOrder += 1;
        continue;
      }

      const payload = {
        invoice_no: invoiceNo,
        fulfillment_order_id: fulfillmentOrder.id,
        invoice_date: toDateOnly(row?.date || row?.invoice_date),
        due_date: toDateOnly(row?.due_date),
        remarks: String(row?.notes || '').trim() || null,
        subtotal: toNumber(row?.sub_total, row?.subtotal) ?? 0,
        gst_percent: toNumber(row?.gst_percent, row?.tax_percentage, row?.tax_percent) ?? 18,
        total_value: toNumber(row?.total, row?.invoice_total) ?? 0,
        status: normalizeStatus(row?.status),
        line_items: Array.isArray(row?.line_items) ? row.line_items : null,
        zoho_invoice_id: zohoInvoiceId,
        updated_at: new Date(),
      };

      if (!existing) {
        if (!opts.dryRun) {
          await FulfillmentInvoice.create({
            ...payload,
            status: 'confirmed',
            created_at: new Date(),
          });
        }
        summary.created += 1;
      } else {
        if (!opts.dryRun) {
          await existing.update({
            ...payload,
            status: payload.status || existing.status || 'confirmed',
          });
        }
        summary.updated += 1;
      }
    } catch (e) {
      summary.errors += 1;
      console.error('[zoho-pull-invoices-to-fulfillment-invoices] upsert error:', e?.message || e, {
        zohoInvoiceId,
        invoiceNo,
      });
    }
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error('[zoho-pull-invoices-to-fulfillment-invoices]', e?.message || e);
  process.exit(1);
});

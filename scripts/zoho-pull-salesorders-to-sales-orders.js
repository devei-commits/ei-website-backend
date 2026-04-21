#!/usr/bin/env node
/**
 * Pull Zoho Books sales orders and upsert into local `sales_orders` + `planning_extracted`
 * using the same persistence path as POST /api/.../sales-orders (see salesOrders/controller).
 *
 * Match / upsert key: `form_data.zohoSalesorderId` (stable Zoho salesorder_id).
 * Line items: resolve `product_id` via `products.zoho_item_id`, then `product_sku` / `product_code`.
 *
 * Usage:
 *   node scripts/zoho-pull-salesorders-to-sales-orders.js [--dry-run] [--max-pages=N] [--limit=N] [--filter-by=...]
 *
 * Env: DATABASE_URL, Zoho OAuth/org (see zohoBooks).
 *   ZOHO_SO_IMPORT_CREATED_BY — label for created_by (default: "Zoho import").
 *   ZOHO_SO_IMPORT_SKIP_DETAIL=1 — do not GET /salesorders/{id} when list rows lack line_items (faster, fewer API calls).
 */

const path = require('path');
const { Op } = require('sequelize');

require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const db = require('../db');
const SalesOrder = require('../src/salesOrders/models');
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

function toDateOnly(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  if (!s || s.toLowerCase() === 'invalid date') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function mapZohoStatus(status) {
  const u = String(status || '')
    .trim()
    .toLowerCase();
  if (u === 'void') return 'Cancelled';
  if (u === 'draft') return 'Draft';
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
  if (!Array.isArray(raw)) return [];
  return raw;
}

/**
 * List salesorders often omit line_items; merge GET /salesorders/{id} when needed.
 * @param {Record<string, unknown>} zohoRow
 * @param {string} zohoId
 * @param {{ dryRun: boolean }} opts
 */
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
      '[zoho-pull-salesorders-to-sales-orders] detail fetch failed, using list row',
      zohoId,
      e && e.message ? e.message : e
    );
  }
  return zohoRow;
}

/**
 * @param {string} zohoId
 * @returns {Promise<object | null>}
 */
async function findByZohoSalesorderId(zohoId) {
  const [found] = await db.query(
    `SELECT id FROM sales_orders WHERE (form_data->>'zohoSalesorderId') = :zid LIMIT 1`,
    { replacements: { zid: zohoId } }
  );
  const id = found && found[0] && found[0].id;
  if (!id) return null;
  return SalesOrder.findByPk(id);
}

async function resolveProductForZohoLine(line) {
  const zohoItemId = normalizeZohoId(line.item_id);
  const sku = line.sku != null ? String(line.sku).trim() : '';
  const or = [];
  if (zohoItemId) or.push({ zoho_item_id: zohoItemId });
  if (sku) {
    or.push({ product_sku: sku });
    or.push({ product_code: sku });
  }
  if (or.length === 0) return null;
  return Product.findOne({
    where: { [Op.or]: or },
    attributes: ['product_id', 'product_name', 'product_code', 'product_sku'],
  });
}

function baseOrderIdFromZoho(row, zohoId) {
  const num = row.salesorder_number != null ? String(row.salesorder_number).trim() : '';
  if (num) return num;
  return `ZOHO-${zohoId}`;
}

/**
 * @param {string} preferredOrderId
 * @param {string} zohoId
 * @param {number | null} selfId
 */
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
 * @param {string} zohoId
 */
async function zohoRowToPayload(zohoRow, zohoId) {
  const lines = lineItemsFromZoho(zohoRow);
  const items = [];
  for (const line of lines) {
    const prod = await resolveProductForZohoLine(line);
    const plain = prod && prod.get ? prod.get({ plain: true }) : prod;
    const qty = Number(line.quantity);
    const rateNum =
      line.rate != null
        ? Number(line.rate)
        : line.bcy_rate != null
          ? Number(line.bcy_rate)
          : line.item_total != null
            ? Number(line.item_total)
            : NaN;
    const name = String(line.name || line.item_name || '').trim();
    const sku = String(line.sku || '').trim();
    const entry = {
      sku: sku || (plain && (plain.product_sku || plain.product_code)) || '',
      productName: (plain && plain.product_name) || name || 'Line item',
      pack: String(line.unit || '').trim() || '',
      quantity: Number.isFinite(qty) ? qty : 0,
      unitPrice: Number.isFinite(rateNum) ? rateNum : 0,
    };
    if (plain && Number(plain.product_id) > 0) {
      entry.product_id = Number(plain.product_id);
      entry.productId = Number(plain.product_id);
    }
    items.push(entry);
  }

  const preferredOrderId = baseOrderIdFromZoho(zohoRow, zohoId);
  const existing = await findByZohoSalesorderId(zohoId);
  const order_id = await allocateUniqueOrderId(
    preferredOrderId,
    zohoId,
    existing ? existing.id : null
  );

  const formData = {
    source: 'zoho',
    zohoSalesorderId: zohoId,
    zohoSalesorderNumber: zohoRow.salesorder_number != null ? String(zohoRow.salesorder_number) : '',
    orderId: order_id,
    customerName: zohoRow.customer_name != null ? String(zohoRow.customer_name) : '',
    orderDate: toDateOnly(zohoRow.date),
    expectedShipmentDate: toDateOnly(
      zohoRow.expected_shipment_date || zohoRow.shipment_date || zohoRow.delivery_date
    ),
    reference: zohoRow.reference_number != null ? String(zohoRow.reference_number) : '',
    paymentTerms: paymentTermsFromZoho(zohoRow) || '',
  };

  const payload = {
    order_id,
    customer_name: zohoRow.customer_name != null ? String(zohoRow.customer_name).trim() || null : null,
    branch: null,
    order_date: toDateOnly(zohoRow.date),
    expected_shipment_date: toDateOnly(
      zohoRow.expected_shipment_date || zohoRow.shipment_date || zohoRow.delivery_date
    ),
    reference: zohoRow.reference_number != null ? String(zohoRow.reference_number).trim() || null : null,
    payment_terms: paymentTermsFromZoho(zohoRow),
    status: mapZohoStatus(zohoRow.status),
    order_status: {
      orderStatus: String(zohoRow.status || ''),
      invoiced: '',
      payment: '',
      packed: '',
      shipped: '',
      deliveryMethod: '',
    },
    form_data: formData,
    items,
    created_by: process.env.ZOHO_SO_IMPORT_CREATED_BY || 'Zoho import',
  };

  return { payload, existing };
}

async function main() {
  const opts = parseZohoPullArgs(process.argv.slice(2));
  const rows = await listAllSalesorders({
    filterBy: opts.filterBy,
    maxPages: opts.maxPages,
    limit: opts.limit,
  });
  const summary = {
    organizationId: getOrgId(),
    pulled: rows.length,
    processed: rows.length,
    limit: opts.limit ?? null,
    created: 0,
    updated: 0,
    skippedNoId: 0,
    errors: 0,
    dryRun: !!opts.dryRun,
  };

  for (const zohoRow of rows) {
    const zohoId = normalizeZohoId(zohoRow.salesorder_id);
    if (!zohoId) {
      summary.skippedNoId += 1;
      continue;
    }

    try {
      const fullRow = await ensureZohoRowWithLineItems(zohoRow, zohoId, { dryRun: !!opts.dryRun });
      const { payload, existing } = await zohoRowToPayload(fullRow, zohoId);
      if (opts.dryRun) {
        if (existing) summary.updated += 1;
        else summary.created += 1;
        continue;
      }

      if (existing) {
        await updateSalesOrderWithPlanningRebuild(existing, payload);
        summary.updated += 1;
      } else {
        await persistSalesOrderWithPlanning(payload);
        summary.created += 1;
      }
    } catch (e) {
      summary.errors += 1;
      console.error('[zoho-pull-salesorders-to-sales-orders]', e?.message || e, { zohoId });
    }
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error('[zoho-pull-salesorders-to-sales-orders]', e?.message || e);
  process.exit(1);
});

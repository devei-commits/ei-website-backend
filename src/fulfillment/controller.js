const { Op } = require('sequelize');
const db = require('../../db');
const { softDeleteInstance, softDeleteWhere, activeRowWhere, productActiveWhere } = require('../lib/softDelete');
const { normalizeMasterApprovalStatus } = require('../lib/masterApprovalStatus');
const { FulfillmentOrder, FulfillmentOrderItem, FulfillmentBatchSplit, Transporter, FulfillmentInvoice, ReservedBatchItem, BatchStageLog } = require('./models');
const BOM = require('../bom/models');
const { ProductionBatch } = require('../production/models');
const SalesOrder = require('../salesOrders/models');
const VendorClient = require('../vendorClient/models');
const { buildActiveClientWhere, buildActiveClientWhereByName } = require('../vendorClient/clientMasterQuery');
const { loadShippingBillingByUserIds, loadAddressCityStateCountryByUserIds } = require('../addresses/clientAddressHelpers');
const { Product } = require('../products/models');
const { Order } = require('../orders/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const WarehouseInventory = require('../warehouseInventory/models');
const { syncZohoInvoiceAfterFulfillment } = require('./zohoInvoiceSync');
const { validateStagedPaymentTermsJson } = require('./validateStagedPaymentTerms');
const {
  buildPlanningKgFromSoLine,
  roundPlanningMaterialQty,
} = require('../planningExtracted/orderKgMath');
const { packSizeFromBomRow } = require('../lib/skuBomPackSize');
const zohoEnv = require('../services/zohoEnv');
const { openStageLog, closeStageLog, computeCommercialStatusFromShippedQty } = require('./dashboardController');
const { resolveFgReadyProducedQty, loadProductionBatchesBySoNo, syncOrderSplitsFromProduction } = require('./batchSplitSync');

function zohoInvoiceSyncRollbackMessage(zohoError) {
  const zohoErr = String(zohoError || 'unknown_error');
  const contactTypeHint = /contact type|customer\/vendor/i.test(zohoErr)
    ? ' Link the SO customer to a Zoho customer contact (vendor_clients.type=client with zoho_id, or a customer user with zoho_contact_id), or set ZOHO_FALLBACK_CUSTOMER_ID. For local-only invoices set ZOHO_BOOKS_ENABLED=false.'
    : '';
  return `Invoice created locally but Zoho sync failed (${zohoErr}). Changes were rolled back.${contactTypeHint}`;
}

const INCLUDE_FULL = [
  {
    model: FulfillmentOrderItem,
    as: 'items',
    required: false,
    // Preserve the order the user entered SO line items in (do NOT alphabetize).
    // Item rows are inserted in entry order on both create and update (update deletes then
    // re-creates in array order), so their auto-increment `id` reflects entry order.
    // `separate: true` runs the items as their own ordered query so this order is reliable
    // even alongside the nested batchSplits include.
    separate: true,
    order: [['id', 'ASC']],
    include: [{ model: FulfillmentBatchSplit, as: 'batchSplits', required: false }],
  },
];

/* ── Helpers ── */

/** Units to show / invoice for a split when production batch is linked. */
function resolveSplitFgOutput(splitPlain, batchMeta) {
  const fgQtyStored = Number(splitPlain.fg_qty) || 0;
  const plannedQty = Number(splitPlain.planned_qty) || 0;
  if (batchMeta && batchMeta.id != null) {
    const bpr = String(batchMeta.bpr_status || '').toLowerCase();
    if (bpr === 'fg_ready') {
      const produced = resolveFgReadyProducedQty(batchMeta);
      if (produced != null) return Math.min(plannedQty > 0 ? plannedQty : produced, produced);
    }
    if (batchMeta.fg_yield != null) {
      const y = Number(batchMeta.fg_yield);
      if (Number.isFinite(y) && y >= 0) return Math.min(plannedQty > 0 ? plannedQty : y, y);
    }
  }
  return fgQtyStored;
}

/** Build map production_batch_id -> production status/yield fields used by Fulfillment timeline. */
async function getBatchStatusMap(productionBatchIds) {
  const ids = [...new Set((productionBatchIds || []).filter(Boolean))];
  if (ids.length === 0) return {};
  const rows = await ProductionBatch.findAll({
    where: { id: ids },
    attributes: ['id', 'bmr_status', 'bpr_status', 'bulk_yield', 'fill_yield', 'fg_yield', 'batch_size', 'order_qty'],
  });
  const map = {};
  rows.forEach((r) => {
    const d = r.get ? r.get({ plain: true }) : r;
    map[d.id] = {
      id: d.id,
      bmr_status: d.bmr_status || null,
      bpr_status: d.bpr_status || null,
      bulk_yield: d.bulk_yield != null ? Number(d.bulk_yield) : null,
      fill_yield: d.fill_yield != null ? Number(d.fill_yield) : null,
      fg_yield: d.fg_yield != null ? Number(d.fg_yield) : null,
      batch_size: d.batch_size != null ? Number(d.batch_size) : null,
      order_qty: d.order_qty != null ? Number(d.order_qty) : null,
    };
  });
  return map;
}

/** Effective ff_status: only fg_ready when Production BPR is fg_ready; else fg_pending. Shipped/delivered stay from DB. */
function effectiveFfStatus(split, batchMap) {
  const stored = split.ff_status;
  if (['picking', 'invoiced', 'shipped', 'delivered', 'closed'].includes(stored)) return stored;
  const batchId = split.production_batch_id;
  if (batchId && batchMap[batchId]) {
    const bprStatus = batchMap[batchId].bpr_status;
    return bprStatus === 'fg_ready' ? 'fg_ready' : 'fg_pending';
  }
  return stored === 'fg_ready' ? 'fg_pending' : (stored || 'fg_pending');
}

/**
 * Normalise a raw ship_address string stored in the DB.
 * Mirrors the frontend cleanAddress() utility so that corrupted legacy records
 * (name duplicated, billing+shipping concatenated, float pincodes) display
 * correctly in every view without a DB migration.
 */
function cleanShipAddressForDisplay(raw, customerName) {
  if (!raw) return '';
  const nameKey = customerName ? String(customerName).trim().toLowerCase() : '';

  // Fix float pincodes (e.g. 560094.0 → 560094)
  let working = String(raw).replace(/\b(\d{4,6})\.0\b/g, '$1');

  // Remove double-name at start of flat string ("Name Name," or "NameName,")
  if (nameKey) {
    const esc = nameKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    working = working.replace(new RegExp(`^(${esc})\\s*(${esc}(?=[,\\s]|$))`, 'i'), '$2');
  }

  // Collapse consecutive commas, split on newlines
  const collapsed = working.replace(/,{2,}/g, ',');
  const lines = collapsed.split(/[\n\r]+/).map((l) => l.replace(/^[,\s]+|[,\s]+$/g, '').trim()).filter(Boolean);

  // Adjacent identical-line dedup
  const deduped = [];
  for (const line of lines) {
    if (deduped[deduped.length - 1]?.toLowerCase() === line.toLowerCase()) continue;
    deduped.push(line);
  }

  // General heuristic: standalone name-only line followed by "name, rest…"
  if (deduped.length >= 2) {
    const l0 = deduped[0].toLowerCase();
    const l1 = deduped[1].toLowerCase();
    if (l0.length <= 60 && !/\d/.test(l0) && l1.startsWith(l0 + ',')) {
      deduped.shift();
      deduped[0] = deduped[0].slice(l0.length).replace(/^[,\s]+/, '').trim();
      if (!deduped[0]) deduped.shift();
    }
  }

  // Strip nameKey as exact first line
  if (nameKey && deduped.length > 0 && deduped[0].toLowerCase() === nameKey) deduped.shift();

  // Strip nameKey as prefix of first line ("Name, Ground floor…")
  if (nameKey && deduped.length > 0 && deduped[0].toLowerCase().startsWith(nameKey + ',')) {
    deduped[0] = deduped[0].slice(customerName.trim().length).replace(/^[,\s]+/, '').trim();
    if (!deduped[0]) deduped.shift();
  }

  // Word-set subset dedup + equal-wordset dedup (catches duplicate city/state blocks)
  const wordSets = deduped.map((l) => new Set(l.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 1)));
  const seenKeys = new Set();
  const result = deduped.filter((_, i) => {
    if (wordSets[i].size === 0) return false;
    const key = [...wordSets[i]].sort().join('|');
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return !wordSets.some((other, j) => {
      if (j === i || other.size <= wordSets[i].size) return false;
      return [...wordSets[i]].every((w) => other.has(w));
    });
  });

  return result.join('\n').trim();
}

function formatOrder(row, batchMap = {}, extra = {}) {
  const d = row.get ? row.get({ plain: true }) : row;
  const items = (d.items || []).map((item) => formatItem(item, batchMap));
  const allSplits = items.flatMap((i) => i.batchSplits || []);
  // Manual cancel / manual-fulfill freeze the status — never recompute over it.
  const soStatus = d.manual_status_override ? d.so_status : recalculateSOStatusFromSplits(allSplits);
  return {
    id: d.id,
    soNo: d.so_no,
    salesOrderId: d.sales_order_id,
    soDate: d.order_date,
    customer: d.customer_name,
    customerCity: d.customer_city,
    orderDate: d.order_date,
    dueDate: d.due_date,
    priority: d.priority,
    soStatus,
    commercialStatus: d.commercial_status || 'received',
    // Authoritative sales_orders.status (drives Planning → PIS Extracted); Edit SO → Update SO Status.
    orderStatus: extra.orderStatus != null ? extra.orderStatus : null,
    soValue: d.so_value != null ? Number(d.so_value) : 0,
    shipAddress: cleanShipAddressForDisplay(d.ship_address, d.customer_name),
    paymentTerms: d.payment_terms || '',
    notes: d.notes || '',
    invoiceNo: d.invoice_no || undefined,
    invoiceDate: d.invoice_date || undefined,
    awbNo: d.awb_no || undefined,
    dispatchDate: d.dispatch_date || undefined,
    courier: d.courier || undefined,
    zohoInvoiceId: d.zoho_invoice_id || undefined,
    // Large raw import blob — only sent from the single-order endpoint (see extra.includeRawImport).
    ...(extra.includeRawImport === false ? {} : { rawImport: d.raw_import || null }),
    items,
  };
}

function formatItem(d, batchMap = {}) {
  return {
    id: d.id,
    itemNo: d.item_no || '',
    sku: d.sku || '',
    productName: d.product_name,
    pack: d.pack || '',
    orderedQty: d.ordered_qty,
    rate: d.rate != null ? Number(d.rate) : 0,
    unitPrice: d.unit_price != null ? Number(d.unit_price) : 0,
    mrp: d.mrp_price != null ? Number(d.mrp_price) : null,
    // Per-line tax entered on the SO — no platform-side hardcoded GST is applied anywhere downstream.
    taxPct: d.tax_pct != null ? Number(d.tax_pct) : 0,
    taxAmount: d.tax_amount != null ? Number(d.tax_amount) : 0,
    batchSplits: (d.batchSplits || []).map((s) => formatSplit(s, batchMap)),
  };
}

function formatSplit(d, batchMap = {}) {
  const ffStatus = effectiveFfStatus(d, batchMap);
  const pb = d.production_batch_id && batchMap[d.production_batch_id] ? batchMap[d.production_batch_id] : {};
  const plannedQty = Number(d.planned_qty) || 0;
  const fgQty = Number(d.fg_qty) || 0;
  const fgYield = pb.fg_yield != null ? Number(pb.fg_yield) : null;
  const fgOutput = resolveSplitFgOutput(d, pb);
  const remainingQty = Math.max(0, plannedQty - fgOutput);
  const completionPercent = plannedQty > 0 ? Math.min(100, Math.round((fgOutput / plannedQty) * 100)) : 0;
  return {
    id: d.id,
    fulfillmentOrderItemId: d.fulfillment_order_item_id,
    fulfillmentOrderId: d.fulfillment_order_id,
    productionBatchId: d.production_batch_id,
    bmrNo: d.bmr_no || '',
    bprNo: d.bpr_no || '',
    plannedQty,
    fgQty,
    bmrStatus: pb.bmr_status || null,
    bprStatus: pb.bpr_status || null,
    bulkYield: pb.bulk_yield != null ? Number(pb.bulk_yield) : null,
    fillYield: pb.fill_yield != null ? Number(pb.fill_yield) : null,
    fgYield,
    fgOutput,
    remainingQty,
    completionPercent,
    fgLocation: d.fg_location,
    ffStatus,
    pickedQty: d.picked_qty || 0,
    pickerName: d.picker_name,
    pickDate: d.pick_date,
    pickSlipNo: d.pick_slip_no,
    remarks: d.remarks,
    invoiceNo: d.invoice_no,
    awbNo: d.awb_no,
    courier: d.courier,
    dispatchDate: d.dispatch_date,
    etaDate: d.eta_date,
    deliveryDate: d.delivery_date,
    receivedBy: d.received_by,
    deliveryRemarks: d.delivery_remarks,
  };
}

/** Recompute SO status from split objects that have .ffStatus (formatted). */
function recalculateSOStatusFromSplits(splits) {
  if (!splits.length) return 'planned';
  const fgSplits = splits.filter(s => s.fgQty > 0 || ['fg_ready', 'picking', 'invoiced', 'shipped', 'delivered', 'closed'].includes(s.ffStatus));
  // SO is closed only when every batch (split) is delivered/closed
  if (splits.every(s => ['delivered', 'closed'].includes(s.ffStatus))) return 'closed';
  if (!fgSplits.length) {
    if (splits.some(s => ['bulk_qc', 'wip'].includes(s.ffStatus))) return 'in_production';
    return 'planned';
  }
  if (fgSplits.some(s => ['shipped', 'delivered', 'closed'].includes(s.ffStatus))) return 'shipped';
  if (fgSplits.some(s => s.ffStatus === 'invoiced')) return 'invoiced';
  if (fgSplits.some(s => s.ffStatus === 'picking')) return 'picking';
  if (fgSplits.every(s => s.ffStatus === 'fg_ready')) return 'fg_ready';
  if (fgSplits.some(s => s.ffStatus === 'fg_ready')) return 'partial';
  if (splits.some(s => ['bulk_qc', 'wip', 'fg_pending'].includes(s.ffStatus))) return 'in_production';
  return 'planned';
}

function recalculateSOStatus(splits) {
  if (!splits.length) return 'planned';
  const fgSplits = splits.filter(s => s.fg_qty > 0 || ['fg_ready', 'picking', 'invoiced', 'shipped', 'delivered', 'closed'].includes(s.ff_status));
  // SO is closed only when every batch (split) is delivered/closed, not just the FG subset
  if (splits.every(s => ['delivered', 'closed'].includes(s.ff_status))) return 'closed';
  if (!fgSplits.length) {
    if (splits.some(s => ['bulk_qc', 'wip'].includes(s.ff_status))) return 'in_production';
    return 'planned';
  }
  if (fgSplits.some(s => ['shipped', 'delivered', 'closed'].includes(s.ff_status))) return 'shipped';
  if (fgSplits.some(s => s.ff_status === 'invoiced')) return 'invoiced';
  if (fgSplits.some(s => s.ff_status === 'picking')) return 'picking';
  if (fgSplits.every(s => s.ff_status === 'fg_ready')) return 'fg_ready';
  if (fgSplits.some(s => s.ff_status === 'fg_ready')) return 'partial';
  if (splits.some(s => ['bulk_qc', 'wip', 'fg_pending'].includes(s.ff_status))) return 'in_production';
  return 'planned';
}

/** Get next auto-incremented BMR/BPR numbers for the year (e.g. BMR-2026-001, BPR-2026-001). */
async function getNextBMRBPRSequence(year) {
  const prefix = `BMR-${year}-`;
  const batches = await ProductionBatch.findAll({
    where: { bmr_no: { [Op.like]: `${prefix}%` } },
    attributes: ['bmr_no'],
  });
  let maxNum = 0;
  for (const b of batches) {
    const num = parseInt(b.bmr_no.replace(prefix, ''), 10);
    if (!Number.isNaN(num) && num > maxNum) maxNum = num;
  }
  const next = maxNum + 1;
  const suffix = String(next).padStart(3, '0');
  return { bmrNo: `BMR-${year}-${suffix}`, bprNo: `BPR-${year}-${suffix}` };
}

/* ── CRUD ── */

async function listOrders(req, res) {
  try {
    // Opt-in pagination. Without page/page_size the response stays a plain array so existing
    // callers are unaffected; with them it returns { rows, total, page, pageSize }.
    const paginated = req.query.page != null || req.query.page_size != null;
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.page_size, 10) || 100));
    const baseQuery = {
      where: activeRowWhere(),
      include: INCLUDE_FULL,
      order: [['due_date', 'ASC'], ['id', 'ASC']],
      ...(paginated ? { limit: pageSize, offset: (pageNum - 1) * pageSize } : {}),
    };

    let total = null;
    let rows;
    if (paginated) {
      const result = await FulfillmentOrder.findAndCountAll(baseQuery);
      total = result.count;
      rows = result.rows;
    } else {
      rows = await FulfillmentOrder.findAll(baseQuery);
    }

    // One batch query for the whole page instead of one per order, and only re-read the orders
    // when the sync actually wrote something (the steady-state case writes nothing).
    const batchesBySoNo = await loadProductionBatchesBySoNo(
      rows.map((r) => (r.get ? r.get('so_no') : r.so_no))
    );
    let mutated = false;
    for (const row of rows) {
      if (await syncOrderSplitsFromProduction(row, batchesBySoNo)) mutated = true;
    }
    if (mutated) {
      rows = paginated
        ? (await FulfillmentOrder.findAndCountAll(baseQuery)).rows
        : await FulfillmentOrder.findAll(baseQuery);
    }
    const batchIds = rows.flatMap((r) => {
      const d = r.get ? r.get({ plain: true }) : r;
      return (d.items || []).flatMap((i) => (i.batchSplits || []).map((s) => s.production_batch_id).filter(Boolean));
    });
    const batchMap = await getBatchStatusMap(batchIds);
    // Bulk-load authoritative sales_orders.status so the Edit-SO status control shows the real value.
    const soIds = [...new Set(rows.map((r) => (r.get ? r.get('sales_order_id') : r.sales_order_id)).filter(Boolean))];
    const orderStatusMap = new Map();
    if (soIds.length) {
      const soRows = await SalesOrder.findAll({ where: { id: { [Op.in]: soIds } }, attributes: ['id', 'status'] });
      soRows.forEach((s) => { const sd = s.get({ plain: true }); orderStatusMap.set(sd.id, sd.status || null); });
    }
    // `rawImport` is the untouched Zoho/Excel import blob — several KB per order and unused by any
    // list view, so it is omitted here. GET /fulfillment/:id still returns it.
    const payload = rows.map((row) => {
      const sid = row.get ? row.get('sales_order_id') : row.sales_order_id;
      return formatOrder(row, batchMap, { orderStatus: orderStatusMap.get(sid) || null, includeRawImport: false });
    });
    res.json(paginated ? { rows: payload, total, page: pageNum, pageSize } : payload);
  } catch (err) {
    console.error('listOrders error:', err);
    res.status(500).json({ error: 'Failed to fetch fulfillment orders' });
  }
}

/**
 * Resolves each formatted order item to its matching planning_extracted row, using the same
 * sku → zoho_sku_code/product_code, then product_name matching used when planning_extracted
 * rows are first created from SO lines (see createOrder above). This lets an item-level comment
 * added from Fulfillment be found from Planning's PIs Extracted view, which already keys its
 * rows by planning_extracted.id — no new table or fulfillment_order_items column needed.
 */
async function attachPlanningLinkageToItems(items, salesOrderId) {
  if (!salesOrderId || !items.length) {
    return items.map((it) => ({ ...it, planningExtractedId: null, commentCount: 0 }));
  }
  const PlanningExtracted = require('../planningExtracted/models');
  const { FulfillmentComment } = require('./models');

  const planningRows = await PlanningExtracted.findAll({
    where: { sales_order_id: salesOrderId },
    attributes: ['id'],
    include: [{ model: Product, as: 'product', attributes: ['product_code', 'zoho_sku_code', 'product_name'], required: false }],
  });
  const byCode = new Map();
  const byName = new Map();
  for (const plan of planningRows) {
    const p = plan.get ? plan.get({ plain: true }) : plan;
    const prod = p.product;
    if (!prod) continue;
    if (prod.zoho_sku_code) byCode.set(String(prod.zoho_sku_code).trim().toLowerCase(), p.id);
    if (prod.product_code) byCode.set(String(prod.product_code).trim().toLowerCase(), p.id);
    if (prod.product_name) byName.set(String(prod.product_name).trim().toLowerCase(), p.id);
  }

  const planningExtractedIdByItemId = new Map();
  for (const it of items) {
    const skuKey = String(it.sku || '').trim().toLowerCase();
    const nameKey = String(it.productName || '').trim().toLowerCase();
    const planningExtractedId = (skuKey && byCode.get(skuKey)) || (nameKey && byName.get(nameKey)) || null;
    planningExtractedIdByItemId.set(it.id, planningExtractedId);
  }

  const planningIds = [...new Set([...planningExtractedIdByItemId.values()].filter(Boolean))];
  const commentCounts = planningIds.length
    ? await FulfillmentComment.findAll({
        where: { entity_type: 'item', entity_id: { [Op.in]: planningIds }, lifecycle_status: 'active' },
        attributes: ['entity_id', [db.fn('COUNT', db.col('id')), 'cnt']],
        group: ['entity_id'],
        raw: true,
      })
    : [];
  const countByPlanningId = new Map(commentCounts.map((r) => [r.entity_id, parseInt(r.cnt, 10) || 0]));

  return items.map((it) => {
    const planningExtractedId = planningExtractedIdByItemId.get(it.id) ?? null;
    return {
      ...it,
      planningExtractedId,
      commentCount: planningExtractedId ? (countByPlanningId.get(planningExtractedId) || 0) : 0,
    };
  });
}

async function getOrderById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    let row = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    if (!row) return res.status(404).json({ error: 'Fulfillment order not found' });
    // Only re-read when the sync actually wrote something — this is the per-click detail path.
    if (await syncOrderSplitsFromProduction(row)) {
      row = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    }
    const d = row.get ? row.get({ plain: true }) : row;
    const batchIds = (d.items || []).flatMap((i) => (i.batchSplits || []).map((s) => s.production_batch_id).filter(Boolean));
    const batchMap = await getBatchStatusMap(batchIds);
    let orderStatus = null;
    if (d.sales_order_id) {
      const so = await SalesOrder.findByPk(d.sales_order_id, { attributes: ['status'] });
      orderStatus = so ? (so.get('status') || null) : null;
    }
    const formatted = formatOrder(row, batchMap, { orderStatus });
    formatted.items = await attachPlanningLinkageToItems(formatted.items, d.sales_order_id);
    res.json(formatted);
  } catch (err) {
    console.error('getOrderById error:', err);
    res.status(500).json({ error: 'Failed to fetch fulfillment order' });
  }
}

async function createOrder(req, res) {
  try {
    const {
      soNo, salesOrderId, customer, customerCity, orderDate, dueDate,
      priority, shipAddress, paymentTerms, notes, items,
    } = req.body;

    if (!soNo || !customer) {
      return res.status(400).json({ error: 'soNo and customer are required' });
    }

    if (!items || !items.length) {
      return res.status(400).json({ error: 'At least one order item is required' });
    }

    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const label = it.productName || it.sku || `item #${i + 1}`;
      if (!normalizePackSizeForOrder(it.pack)) {
        return res.status(400).json({
          error: `Pack size is required for ${label}. Set fill size on the product record (PR) or enter it when creating the sale order.`,
        });
      }
    }

    const clientMaster = await VendorClient.findOne({
      where: buildActiveClientWhereByName(customer),
      attributes: ['id', 'name', 'entity_code'],
    });
    if (!clientMaster) {
      return res.status(400).json({
        error: 'Select a valid active client from the customer list',
      });
    }

    const {
      resolveClientProductPrice,
      syncClientPriceTierFromSaleOrder,
    } = require('../itemsList/resolveClientProductPrice');

    const resolveProductIdFromSoItem = async (item) => {
      if (item.productId != null) {
        const pid = parseInt(item.productId, 10);
        if (Number.isFinite(pid) && pid > 0) return pid;
      }
      if (item.sku) {
        const prod = await Product.findOne({ where: { zoho_sku_code: item.sku } });
        if (prod) return prod.product_id;
      }
      if (item.productName) {
        const prod = await Product.findOne({ where: { product_name: item.productName } });
        if (prod) return prod.product_id;
      }
      return null;
    };

    for (const item of items) {
      const productId = await resolveProductIdFromSoItem(item);
      if (!productId) continue;
      const qty = item.orderedQty || 0;
      const unitPrice = Number(item.unitPrice) || 0;
      if (unitPrice <= 0) continue;
      const resolved = await resolveClientProductPrice({
        productId,
        clientId: clientMaster.id,
        quantity: qty,
      });
      if (resolved.source === 'client_price_list_tier') continue;
      await syncClientPriceTierFromSaleOrder({
        productId,
        clientId: clientMaster.id,
        quantity: qty,
        pricePerUnit: unitPrice,
      });
    }

    const ptErr = validateStagedPaymentTermsJson(paymentTerms);
    if (ptErr) {
      return res.status(400).json({ error: ptErr });
    }

    const createdByName = req.user ? (req.user.fullName || req.user.email) : null;

    // SO value is the final payable total: line subtotals + each line's own tax amount (as entered
    // on the SO). No flat/hardcoded GST% is ever added here.
    const soValue = (items || []).reduce((sum, item) => {
      const lineSubtotal = (item.orderedQty || 0) * (item.unitPrice || 0);
      const lineTax = Number(item.taxAmount) || 0;
      return sum + lineSubtotal + lineTax;
    }, 0);

    // Create or link a SalesOrder record
    let resolvedSalesOrderId = salesOrderId || null;
    if (!resolvedSalesOrderId) {
      const existingSO = await SalesOrder.findOne({ where: { order_id: soNo } });
      if (existingSO) {
        resolvedSalesOrderId = existingSO.id;
      } else {
        const newSO = await SalesOrder.create({
          order_id: soNo,
          customer_name: customer,
          order_date: orderDate || null,
          expected_shipment_date: dueDate || null,
          payment_terms: paymentTerms || null,
          status: 'Approved',
          items: (items || []).map((it, idx) => ({
            product_id: it.productId || null,
            sku: it.sku || '',
            productName: it.productName || '',
            pack: normalizePackSizeForOrder(it.pack),
            quantity: it.orderedQty || 0,
            unitPrice: it.unitPrice || 0,
          })),
          created_by: createdByName,
        });
        resolvedSalesOrderId = newSO.id;

        // Auto-create planning_extracted rows from SO items + BOM (FG kg = units × fill size; RM = % of that kg)
        const PlanningExtracted = require('../planningExtracted/models');
        for (const item of (items || [])) {
          let productId = null;
          if (item.sku) {
            const prod = await Product.findOne({ where: { zoho_sku_code: item.sku } });
            if (prod) productId = prod.product_id;
          }
          if (!productId && item.productName) {
            const prod = await Product.findOne({ where: { product_name: item.productName } });
            if (prod) productId = prod.product_id;
          }
          if (!productId) continue;

          let rmLines = [];
          let pmLines = [];
          const bom = await BOM.findOne({ where: { product_id: productId } });
          if (bom) {
            const b = bom.get ? bom.get({ plain: true }) : bom;
            rmLines = Array.isArray(b.rm_lines) ? b.rm_lines : [];
            pmLines = Array.isArray(b.pm_lines) ? b.pm_lines : [];
          }

          const orderQty = item.orderedQty || 0;
          const product = await Product.findByPk(productId);
          const prodPlain = product && product.get ? product.get({ plain: true }) : product;
          const packFromSo = normalizePackSizeForOrder(item.pack);
          const {
            safeTotalKg,
            batchSizeKg,
            batchesRequired,
            raw_materials,
            packaging_materials,
          } = buildPlanningKgFromSoLine({
            orderQty,
            product: prodPlain,
            rmLines,
            pmLines,
            fillSizeOverride: packFromSo,
            bom: bom ? (bom.get ? bom.get({ plain: true }) : bom) : null,
          });

          await PlanningExtracted.create({
            sales_order_id: newSO.id,
            product_id: productId,
            order_qty_display: `${orderQty} units`,
            total_kg_display: safeTotalKg ? `${safeTotalKg} KG` : null,
            order_date: orderDate || null,
            due_date: dueDate || null,
            batch_size_display: batchSizeKg ? `${batchSizeKg} KG` : null,
            batches_required: batchesRequired,
            batch_count: 0,
            batch_size_kg: batchSizeKg,
            bom_status: bom ? 'Confirmed' : 'Pending',
            // BOM is never auto-confirmed on SO creation: planner must confirm BOM + SG on first-batch flow.
            bom_confirmed_at: null,
            approved_by: createdByName,
            raw_materials,
            packaging_materials,
          });
        }
      }
    }

    const order = await FulfillmentOrder.create({
      so_no: soNo,
      sales_order_id: resolvedSalesOrderId,
      customer_name: customer,
      customer_city: customerCity || null,
      vendor_client_id: clientMaster.id,
      order_date: orderDate || null,
      due_date: dueDate || null,
      priority: priority || 'normal',
      so_status: 'planned',
      commercial_status: 'received',
      so_value: soValue,
      ship_address: shipAddress || null,
      payment_terms: paymentTerms || null,
      notes: notes || null,
    });

    if (items && items.length) {
      const soSuffix = soNo.replace(/\D/g, '').slice(-4) || String(order.id).padStart(4, '0');
      let splitCounter = 0;
      const totalSplits = items.reduce((sum, it) => sum + (it.batchSplits?.length || 1), 0);

      for (const item of items) {
        // Resolve product_code for dashboard display (best-effort; falls back to null)
        let itemProductCode = null;
        if (item.sku) {
          const prod = await Product.findOne({ where: { zoho_sku_code: item.sku }, attributes: ['product_code'] });
          if (prod) itemProductCode = prod.product_code || null;
        }
        if (!itemProductCode && item.productName) {
          const prod = await Product.findOne({ where: { product_name: item.productName }, attributes: ['product_code'] });
          if (prod) itemProductCode = prod.product_code || null;
        }

        const orderItem = await FulfillmentOrderItem.create({
          fulfillment_order_id: order.id,
          item_no: item.itemNo || '001',
          sku: item.sku || null,
          product_name: item.productName,
          product_code: itemProductCode,
          pack: normalizePackSizeForOrder(item.pack) || null,
          ordered_qty: item.orderedQty || 0,
          rate: item.unitPrice || 0,
          unit_price: item.unitPrice || 0,
          mrp_price: (item.mrp != null && Number(item.mrp) > 0) ? Number(item.mrp) : null,
          tax_pct: Number(item.taxPct) || 0,
          tax_amount: Number(item.taxAmount) || 0,
        });

        const splits = item.batchSplits || [{ plannedQty: item.orderedQty }];
        for (const split of splits) {
          splitCounter++;
          let productionBatchId = null;
          let bmrNo = split.bmrNo || null;
          let bprNo = split.bprNo || null;

          // IMPORTANT: Fulfillment SO creation MUST NOT auto-generate new BMR/BPR numbers.
          // BMR/BPR should only be created later by Planning when the user confirms BOM per batch.
          // Here we only link to *already existing* production batches when the request includes bmrNo/bprNo.
          let pb = null;
          if (bmrNo) {
            pb = await ProductionBatch.findOne({ where: { bmr_no: bmrNo } });
          }
          if (!pb && bprNo) {
            pb = await ProductionBatch.findOne({ where: { bpr_no: bprNo } });
          }
          if (pb) {
            productionBatchId = pb.id;
            bmrNo = pb.bmr_no;
            bprNo = pb.bpr_no;
          }

          await FulfillmentBatchSplit.create({
            fulfillment_order_item_id: orderItem.id,
            fulfillment_order_id: order.id,
            production_batch_id: productionBatchId,
            bmr_no: bmrNo,
            bpr_no: bprNo,
            planned_qty: split.plannedQty || 0,
            fg_qty: split.fgQty || 0,
            fg_location: split.fgLocation || null,
            ff_status: split.ffStatus || 'fg_pending',
          });

          // Reserve RM/PM for this SO batch: BOM qty × planned qty → reserved_batch_items
          const plannedQty = split.plannedQty || item.orderedQty || 0;
          let productId = null;
          if (item.sku) {
            const prod = await Product.findOne({ where: { zoho_sku_code: item.sku } });
            if (prod) productId = prod.product_id;
          }
          if (!productId && item.productName) {
            const prod = await Product.findOne({ where: { product_name: item.productName } });
            if (prod) productId = prod.product_id;
          }
          // Only reserve if we are linked to an existing production batch.
          // When BMR/BPR are not created yet (expected), reservation happens later in production flow.
          if (productionBatchId && productId && plannedQty > 0) {
            const bom = await BOM.findOne({ where: { product_id: productId } });
            if (bom) {
              const rmLines = Array.isArray(bom.rm_lines) ? bom.rm_lines : [];
              const pmLines = Array.isArray(bom.pm_lines) ? bom.pm_lines : [];
              for (const line of rmLines) {
                let rm = null;
                if (line.raw_material_id != null) {
                  rm = await RawMaterial.findByPk(line.raw_material_id);
                }
                if (!rm) {
                  const code = line.rm_code || line.rmCode || line.code;
                  if (!code) continue;
                  rm = await RawMaterial.findOne({ where: { code } });
                }
                if (!rm) continue;
                const qtyPerUnit = line.quantity != null ? Number(line.quantity) : (line.pct_w_w != null ? Number(line.pct_w_w) / 100 : 0);
                const qtyReserved = roundPlanningMaterialQty(qtyPerUnit * plannedQty);
                if (qtyReserved <= 0) continue;
                await ReservedBatchItem.create({
                  production_batch_id: productionBatchId,
                  fulfillment_order_item_id: orderItem.id,
                  raw_material_id: rm.id,
                  pack_material_id: null,
                  quantity_reserved: qtyReserved,
                  unit: line.uom || 'KG',
                  so_no: soNo,
                });
              }
              for (const line of pmLines) {
                let pm = null;
                if (line.pack_material_id != null) {
                  pm = await PackMaterial.findByPk(line.pack_material_id);
                }
                if (!pm) {
                  const code = line.pm_code || line.pmCode || line.code;
                  if (!code) continue;
                  pm = await PackMaterial.findOne({ where: { code } });
                }
                if (!pm) continue;
                const qtyPerUnit = line.qty_per_unit != null ? Number(line.qty_per_unit) : 1;
                const qtyReserved = roundPlanningMaterialQty(qtyPerUnit * plannedQty);
                if (qtyReserved <= 0) continue;
                await ReservedBatchItem.create({
                  production_batch_id: productionBatchId,
                  fulfillment_order_item_id: orderItem.id,
                  raw_material_id: null,
                  pack_material_id: pm.id,
                  quantity_reserved: qtyReserved,
                  unit: line.uom || 'PCS',
                  so_no: soNo,
                });
              }
            }
          }
        }
      }
    }

    const created = await FulfillmentOrder.findByPk(order.id, { include: INCLUDE_FULL });
    res.status(201).json(formatOrder(created));
  } catch (err) {
    console.error('createOrder error:', err);
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'A fulfillment order with this SO number already exists' });
    }
    res.status(500).json({ error: 'Failed to create fulfillment order' });
  }
}

async function updateOrder(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await FulfillmentOrder.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Fulfillment order not found' });
    const rowPlain = row.get ? row.get({ plain: true }) : row;

    const CAMEL_MAP = {
      soNo: 'so_no', salesOrderId: 'sales_order_id',
      customer: 'customer_name', customerCity: 'customer_city',
      orderDate: 'order_date', dueDate: 'due_date',
      soStatus: 'so_status', soValue: 'so_value',
      shipAddress: 'ship_address', paymentTerms: 'payment_terms',
      invoiceNo: 'invoice_no', invoiceDate: 'invoice_date',
      awbNo: 'awb_no', dispatchDate: 'dispatch_date',
    };
    const ALLOWED = [
      'so_no', 'sales_order_id', 'customer_name', 'customer_city',
      'order_date', 'due_date', 'priority', 'so_status', 'so_value',
      'ship_address', 'payment_terms', 'notes',
      'invoice_no', 'invoice_date', 'awb_no', 'dispatch_date', 'courier',
      // Force-edit (edit regardless of status/approvals) may also set the commercial lifecycle
      // and clear a manual cancel/fulfill freeze.
      'commercial_status', 'manual_status_override',
    ];
    const hasItemsPayload = Array.isArray(req.body.items);
    const requestedKeys = Object.keys(req.body || {});
    const mutableKeys = new Set([
      ...ALLOWED,
      ...Object.keys(CAMEL_MAP),
      'items',
    ]);
    const hasMutableChangeRequest = requestedKeys.some((k) => mutableKeys.has(k));


    if (req.body.payment_terms !== undefined || req.body.paymentTerms !== undefined) {
      const ptToCheck = req.body.paymentTerms !== undefined ? req.body.paymentTerms : req.body.payment_terms;
      const ptErr = validateStagedPaymentTermsJson(ptToCheck);
      if (ptErr) return res.status(400).json({ error: ptErr });
    }

    for (const k of ALLOWED) {
      if (req.body[k] !== undefined) row.set(k, req.body[k]);
    }
    for (const [camel, snake] of Object.entries(CAMEL_MAP)) {
      if (req.body[camel] !== undefined) row.set(snake, req.body[camel]);
    }

    // "Update SO Status" (Edit SO modal). The authoritative order status lives on sales_orders.status
    // (Draft/Approved/Confirmed/Cancelled/Closed) — it drives Planning → PIS Extracted visibility
    // (draft/cancelled are hidden). We mirror it onto the fulfillment commercial_status so the SO
    // Dashboard pill reflects the change immediately; the actual sales_orders write happens post-save.
    const SO_STATUS_TO_COMMERCIAL = {
      draft: 'draft', approved: 'approved', confirmed: 'received',
      closed: 'closed', cancelled: 'cancelled', canceled: 'cancelled',
    };
    const rawSoOrderStatus =
      req.body.salesOrderStatus ?? req.body.sales_order_status ?? req.body.orderStatus;
    let nextSalesOrderStatus = null;
    if (rawSoOrderStatus !== undefined && rawSoOrderStatus !== null && String(rawSoOrderStatus).trim() !== '') {
      const key = String(rawSoOrderStatus).trim().toLowerCase();
      if (!SO_STATUS_TO_COMMERCIAL[key]) {
        return res.status(400).json({ error: `Invalid SO status: ${rawSoOrderStatus}` });
      }
      // Canonical stored form on sales_orders.status is Capitalized (and canceled → Cancelled).
      nextSalesOrderStatus = key === 'canceled' ? 'Cancelled' : key.charAt(0).toUpperCase() + key.slice(1);
      row.set('commercial_status', SO_STATUS_TO_COMMERCIAL[key]);

      // Cancelling freezes the row: cancelOrder() sets so_status='cancelled' AND
      // manual_status_override=true so nothing recomputes over it. Nothing cleared that on the way
      // back, so moving an SO out of Cancelled updated sales_orders.status while `formatOrder` kept
      // returning the frozen 'cancelled' — the status looked unchanged in every fulfillment view.
      // Un-freezing lets so_status recompute from the batch splits again.
      const leavingCancelled =
        key !== 'cancelled' && key !== 'canceled' &&
        (String(row.get('so_status') || '').toLowerCase() === 'cancelled' ||
          row.get('manual_status_override') === true);
      if (leavingCancelled) {
        row.set('manual_status_override', false);
        // 'closed' is its own deliberate freeze (closeOrder), so it keeps an explicit status.
        row.set('so_status', key === 'closed' ? 'closed' : 'planned');
        if (key === 'closed') row.set('manual_status_override', true);
      }

      // Same block as the dedicated /:id/cancel endpoint (findConfirmedProductionBatchBlockingCancel,
      // below) — Edit SO → Update SO Status is a second path to 'Cancelled' and must not bypass it.
      if (nextSalesOrderStatus === 'Cancelled') {
        const blocking = await findConfirmedProductionBatchBlockingCancel(rowPlain.sales_order_id);
        if (blocking) {
          const label = blocking.productName
            ? `${blocking.productName} (${blocking.batchCode || 'batch'})`
            : (blocking.batchCode || 'A batch on this order');
          return res.status(409).json({
            error: `Cannot cancel this sale order — ${label} has already been confirmed by Production`
              + `${blocking.bmrNo ? ` (${blocking.bmrNo})` : ''}. It can no longer be cancelled from here.`,
            code: 'SO_HAS_CONFIRMED_PRODUCTION_BATCH',
            blockedBatch: blocking,
          });
        }
      }
    }

    if (hasItemsPayload) {
      const nextItems = req.body.items
        .filter((item) => item && String(item.productName || '').trim())
        .map((item, idx) => ({
          itemNo: item.itemNo || String(idx + 1).padStart(3, '0'),
          sku: item.sku || null,
          productName: String(item.productName || '').trim(),
          pack: normalizePackSizeForOrder(item.pack) || null,
          orderedQty: Number(item.orderedQty || 0),
          unitPrice: Number(item.unitPrice || 0),
          // MRP is stored separately on the SO line (from the product master, then editable).
          // It was being dropped here, so edits reset to null on save.
          mrp: item.mrp != null && item.mrp !== '' ? Number(item.mrp) : null,
          // Per-line tax entered on the SO — no platform-side default/hardcoded GST%.
          taxPct: Number(item.taxPct) || 0,
          taxAmount: Number(item.taxAmount) || 0,
        }))
        .filter((item) => item.orderedQty > 0 && item.unitPrice > 0);

      if (!nextItems.length) {
        return res.status(400).json({ error: 'At least one valid item is required.' });
      }

      const existingItems = await FulfillmentOrderItem.findAll({
        where: { fulfillment_order_id: id },
        attributes: ['id'],
      });
      const existingItemIds = existingItems.map((it) => (it.get ? it.get('id') : it.id));
      if (existingItemIds.length > 0) {
        await FulfillmentBatchSplit.destroy({
          where: { fulfillment_order_item_id: { [Op.in]: existingItemIds } },
        });
      }
      await FulfillmentOrderItem.destroy({ where: { fulfillment_order_id: id } });

      for (const item of nextItems) {
        const createdItem = await FulfillmentOrderItem.create({
          fulfillment_order_id: id,
          item_no: item.itemNo,
          sku: item.sku,
          product_name: item.productName,
          pack: item.pack,
          ordered_qty: item.orderedQty,
          rate: item.unitPrice,
          unit_price: item.unitPrice,
          mrp_price: (item.mrp != null && Number(item.mrp) > 0) ? Number(item.mrp) : null,
          tax_pct: item.taxPct || 0,
          tax_amount: item.taxAmount || 0,
        });

        await FulfillmentBatchSplit.create({
          fulfillment_order_item_id: createdItem.id,
          fulfillment_order_id: id,
          production_batch_id: null,
          bmr_no: null,
          bpr_no: null,
          planned_qty: item.orderedQty,
          fg_qty: 0,
          fg_location: null,
          ff_status: 'fg_pending',
        });
      }

      // Final payable total: line subtotals + each line's own tax amount. No flat/hardcoded GST% added.
      const nextSoValue = nextItems.reduce(
        (sum, item) => sum + item.orderedQty * item.unitPrice + (item.taxAmount || 0),
        0
      );
      row.set('so_value', nextSoValue);
      if (rowPlain.sales_order_id) {
        await SalesOrder.update(
          {
            customer_name: row.get('customer_name'),
            order_date: row.get('order_date'),
            expected_shipment_date: row.get('due_date'),
            payment_terms: row.get('payment_terms'),
            items: nextItems.map((it) => ({
              sku: it.sku || '',
              productName: it.productName,
              pack: it.pack || '',
              quantity: it.orderedQty,
              unitPrice: it.unitPrice,
            })),
          },
          { where: { id: rowPlain.sales_order_id } }
        );
      }
    }

    await row.save();

    // Persist the authoritative order status to sales_orders.status so Planning → PIS Extracted
    // picks it up on its next self-healing sync (draft/cancelled SOs get hidden; a cancelled SO's
    // planning batches are permanently deleted there and its requirement drops out of Items Involved).
    if (nextSalesOrderStatus && rowPlain.sales_order_id) {
      await SalesOrder.update(
        { status: nextSalesOrderStatus },
        { where: { id: rowPlain.sales_order_id } }
      );
    }

    // Cancelling an SO permanently deletes ALL its planning batches — immediately here (so it happens
    // the instant the SO is cancelled, not only on the next Planning self-healing sync). Warn if any
    // were already sent to production (BMR/BPR raised), since that work is being discarded.
    let cancelWarning = null;
    if (nextSalesOrderStatus === 'Cancelled' && rowPlain.sales_order_id) {
      const PlanningExtracted = require('../planningExtracted/models');
      const PlanningBatch = require('../planningExtracted/planningBatchModel');
      const pis = await PlanningExtracted.findAll({
        where: { sales_order_id: rowPlain.sales_order_id },
        attributes: ['id', 'sent_batch_indices'],
      });
      const planIds = pis.map((pi) => (pi.get ? pi.get('id') : pi.id));
      const sentCount = pis.reduce((n, pi) => {
        const raw = pi.get ? pi.get('sent_batch_indices') : pi.sent_batch_indices;
        return n + (Array.isArray(raw) ? raw.length : 0);
      }, 0);
      if (planIds.length > 0) {
        // Cascade to Production FIRST (capture planning batch ids before the hard-delete severs the link):
        // a cancelled SO must leave no live production batch behind.
        const pbRows = await PlanningBatch.findAll({
          where: { planning_extracted_id: { [Op.in]: planIds } },
          attributes: ['id'],
        });
        const planningBatchIds = pbRows.map((b) => (b.get ? b.get('id') : b.id));
        if (planningBatchIds.length > 0) {
          const prodRemoved = await softDeleteWhere(ProductionBatch, {
            planning_batch_id: { [Op.in]: planningBatchIds },
          });
          if (prodRemoved > 0) {
            console.warn(
              `[fulfillment] SO ${rowPlain.sales_order_id} cancelled — soft-deleted ${prodRemoved} production batch(es).`
            );
          }
        }
        const removed = await PlanningBatch.destroy({
          where: { planning_extracted_id: { [Op.in]: planIds } },
        });
        if (removed > 0) {
          console.warn(
            `[fulfillment] SO ${rowPlain.sales_order_id} cancelled — deleted ${removed} planning batch(es).`
          );
        }
      }
      if (sentCount > 0) {
        cancelWarning = `This SO has ${sentCount} batch(es) already sent to production. Cancelling deletes all of its planning batches.`;
      }
    }

    const updated = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    let orderStatus = nextSalesOrderStatus;
    if (orderStatus == null && rowPlain.sales_order_id) {
      const so = await SalesOrder.findByPk(rowPlain.sales_order_id, { attributes: ['status'] });
      orderStatus = so ? (so.get('status') || null) : null;
    }
    res.json({ ...formatOrder(updated, {}, { orderStatus }), ...(cancelWarning ? { warning: cancelWarning } : {}) });
  } catch (err) {
    console.error('updateOrder error:', err);
    res.status(500).json({ error: 'Failed to update fulfillment order' });
  }
}

async function deleteOrder(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await FulfillmentOrder.findOne({ where: activeRowWhere({ id }) });
    if (!row) return res.status(404).json({ error: 'Fulfillment order not found' });
    await softDeleteWhere(FulfillmentBatchSplit, { fulfillment_order_id: id });
    await softDeleteWhere(FulfillmentOrderItem, { fulfillment_order_id: id });
    await softDeleteInstance(row);
    res.json({ message: 'Fulfillment order deleted' });
  } catch (err) {
    console.error('deleteOrder error:', err);
    res.status(500).json({ error: 'Failed to delete fulfillment order' });
  }
}

/**
 * PATCH /:id/cancel — cancel a sales order regardless of status/approvals.
 * Freezes status (manual_status_override) so split recompute can't revive it.
 */
/**
 * A SO can carry several product/PR lines, each with its own batches. If ANY line's batch has
 * already been confirmed by Production (`bmr_status` advanced past 'draft'), the whole SO is
 * blocked from cancellation — cancelling hard-deletes planning batches and soft-deletes production
 * batches under them (see below), which would silently orphan real work already underway on the
 * floor. Returns the first blocking batch found (product name + batch code + BMR no), or null.
 */
async function findConfirmedProductionBatchBlockingCancel(salesOrderId) {
  if (!salesOrderId) return null;
  const PlanningExtracted = require('../planningExtracted/models');
  const PlanningBatch = require('../planningExtracted/planningBatchModel');
  const { isPlanningBatchEditableByProduction } = require('../planningExtracted/planningBatchEditLock');

  const planningRows = await PlanningExtracted.findAll({
    where: { sales_order_id: salesOrderId },
    attributes: ['id'],
    include: [{ model: Product, as: 'product', attributes: ['product_name'] }],
  });
  const productNameByPlanId = new Map();
  planningRows.forEach((r) => {
    const d = r.get ? r.get({ plain: true }) : r;
    productNameByPlanId.set(d.id, d.product?.product_name || null);
  });
  const planIds = [...productNameByPlanId.keys()];
  if (planIds.length === 0) return null;

  const planningBatchRows = await PlanningBatch.findAll({
    where: { planning_extracted_id: { [Op.in]: planIds } },
    attributes: ['id', 'batch_code', 'planning_extracted_id'],
  });
  const batchMetaById = new Map();
  planningBatchRows.forEach((b) => {
    const d = b.get ? b.get({ plain: true }) : b;
    batchMetaById.set(d.id, { batchCode: d.batch_code, productName: productNameByPlanId.get(d.planning_extracted_id) });
  });
  const batchIds = [...batchMetaById.keys()];
  if (batchIds.length === 0) return null;

  const prodRows = await ProductionBatch.findAll({
    where: { planning_batch_id: { [Op.in]: batchIds } },
    attributes: ['planning_batch_id', 'bmr_status', 'bmr_no'],
  });
  for (const row of prodRows) {
    const d = row.get ? row.get({ plain: true }) : row;
    if (isPlanningBatchEditableByProduction(d.bmr_status)) continue;
    const meta = batchMetaById.get(d.planning_batch_id) || {};
    return { ...meta, bmrNo: d.bmr_no || null, bmrStatus: d.bmr_status || null };
  }
  return null;
}

async function cancelOrder(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await FulfillmentOrder.findOne({ where: activeRowWhere({ id }) });
    if (!row) return res.status(404).json({ error: 'Fulfillment order not found' });

    const blocking = await findConfirmedProductionBatchBlockingCancel(row.get('sales_order_id'));
    if (blocking) {
      const label = blocking.productName
        ? `${blocking.productName} (${blocking.batchCode || 'batch'})`
        : (blocking.batchCode || 'A batch on this order');
      return res.status(409).json({
        error: `Cannot cancel this sale order — ${label} has already been confirmed by Production`
          + `${blocking.bmrNo ? ` (${blocking.bmrNo})` : ''}. It can no longer be cancelled from here.`,
        code: 'SO_HAS_CONFIRMED_PRODUCTION_BATCH',
        blockedBatch: blocking,
      });
    }

    const reason = String(req.body?.reason || '').trim();
    const prevNotes = row.get('notes') || '';
    await row.update({
      so_status: 'cancelled',
      commercial_status: 'cancelled',
      manual_status_override: true,
      notes: reason ? `${prevNotes}${prevNotes ? '\n' : ''}[Cancelled] ${reason}`.trim() : prevNotes,
    });

    // Mirror the Edit-SO → "Cancelled" path: the authoritative order status lives on
    // sales_orders.status, and the SO Dashboard pill resolves from THAT first (falling back to
    // commercial_status only when it's blank). Without this write the row keeps showing its prior
    // status (e.g. "Approved") even though the fulfillment row is cancelled. We also permanently
    // delete the SO's planning batches so its requirement drops out of Planning → Items Involved,
    // exactly as cancelling from the Edit-SO modal does.
    const salesOrderId = row.get('sales_order_id');
    if (salesOrderId) {
      await SalesOrder.update({ status: 'Cancelled' }, { where: { id: salesOrderId } });
      const PlanningExtracted = require('../planningExtracted/models');
      const PlanningBatch = require('../planningExtracted/planningBatchModel');
      const pis = await PlanningExtracted.findAll({
        where: { sales_order_id: salesOrderId },
        attributes: ['id'],
      });
      const planIds = pis.map((pi) => (pi.get ? pi.get('id') : pi.id));
      if (planIds.length > 0) {
        // Cascade to Production FIRST — capture the planning batch ids before they are destroyed, then
        // soft-delete the production batches linked to them. Otherwise the hard-delete below severs the
        // planning_batch_id link and leaves live production batches orphaned under a cancelled SO.
        const pbRows = await PlanningBatch.findAll({
          where: { planning_extracted_id: { [Op.in]: planIds } },
          attributes: ['id'],
        });
        const planningBatchIds = pbRows.map((b) => (b.get ? b.get('id') : b.id));
        if (planningBatchIds.length > 0) {
          const prodRemoved = await softDeleteWhere(ProductionBatch, {
            planning_batch_id: { [Op.in]: planningBatchIds },
          });
          if (prodRemoved > 0) {
            console.warn(`[fulfillment] SO ${salesOrderId} cancelled — soft-deleted ${prodRemoved} production batch(es).`);
          }
        }
        const removed = await PlanningBatch.destroy({
          where: { planning_extracted_id: { [Op.in]: planIds } },
        });
        if (removed > 0) {
          console.warn(`[fulfillment] SO ${salesOrderId} cancelled — deleted ${removed} planning batch(es).`);
        }
      }
    }

    const updated = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    res.json(formatOrder(updated, {}, { orderStatus: salesOrderId ? 'Cancelled' : null }));
  } catch (err) {
    console.error('cancelOrder error:', err);
    res.status(500).json({ error: 'Failed to cancel sales order' });
  }
}

/**
 * PATCH /:id/manual-fulfill — mark a sales order fulfilled without the pick/invoice/ship/deliver
 * workflow. Sets so_status + commercial_status to closed and freezes recompute.
 */
async function manualFulfillOrder(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await FulfillmentOrder.findOne({ where: activeRowWhere({ id }) });
    if (!row) return res.status(404).json({ error: 'Fulfillment order not found' });
    const reason = String(req.body?.reason || '').trim();
    const prevNotes = row.get('notes') || '';
    await row.update({
      so_status: 'closed',
      commercial_status: 'closed',
      manual_status_override: true,
      notes: reason ? `${prevNotes}${prevNotes ? '\n' : ''}[Manually fulfilled] ${reason}`.trim() : prevNotes,
    });
    res.json(formatOrder(await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL })));
  } catch (err) {
    console.error('manualFulfillOrder error:', err);
    res.status(500).json({ error: 'Failed to manually fulfill sales order' });
  }
}

/* ── Workflow Actions ── */

async function pickSplits(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const order = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    if (!order) return res.status(404).json({ error: 'Fulfillment order not found' });

    const { splits, pickerName, pickDate, pickSlipNo, remarks } = req.body;
    if (!pickerName || !splits || !splits.length) {
      return res.status(400).json({ error: 'pickerName and splits are required' });
    }

    for (const pickInfo of splits) {
      const split = await FulfillmentBatchSplit.findOne({
        where: { fulfillment_order_id: id, bpr_no: pickInfo.bprNo },
      });
      if (!split) continue;
      const stored = split.ff_status;
      let canPick = stored === 'fg_ready';
      if (!canPick && stored === 'fg_pending' && split.production_batch_id) {
        const batch = await ProductionBatch.findByPk(split.production_batch_id, { attributes: ['bpr_status'] });
        const bprStatus = batch && (batch.get ? batch.get('bpr_status') : batch.bpr_status);
        canPick = bprStatus === 'fg_ready';
      }
      if (canPick) {
        split.set({
          ff_status: 'picking',
          picked_qty: pickInfo.pickedQty || split.fg_qty,
          picker_name: pickerName,
          pick_date: pickDate || new Date().toISOString().slice(0, 10),
          pick_slip_no: pickSlipNo || null,
          remarks: remarks || null,
        });
        await split.save();
        // Open stage log for picking (best-effort; don't let log failure block the pick)
        try {
          await openStageLog({
            splitId: split.id,
            orderId: id,
            stage: 'picking',
            actorName: pickerName,
            actorUserId: req.user ? (req.user.id || req.user.userId || null) : null,
            productId: null,
          });
        } catch (_logErr) { console.warn('pickSplits: stage log write failed', _logErr.message); }
      }
    }

    const allSplits = await FulfillmentBatchSplit.findAll({ where: { fulfillment_order_id: id } });
    order.set('so_status', recalculateSOStatus(allSplits));
    await order.save();

    // Mirror stage into website orders table when picking starts
    await Order.update({ fulfillment_stage: 'packaged' }, { where: { so_no: order.so_no } });

    const refreshed = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    res.json(formatOrder(refreshed));
  } catch (err) {
    console.error('pickSplits error:', err);
    res.status(500).json({ error: 'Failed to process pick' });
  }
}

async function invoiceSplits(req, res) {
  const tx = await FulfillmentOrder.sequelize.transaction();
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      await tx.rollback();
      return res.status(400).json({ error: 'Invalid id' });
    }

    const order = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL, transaction: tx });
    if (!order) {
      await tx.rollback();
      return res.status(404).json({ error: 'Fulfillment order not found' });
    }

    const { invoiceNo, invoiceDate, courier, bprNos } = req.body;
    if (!invoiceNo) {
      await tx.rollback();
      return res.status(400).json({ error: 'invoiceNo is required' });
    }

    const where = { fulfillment_order_id: id, ff_status: 'picking' };
    if (Array.isArray(bprNos) && bprNos.length > 0) {
      where.bpr_no = { [Op.in]: bprNos };
    }

    // Capture split IDs before updating so we can transition stage logs
    const pickingSplits = await FulfillmentBatchSplit.findAll({ where, attributes: ['id'], transaction: tx });
    const pickingSplitIds = pickingSplits.map((s) => s.id);

    await FulfillmentBatchSplit.update(
      { ff_status: 'invoiced', invoice_no: invoiceNo },
      { where, transaction: tx }
    );

    // Transition stage logs inside tx so a Zoho rollback also reverts the log entries
    for (const splitId of pickingSplitIds) {
      try {
        await closeStageLog({ splitId, stage: 'picking', transaction: tx });
        await openStageLog({
          splitId,
          orderId: id,
          stage: 'invoiced',
          actorName: req.user ? (req.user.fullName || req.user.email || null) : null,
          actorUserId: req.user ? (req.user.id || req.user.userId || null) : null,
          productId: null,
          transaction: tx,
        });
      } catch (_logErr) { console.warn('invoiceSplits: stage log transition failed', _logErr.message); }
    }

    order.set({
      invoice_no: invoiceNo,
      invoice_date: invoiceDate || new Date().toISOString().slice(0, 10),
      courier: courier || null,
    });

    const allSplits = await FulfillmentBatchSplit.findAll({ where: { fulfillment_order_id: id }, transaction: tx });
    order.set('so_status', recalculateSOStatus(allSplits));
    await order.save({ transaction: tx });

    // Mirror stage into website orders table when invoiced
    await Order.update({ fulfillment_stage: 'invoiced' }, { where: { so_no: order.so_no }, transaction: tx });

    const {
      vendorClientId,
      vendor_client_id: vendorClientIdSnake,
      userId,
      user_id: userIdSnake,
      lineItems: zohoLineItems,
    } = req.body || {};

    const zoho = await syncZohoInvoiceAfterFulfillment({
      fulfillmentOrder: order,
      lineItemsFromBody: Array.isArray(zohoLineItems) && zohoLineItems.length > 0 ? zohoLineItems : null,
      invoiceNo,
      invoiceDate: invoiceDate || new Date().toISOString().slice(0, 10),
      dueDate: null,
      vendorClientId: vendorClientId ?? vendorClientIdSnake,
      userId: userId ?? userIdSnake,
    });
    if (zohoEnv.booksEnabled && zohoEnv.syncInvoices && !zoho.synced) {
      const err = new Error(zoho.error || 'zoho_invoice_sync_failed');
      err.statusCode = 502;
      err.clientMessage = zohoInvoiceSyncRollbackMessage(zoho.error);
      throw err;
    }
    if (zoho.synced && zoho.invoiceId) {
      await order.update({ zoho_invoice_id: zoho.invoiceId }, { transaction: tx });
    }

    await tx.commit();
    const refreshed = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    res.json(formatOrder(refreshed));
  } catch (err) {
    if (!tx.finished) await tx.rollback();
    console.error('invoiceSplits error:', err);
    if (err && err.statusCode) {
      return res.status(err.statusCode).json({ error: err.clientMessage || err.message || 'Zoho invoice sync failed' });
    }
    res.status(500).json({ error: 'Failed to process invoice' });
  }
}

async function shipSplits(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const order = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    if (!order) return res.status(404).json({ error: 'Fulfillment order not found' });

    const { awbNo, courier, dispatchDate, eta, bprNos } = req.body;

    const where = { fulfillment_order_id: id, ff_status: 'invoiced' };
    if (Array.isArray(bprNos) && bprNos.length > 0) {
      where.bpr_no = { [Op.in]: bprNos };
    }

    // Capture split IDs for stage log transitions
    const invoicedSplits = await FulfillmentBatchSplit.findAll({ where, attributes: ['id'] });
    const invoicedSplitIds = invoicedSplits.map((s) => s.id);

    await FulfillmentBatchSplit.update(
      {
        ff_status: 'shipped',
        awb_no: awbNo || null,
        courier: courier || null,
        dispatch_date: dispatchDate || new Date().toISOString().slice(0, 10),
        eta_date: eta || null,
      },
      { where }
    );

    // Transition stage logs: close invoiced → open shipped
    for (const splitId of invoicedSplitIds) {
      try {
        await closeStageLog({ splitId, stage: 'invoiced' });
        await openStageLog({
          splitId,
          orderId: id,
          stage: 'shipped',
          actorName: req.user ? (req.user.fullName || req.user.email || null) : null,
          actorUserId: req.user ? (req.user.id || req.user.userId || null) : null,
          productId: null,
        });
      } catch (_logErr) { console.warn('shipSplits: stage log transition failed', _logErr.message); }
    }

    order.set({
      awb_no: awbNo || null,
      dispatch_date: dispatchDate || new Date().toISOString().slice(0, 10),
      courier: courier || null,
    });

    const allSplits = await FulfillmentBatchSplit.findAll({ where: { fulfillment_order_id: id } });
    order.set('so_status', recalculateSOStatus(allSplits));

    // Auto-advance commercial_status based on shipped qty (approved → partial_closed or closed)
    try {
      const orderItems = await FulfillmentOrderItem.findAll({ where: { fulfillment_order_id: id }, attributes: ['ordered_qty'] });
      const totalOrdered = orderItems.reduce((s, it) => s + (Number(it.ordered_qty) || 0), 0);
      const totalShipped = allSplits
        .filter((s) => ['shipped', 'delivered', 'closed'].includes(s.ff_status))
        .reduce((sum, s) => sum + (Number(s.picked_qty) || 0), 0);
      const currentCommercial = order.commercial_status || 'received';
      const nextCommercial = computeCommercialStatusFromShippedQty(currentCommercial, totalOrdered, totalShipped);
      if (nextCommercial) order.set('commercial_status', nextCommercial);
    } catch (_csErr) { console.warn('shipSplits: commercial status compute failed', _csErr.message); }

    await order.save();

    // Mirror stage into website orders table when shipped
    await Order.update({ fulfillment_stage: 'shipped' }, { where: { so_no: order.so_no } });

    const refreshed = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    res.json(formatOrder(refreshed));
  } catch (err) {
    console.error('shipSplits error:', err);
    res.status(500).json({ error: 'Failed to process shipment' });
  }
}

async function deliverSplits(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const order = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    if (!order) return res.status(404).json({ error: 'Fulfillment order not found' });

    const { deliveryDate, receivedBy, remarks, bprNos } = req.body;

    const where = { fulfillment_order_id: id, ff_status: 'shipped' };
    if (Array.isArray(bprNos) && bprNos.length > 0) {
      where.bpr_no = { [Op.in]: bprNos };
    }

    // Capture split IDs for stage log close
    const shippedSplits = await FulfillmentBatchSplit.findAll({ where, attributes: ['id'] });
    const shippedSplitIds = shippedSplits.map((s) => s.id);

    // Mark the delivered batch(es) as closed (done). SO closes only when all batches are closed.
    await FulfillmentBatchSplit.update(
      {
        ff_status: 'closed',
        delivery_date: deliveryDate || new Date().toISOString().slice(0, 10),
        received_by: receivedBy || null,
        delivery_remarks: remarks || null,
      },
      { where }
    );

    // Close shipped stage logs
    for (const splitId of shippedSplitIds) {
      try { await closeStageLog({ splitId, stage: 'shipped' }); }
      catch (_logErr) { console.warn('deliverSplits: stage log close failed', _logErr.message); }
    }

    const allSplits = await FulfillmentBatchSplit.findAll({ where: { fulfillment_order_id: id } });
    const newStatus = recalculateSOStatus(allSplits);
    order.set('so_status', newStatus);

    // Auto-advance commercial_status to closed if all qty delivered
    try {
      const orderItems = await FulfillmentOrderItem.findAll({ where: { fulfillment_order_id: id }, attributes: ['ordered_qty'] });
      const totalOrdered = orderItems.reduce((s, it) => s + (Number(it.ordered_qty) || 0), 0);
      const totalShipped = allSplits
        .filter((s) => ['shipped', 'delivered', 'closed'].includes(s.ff_status))
        .reduce((sum, s) => sum + (Number(s.picked_qty) || 0), 0);
      const currentCommercial = order.commercial_status || 'received';
      const nextCommercial = computeCommercialStatusFromShippedQty(currentCommercial, totalOrdered, totalShipped);
      if (nextCommercial) order.set('commercial_status', nextCommercial);
    } catch (_csErr) { console.warn('deliverSplits: commercial status compute failed', _csErr.message); }

    await order.save();

    const refreshed = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    res.json(formatOrder(refreshed));
  } catch (err) {
    console.error('deliverSplits error:', err);
    res.status(500).json({ error: 'Failed to process delivery' });
  }
}

/* ── Batch Splits list (for Products & Batches view) ── */

async function listBatchSplits(req, res) {
  try {
    const splits = await FulfillmentBatchSplit.findAll({
      include: [
        {
          model: FulfillmentOrderItem,
          as: 'orderItem',
          attributes: ['id', 'sku', 'product_name', 'pack', 'ordered_qty', 'unit_price', 'mrp_price'],
        },
        {
          model: FulfillmentOrder,
          as: 'fulfillmentOrder',
          attributes: ['id', 'so_no', 'customer_name', 'customer_city', 'order_date', 'due_date', 'priority'],
        },
      ],
      order: [['fulfillment_order_id', 'ASC'], ['id', 'ASC']],
    });

    const batchIds = splits.map((row) => {
      const d = row.get({ plain: true });
      return d.production_batch_id;
    }).filter(Boolean);
    const batchMap = await getBatchStatusMap(batchIds);

    res.json(splits.map(row => {
      const d = row.get({ plain: true });
      const formatted = formatSplit(d, batchMap);
      return {
        ...formatted,
        product: {
          sku: d.orderItem?.sku || '',
          productName: d.orderItem?.product_name || '',
          pack: d.orderItem?.pack || '',
          orderedQty: d.orderItem?.ordered_qty || 0,
          unitPrice: d.orderItem?.unit_price != null ? Number(d.orderItem.unit_price) : 0,
          mrp: d.orderItem?.mrp_price != null ? Number(d.orderItem.mrp_price) : null,
        },
        order: {
          id: d.fulfillmentOrder?.id,
          soNo: d.fulfillmentOrder?.so_no || '',
          customer: d.fulfillmentOrder?.customer_name || '',
          customerCity: d.fulfillmentOrder?.customer_city || '',
          orderDate: d.fulfillmentOrder?.order_date,
          dueDate: d.fulfillmentOrder?.due_date,
          priority: d.fulfillmentOrder?.priority || 'normal',
        },
      };
    }));
  } catch (err) {
    console.error('listBatchSplits error:', err);
    res.status(500).json({ error: 'Failed to fetch batch splits' });
  }
}

/* ── Lookup endpoints for AddSOModal ── */

/** First non-empty string from JSON `data` for given keys (camelCase + common variants). */
function pickDataStr(data, keys) {
  if (!data || typeof data !== 'object') return '';
  for (const k of keys) {
    const v = data[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}

async function getNextSoNo(_req, res) {
  try {
    const latest = await FulfillmentOrder.findOne({
      order: [['id', 'DESC']],
      attributes: ['so_no'],
    });

    let nextNum = 1;
    if (latest && latest.so_no) {
      const match = latest.so_no.match(/(\d+)$/);
      if (match) nextNum = parseInt(match[1], 10) + 1;
    }

    const year = new Date().getFullYear();
    const soNo = `EI-SO-${year}-${String(nextNum).padStart(3, '0')}`;
    res.json({ soNo });
  } catch (err) {
    console.error('getNextSoNo error:', err);
    res.status(500).json({ error: 'Failed to generate SO number' });
  }
}

async function getCustomers(_req, res) {
  try {
    const clients = await VendorClient.findAll({
      where: buildActiveClientWhere(),
      attributes: [
        'id', 'entity_code', 'name', 'city', 'location', 'country',
        'email', 'phone', 'category', 'notes', 'priority', 'segment',
        'payment_terms', 'contacts', 'data', 'user_id',
      ],
      order: [['name', 'ASC']],
    });

    const userIds = clients.map((c) => c.user_id).filter((id) => id != null);
    const [addrByUser, geoByUser] = await Promise.all([
      loadShippingBillingByUserIds(userIds),
      loadAddressCityStateCountryByUserIds(userIds),
    ]);

    res.json(clients.map(c => {
      const d = c.get({ plain: true });
      const data = d.data && typeof d.data === 'object' ? d.data : {};
      const fromTable = d.user_id != null ? addrByUser.get(Number(d.user_id)) : null;
      const geo = d.user_id != null ? geoByUser.get(Number(d.user_id)) : null;
      const shipFallback = data.shipping_address || data.shippingAddress || '';
      const billFallback = data.billing_address || data.billingAddress || '';
      const shippingAddress = (fromTable && fromTable.shipping) || shipFallback || '';
      const billingAddress = (fromTable && fromTable.billing) || billFallback || '';
      const contacts = Array.isArray(d.contacts) ? d.contacts : [];
      const contactLine = contacts.length
        ? contacts.map((x) => [x.name, x.role].filter(Boolean).join(' — ')).join('; ')
        : '';
      const city =
        (geo && geo.city) ||
        pickDataStr(data, ['city', 'City']) ||
        (d.city != null && String(d.city).trim() ? String(d.city).trim() : '');
      const state =
        (geo && geo.state) ||
        pickDataStr(data, ['state', 'State', 'region', 'Region']) ||
        (d.location != null && String(d.location).trim() ? String(d.location).trim() : '');
      const country =
        (geo && geo.country) ||
        pickDataStr(data, ['country', 'Country']) ||
        (d.country != null && String(d.country).trim() ? String(d.country).trim() : '');
      return {
        id: d.id,
        code: d.entity_code,
        name: d.name,
        city,
        state,
        country,
        /** State/region — same as `state` (legacy key for FE). */
        location: state,
        email: d.email || '',
        phone: d.phone || '',
        category: d.category || '',
        notes: d.notes || '',
        priority: d.priority || '',
        segment: d.segment || '',
        contacts,
        contactLine,
        paymentTerms: d.payment_terms || '',
        shippingAddress: shippingAddress || '',
        billingAddress: billingAddress || '',
        creditLimit: data.creditLimit != null ? String(data.creditLimit) : '',
        /** Keys used with ClientForm payables + receivables credit days (Fulfillment SO staging). */
        clientData: {
          payablesAdvancedPct: data.payablesAdvancedPct,
          payablesBeforeDispatchPct: data.payablesBeforeDispatchPct,
          payablesAfterDispatchPct: data.payablesAfterDispatchPct,
          receivablesCreditDays: data.receivablesCreditDays,
        },
      };
    }));
  } catch (err) {
    console.error('getCustomers error:', err);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
}

/** Products lookup for Add SO modal: only Finished Goods (FG). RMs and PMs are materials used to build FGs. */
function normalizePackSizeForOrder(pack) {
  const p = String(pack || '').trim();
  if (!p) return '';
  const lower = p.toLowerCase();
  if (lower === '—' || lower === '-' || lower === 'n/a' || lower === 'na') return '';
  return p;
}

async function getProducts(_req, res) {
  try {
    // Sale-order picker: all non-deleted PR masters regardless of approval status (Draft, Under Review, Active, …).
    const products = await Product.findAll({
      where: productActiveWhere(),
      attributes: [
        'product_id',
        'product_code',
        'product_name',
        'zoho_sku_code',
        'form',
        'category',
        'mrp_price',
        'status',
        'lifecycle_status',
      ],
      order: [['product_name', 'ASC']],
    });
    const productIds = products.map((p) => p.product_id).filter((id) => id != null);
    const bomByProductId = new Map();
    if (productIds.length > 0) {
      const boms = await BOM.findAll({
        where: { product_id: { [Op.in]: productIds } },
        attributes: ['product_id', 'sku_bom_limit_qty', 'sku_bom_limit_uom'],
      });
      for (const b of boms) {
        const plain = b.get({ plain: true });
        if (plain.product_id != null) bomByProductId.set(plain.product_id, plain);
      }
    }

    const items = products.map(p => {
      const d = p.get({ plain: true });
      const bom = bomByProductId.get(d.product_id);
      const approvalStatus =
        normalizeMasterApprovalStatus(d.status ?? d.lifecycle_status) || 'Draft';
      return {
        id: `PR-${d.product_id}`,
        type: 'product',
        name: d.product_name || d.product_code,
        sku: d.zoho_sku_code || d.product_code || '',
        pack: packSizeFromBomRow(bom),
        category: d.category || '',
        /** Reference only — SO unit price is resolved per client via GET /client-product-price */
        price: d.mrp_price != null ? Number(d.mrp_price) : 0,
        approvalStatus,
      };
    });

    res.json(items);
  } catch (err) {
    console.error('getProducts error:', err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
}

/** Client + product price from Items List (PR client rates); used when creating sale orders. */
async function getClientProductPrice(req, res) {
  try {
    const { resolveClientProductPrice } = require('../itemsList/resolveClientProductPrice');
    const productId = parseInt(req.query.product_id, 10);
    const clientId = parseInt(req.query.client_id, 10);
    const quantity = req.query.quantity != null ? parseInt(req.query.quantity, 10) : 1;
    if (Number.isNaN(productId) || productId <= 0) {
      return res.status(400).json({ error: 'product_id is required' });
    }
    if (Number.isNaN(clientId) || clientId <= 0) {
      return res.status(400).json({ error: 'client_id is required' });
    }
    const result = await resolveClientProductPrice({
      productId,
      clientId,
      quantity: Number.isNaN(quantity) ? 1 : quantity,
    });
    res.json(result);
  } catch (err) {
    console.error('getClientProductPrice error:', err);
    res.status(500).json({ error: 'Failed to resolve client product price' });
  }
}

/* ── Transporters ── */

async function listTransporters(_req, res) {
  try {
    const rows = await Transporter.findAll({
      where: { status: 'active' },
      order: [['name', 'ASC']],
    });
    res.json(rows.map(r => {
      const d = r.get({ plain: true });
      return { id: d.id, name: d.name, code: d.code, phone: d.contact_phone, email: d.contact_email, trackingUrl: d.tracking_url };
    }));
  } catch (err) {
    console.error('listTransporters error:', err);
    res.status(500).json({ error: 'Failed to fetch transporters' });
  }
}

/* ── Invoice endpoints ── */

/** Serialize invoice number allocation (Postgres). Must run inside `transaction`. */
async function allocateNextFulfillmentInvoiceNo(sequelize, transaction) {
  const dialect = sequelize.getDialect && sequelize.getDialect();
  if (dialect === 'postgres') {
    await sequelize.query('SELECT pg_advisory_xact_lock(98273491, 1)', { transaction });
  }

  const latest = await FulfillmentInvoice.findOne({
    order: [['id', 'DESC']],
    attributes: ['invoice_no'],
    transaction,
  });

  let nextNum = 1;
  if (latest && latest.invoice_no) {
    const match = String(latest.invoice_no).match(/(\d+)$/);
    if (match) nextNum = parseInt(match[1], 10) + 1;
  }

  const year = new Date().getFullYear();
  return `INV-${year}-${String(nextNum).padStart(4, '0')}`;
}

/**
 * POST /fulfillment/invoices — Zoho sync reads Books ids from local DB:
 * Body: `vendorClientId` / `vendor_client_id` (vendor_clients.id → zoho_id) or `userId` / `user_id` (users → zoho_contact_id).
 * lineItems: `{ productId }` / `{ rawMaterialId }` / `{ packMaterialId }` (+ optional rate, qty, name) → products.zoho_item_id / raw_materials.zoho_id / pack_materials.zoho_id.
 *
 * `invoiceNo` is optional: when omitted or blank, the next number is allocated inside this request's DB transaction
 * (with an advisory lock on Postgres) so concurrent creates cannot reuse the same number.
 */
async function createInvoice(req, res) {
  const tx = await FulfillmentOrder.sequelize.transaction();
  try {
    const {
      fulfillmentOrderId, invoiceNo: invoiceNoRaw, invoiceDate, dueDate,
      preparedBy, transporterId, transporterName, lrAwbNo,
      remarks, subtotal, gstPercent, totalValue, lineItems, bprNos,
      vendorClientId, vendor_client_id, userId, user_id,
    } = req.body;

    if (!fulfillmentOrderId) {
      await tx.rollback();
      return res.status(400).json({ error: 'fulfillmentOrderId is required' });
    }

    const trimmed = invoiceNoRaw != null && String(invoiceNoRaw).trim() !== '' ? String(invoiceNoRaw).trim() : '';
    const invoiceNo = trimmed || (await allocateNextFulfillmentInvoiceNo(FulfillmentOrder.sequelize, tx));

    const order = await FulfillmentOrder.findByPk(fulfillmentOrderId, { transaction: tx });
    if (!order) {
      await tx.rollback();
      return res.status(404).json({ error: 'Fulfillment order not found' });
    }

    const splitWhere = { fulfillment_order_id: fulfillmentOrderId, ff_status: 'picking' };
    if (Array.isArray(bprNos) && bprNos.length > 0) {
      splitWhere.bpr_no = { [Op.in]: bprNos };
    }

    const invoice = await FulfillmentInvoice.create({
      invoice_no: invoiceNo,
      fulfillment_order_id: fulfillmentOrderId,
      invoice_date: invoiceDate || new Date().toISOString().slice(0, 10),
      due_date: dueDate || null,
      prepared_by: preparedBy || null,
      transporter_id: transporterId || null,
      transporter_name: transporterName || null,
      lr_awb_no: lrAwbNo || null,
      remarks: remarks || null,
      subtotal: subtotal || 0,
      gst_percent: gstPercent ?? 18,
      total_value: totalValue || 0,
      status: 'confirmed',
      line_items: lineItems || null,
    }, { transaction: tx });

    await FulfillmentBatchSplit.update(
      { ff_status: 'invoiced', invoice_no: invoiceNo },
      { where: splitWhere, transaction: tx }
    );

    order.set({ invoice_no: invoiceNo, invoice_date: invoiceDate || new Date().toISOString().slice(0, 10), courier: transporterName || null });
    const allSplits = await FulfillmentBatchSplit.findAll({ where: { fulfillment_order_id: fulfillmentOrderId }, transaction: tx });
    order.set('so_status', recalculateSOStatus(allSplits));
    await order.save({ transaction: tx });

    const zoho = await syncZohoInvoiceAfterFulfillment({
      fulfillmentOrder: order,
      lineItemsFromBody: lineItems,
      invoiceNo,
      invoiceDate: invoiceDate || new Date().toISOString().slice(0, 10),
      dueDate: dueDate || null,
      vendorClientId: vendorClientId ?? vendor_client_id,
      userId: userId ?? user_id,
    });
    if (zohoEnv.booksEnabled && zohoEnv.syncInvoices && !zoho.synced) {
      const err = new Error(zoho.error || 'zoho_invoice_sync_failed');
      err.statusCode = 502;
      err.clientMessage = zohoInvoiceSyncRollbackMessage(zoho.error);
      throw err;
    }
    if (zoho.synced && zoho.invoiceId) {
      await invoice.update({ zoho_invoice_id: zoho.invoiceId }, { transaction: tx });
      await order.update({ zoho_invoice_id: zoho.invoiceId }, { transaction: tx });
    }
    await tx.commit();
    await invoice.reload();

    const d = invoice.get({ plain: true });
    res.status(201).json({
      id: d.id,
      invoiceNo: d.invoice_no,
      fulfillmentOrderId: d.fulfillment_order_id,
      invoiceDate: d.invoice_date,
      dueDate: d.due_date,
      preparedBy: d.prepared_by,
      transporterId: d.transporter_id,
      transporterName: d.transporter_name,
      lrAwbNo: d.lr_awb_no,
      remarks: d.remarks,
      subtotal: d.subtotal != null ? Number(d.subtotal) : 0,
      gstPercent: d.gst_percent != null ? Number(d.gst_percent) : 18,
      totalValue: d.total_value != null ? Number(d.total_value) : 0,
      status: d.status,
      lineItems: d.line_items,
      zoho_invoice_id: zoho.invoiceId || d.zoho_invoice_id || null,
      zoho_sync: zoho.synced ? { synced: true } : zoho.error && zoho.error !== 'zoho_invoices_disabled' ? { synced: false, error: zoho.error } : undefined,
    });
  } catch (err) {
    if (!tx.finished) await tx.rollback();
    console.error('createInvoice error:', err);
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'An invoice with this number already exists' });
    }
    if (err && err.statusCode) {
      return res.status(err.statusCode).json({ error: err.clientMessage || err.message || 'Zoho invoice sync failed' });
    }
    res.status(500).json({ error: 'Failed to create invoice' });
  }
}

/**
 * POST /:id/fast-forward-invoice — catch-up for an SO the facility has already completed on the
 * floor but no one worked through Pick → Invoice for in the tool. The caller says how much of each
 * order line is actually done (`items: [{ itemId, qty }]`, fulfillment_order_items.id → qty) —
 * that's the quantity force-marked FG Ready → Picked → Invoiced, capped at what's still left to
 * invoice for that line (ordered qty minus whatever's already invoiced/shipped/delivered/closed).
 * Skips the pick step entirely and generates the invoice immediately with placeholder details (no
 * real transporter/AWB — those still come from a real Ship step later, same as any other invoiced
 * order). An existing open (not-yet-invoiced) batch split absorbs the qty; a line with none gets one
 * ad-hoc split created for it, so a line Production never touched can still be fast-forwarded.
 *
 * Does not create or edit any Planning row, GRN, or QC record, and never deletes a production batch
 * — only writes fulfillment tables (+ the invoice, + Zoho if that's on). The one exception: when a
 * line reuses an existing production-linked split, its production batch's bmr_status/bpr_status are
 * marked the same "done" values (cleared / fg_ready) a genuinely-finished batch reaches — so Planning
 * shows it as completed instead of stuck on Draft — but only when that batch is still untouched (no
 * real BMR/BPR progress or dispensing); one already mid real production is left exactly as it was.
 */
async function fastForwardInvoice(req, res) {
  const tx = await FulfillmentOrder.sequelize.transaction();
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      await tx.rollback();
      return res.status(400).json({ error: 'Invalid id' });
    }

    const requestedLines = Array.isArray(req.body?.items) ? req.body.items : [];
    if (requestedLines.length === 0) {
      await tx.rollback();
      return res.status(400).json({ error: 'items (itemId + qty for at least one order line) is required' });
    }

    const order = await FulfillmentOrder.findOne({
      where: activeRowWhere({ id }),
      include: INCLUDE_FULL,
      transaction: tx,
    });
    if (!order) {
      await tx.rollback();
      return res.status(404).json({ error: 'Fulfillment order not found' });
    }
    if (order.so_status === 'cancelled') {
      await tx.rollback();
      return res.status(400).json({ error: 'This sales order is cancelled — nothing to fast-forward.' });
    }

    const TERMINAL_FF_STATUSES = ['invoiced', 'shipped', 'delivered', 'closed'];
    const itemsById = new Map((order.items || []).map((i) => [i.id, i]));
    const targets = []; // { item, split, qty }

    for (const raw of requestedLines) {
      const itemId = parseInt(raw?.itemId, 10);
      const qtyRequested = Math.floor(Number(raw?.qty));
      if (Number.isNaN(itemId) || !Number.isFinite(qtyRequested) || qtyRequested <= 0) continue;
      const item = itemsById.get(itemId);
      if (!item) continue; // unknown / foreign-order item id — skip rather than fail the whole request

      const splits = item.batchSplits || [];
      // Already accounted for: whatever's on a split that's already invoiced (or later). Caps the
      // entered qty so this can never invoice more than the line's ordered qty in total.
      const alreadyDone = splits
        .filter((s) => TERMINAL_FF_STATUSES.includes(s.ff_status))
        .reduce((sum, s) => sum + (Number(s.picked_qty ?? s.fg_qty) || 0), 0);
      const remaining = Math.max(0, (Number(item.ordered_qty) || 0) - alreadyDone);
      const qty = Math.min(qtyRequested, remaining);
      if (qty <= 0) continue;

      const openSplits = splits.filter((s) => !TERMINAL_FF_STATUSES.includes(s.ff_status));
      const split = openSplits.length > 0
        ? openSplits[0]
        : await FulfillmentBatchSplit.create({
          fulfillment_order_item_id: item.id,
          fulfillment_order_id: id,
          production_batch_id: null,
          planned_qty: qty,
          fg_qty: 0,
          ff_status: 'fg_pending',
        }, { transaction: tx });
      targets.push({ item, split, qty });
    }

    if (targets.length === 0) {
      await tx.rollback();
      return res.status(400).json({ error: 'Nothing to fast-forward — enter a quantity greater than 0 for at least one line (up to what still remains to be invoiced).' });
    }

    const invoiceNo = await allocateNextFulfillmentInvoiceNo(FulfillmentOrder.sequelize, tx);
    const todayIso = new Date().toISOString().slice(0, 10);

    let subtotal = 0;
    let taxTotal = 0;
    const lineItems = [];
    for (const { item, split, qty } of targets) {
      const rate = Number(item.unit_price ?? item.rate) || 0;
      const amount = qty * rate;
      const taxPct = Number(item.tax_pct) || 0;
      const taxAmount = Math.round(amount * taxPct) / 100;
      subtotal += amount;
      taxTotal += taxAmount;
      lineItems.push({
        productName: item.product_name,
        pack: item.pack,
        bprNo: split.bpr_no,
        sku: item.sku,
        quantity: qty,
        pickedQty: qty,
        rate,
        amount,
        taxPct,
        taxAmount,
        lineTotal: amount + taxAmount,
      });
      split.set({
        ff_status: 'invoiced',
        invoice_no: invoiceNo,
        picked_qty: qty,
        fg_qty: Math.max(Number(split.fg_qty) || 0, qty),
        // A reused split can carry a stale planned_qty from Production (e.g. a small test batch
        // size) that has nothing to do with the qty just fast-forwarded — never show "Planned"
        // lower than what's now actually on the invoice. Only ever grows it, never shrinks a
        // genuinely larger real batch plan.
        planned_qty: Math.max(Number(split.planned_qty) || 0, qty),
      });
      await split.save({ transaction: tx });
    }
    const totalValue = subtotal + taxTotal;
    const gstPercent = subtotal > 0 ? Math.round((taxTotal / subtotal) * 10000) / 100 : 0;

    const preparedBy = req.user ? (req.user.fullName || req.user.email || 'Fast Forward') : 'Fast Forward';
    const remarksNote = 'Fast-forwarded: facility confirmed this was already completed outside the tool. '
      + 'Qty and invoice were auto-generated — Production/Planning/GRN/QC records were not touched.';

    const invoice = await FulfillmentInvoice.create({
      invoice_no: invoiceNo,
      fulfillment_order_id: id,
      invoice_date: todayIso,
      due_date: null,
      prepared_by: preparedBy,
      transporter_id: null,
      transporter_name: 'Direct Dispatch',
      lr_awb_no: null,
      remarks: remarksNote,
      subtotal,
      gst_percent: gstPercent,
      total_value: totalValue,
      status: 'confirmed',
      line_items: lineItems,
    }, { transaction: tx });

    order.set({
      invoice_no: invoiceNo,
      invoice_date: todayIso,
      courier: order.courier || 'Direct Dispatch',
    });
    const allSplits = await FulfillmentBatchSplit.findAll({ where: { fulfillment_order_id: id }, transaction: tx });
    order.set('so_status', recalculateSOStatus(allSplits));
    await order.save({ transaction: tx });

    await Order.update({ fulfillment_stage: 'invoiced' }, { where: { so_no: order.so_no }, transaction: tx });

    const zoho = await syncZohoInvoiceAfterFulfillment({
      fulfillmentOrder: order,
      lineItemsFromBody: lineItems,
      invoiceNo,
      invoiceDate: todayIso,
      dueDate: null,
    });
    if (zohoEnv.booksEnabled && zohoEnv.syncInvoices && !zoho.synced) {
      const err = new Error(zoho.error || 'zoho_invoice_sync_failed');
      err.statusCode = 502;
      err.clientMessage = zohoInvoiceSyncRollbackMessage(zoho.error);
      throw err;
    }
    if (zoho.synced && zoho.invoiceId) {
      await invoice.update({ zoho_invoice_id: zoho.invoiceId }, { transaction: tx });
      await order.update({ zoho_invoice_id: zoho.invoiceId }, { transaction: tx });
    }

    await tx.commit();

    // A target that reused an existing production-linked split means that batch's production work
    // is now done, from Fulfillment's side — mark it FG Ready the same way a genuinely-finished batch
    // reaches that status, so Planning/Production screens that already read bmr_status/bpr_status
    // show it as completed instead of stuck on "Draft" — never delete the batch itself (it's a real
    // record). Only when the batch hasn't had any real work done on it yet (mirrors the same
    // draft/batch_confirmed/pm_reserved safety line Planning's own batch-delete uses) — a batch
    // already mid real production is left exactly as it is, since forcing it to fg_ready there could
    // paper over genuine work in progress. Runs after commit, best-effort: never fails the request.
    const BMR_SAFE_TO_COMPLETE_STATUSES = ['draft', 'batch_confirmed'];
    const BPR_SAFE_TO_COMPLETE_STATUSES = ['draft', 'pm_reserved'];
    const hasDispensingData = (data) => data && typeof data === 'object' && Object.keys(data).length > 0;
    const reusedProductionBatchIds = [...new Set(
      targets.map((t) => t.split.production_batch_id).filter(Boolean)
    )];
    for (const productionBatchId of reusedProductionBatchIds) {
      try {
        const prodBatch = await ProductionBatch.findByPk(productionBatchId);
        if (!prodBatch) continue;
        const isSafe =
          BMR_SAFE_TO_COMPLETE_STATUSES.includes(prodBatch.bmr_status) &&
          BPR_SAFE_TO_COMPLETE_STATUSES.includes(prodBatch.bpr_status) &&
          !hasDispensingData(prodBatch.dispensing_rm) &&
          !hasDispensingData(prodBatch.dispensing_pm);
        if (!isSafe) {
          console.warn(`[fastForwardInvoice] left production batch ${productionBatchId} status as-is — real production work already in progress`);
          continue;
        }
        const producedQty = targets
          .filter((t) => t.split.production_batch_id === productionBatchId)
          .reduce((sum, t) => sum + t.qty, 0);
        await prodBatch.update({ bmr_status: 'cleared', bpr_status: 'fg_ready', fg_yield: producedQty });
      } catch (statusErr) {
        console.warn('[fastForwardInvoice] could not mark linked production batch complete:', statusErr && statusErr.message ? statusErr.message : statusErr);
      }
    }

    const refreshed = await FulfillmentOrder.findByPk(id, { include: INCLUDE_FULL });
    res.json(formatOrder(refreshed));
  } catch (err) {
    if (!tx.finished) await tx.rollback();
    console.error('fastForwardInvoice error:', err);
    if (err && err.statusCode) {
      return res.status(err.statusCode).json({ error: err.clientMessage || err.message || 'Zoho invoice sync failed' });
    }
    res.status(500).json({ error: 'Failed to fast-forward invoice' });
  }
}

async function listInvoices(req, res) {
  try {
    const where = {};
    if (req.query.fulfillment_order_id) where.fulfillment_order_id = req.query.fulfillment_order_id;

    const rows = await FulfillmentInvoice.findAll({
      where,
      include: [{ model: Transporter, as: 'transporter', attributes: ['id', 'name', 'code'] }],
      order: [['id', 'DESC']],
    });

    res.json(rows.map(r => {
      const d = r.get({ plain: true });
      return {
        id: d.id,
        invoiceNo: d.invoice_no,
        fulfillmentOrderId: d.fulfillment_order_id,
        invoiceDate: d.invoice_date,
        dueDate: d.due_date,
        preparedBy: d.prepared_by,
        transporterName: d.transporter_name || d.transporter?.name || '',
        lrAwbNo: d.lr_awb_no,
        subtotal: d.subtotal != null ? Number(d.subtotal) : 0,
        gstPercent: d.gst_percent != null ? Number(d.gst_percent) : 18,
        totalValue: d.total_value != null ? Number(d.total_value) : 0,
        status: d.status,
        lineItems: d.line_items,
        zohoInvoiceId: d.zoho_invoice_id || null,
      };
    }));
  } catch (err) {
    console.error('listInvoices error:', err);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
}

/** Parse planning_extracted order_qty_display / total_kg_display for unit-based PM math. */
function parsePlanningOrderQtyContext(planPlain) {
  const orderQty = parseInt(String(planPlain.order_qty_display || '0').replace(/\D/g, ''), 10) || 0;
  const totalKg = parseFloat(String(planPlain.total_kg_display || '0').replace(/[^\d.]/g, '')) || 0;
  const kgPerUnit = orderQty > 0 && totalKg > 0 ? totalKg / orderQty : 0;
  return { orderQty, totalKg, kgPerUnit };
}

/** Finished units for one planning batch (qty_per_unit is per FG unit, not per kg). */
function batchOutputUnits(sizeKg, qtyCtx) {
  const size = Number(sizeKg) || 0;
  if (size <= 0) return 0;
  if (qtyCtx.kgPerUnit > 0) return size / qtyCtx.kgPerUnit;
  const rounded = Math.round(size);
  return rounded > 0 ? rounded : 1;
}

/**
 * GET /api/v1/fulfillment/so-planning-availability?so_no=EI-SO-YYYY-XXX
 *
 * Returns per-product planning batch availability (RM/PM) based on current
 * warehouse inventory (available = stock_in_hand - reserved), plus for each planning
 * batch: needed vs already requested (reserved_batch_items) totals.
 */
async function getSoPlanningAvailability(req, res) {
  try {
    const soNo = String(req.query.so_no || '').trim();
    if (!soNo) return res.status(400).json({ error: 'so_no is required' });
    console.log('[FULFILLMENT-AVAIL] START', { soNo });

    const PlanningExtracted = require('../planningExtracted/models');
    const PlanningBatch = require('../planningExtracted/planningBatchModel');
    const { ProductionBatch: ProductionBatchModel } = require('../production/models');
    const { Product: ProductModel } = require('../products/models');

    const salesOrder = await SalesOrder.findOne({
      where: { order_id: soNo },
      attributes: ['id', 'order_id'],
    });
    if (!salesOrder) {
      console.log('[FULFILLMENT-AVAIL] NO_SALES_ORDER_MATCH', { soNo });
      return res.json({ success: true, soNo, items: [] });
    }
    console.log('[FULFILLMENT-AVAIL] SALES_ORDER_MATCH', { soNo, salesOrderId: salesOrder.id, orderId: salesOrder.order_id });

    // Units already fulfilled outside the normal batch pipeline (e.g. Fast Forward) for each product
    // on this SO — subtracted from "Pending to plan" below so an already-fulfilled portion doesn't
    // keep demanding a fresh batch be planned for it. Matched by product_code, the same authoritative
    // key batchSplitSync.js uses between Production and Fulfillment.
    const TERMINAL_FF_STATUSES_FOR_AVAIL = ['invoiced', 'shipped', 'delivered', 'closed'];
    // Reuses INCLUDE_FULL (items via `separate: true`) rather than a hand-rolled nested include —
    // a plain 3-level hasMany-of-hasMany join here risks inflating the fulfilledUnits sum below.
    const fulfillmentOrderForAvail = await FulfillmentOrder.findOne({
      where: { so_no: soNo },
      include: INCLUDE_FULL,
    });
    const fulfilledUnitsByProductCode = new Map();
    for (const item of (fulfillmentOrderForAvail && fulfillmentOrderForAvail.items) || []) {
      const code = (item.product_code || '').trim().toLowerCase();
      if (!code) continue;
      const done = (item.batchSplits || [])
        .filter((s) => TERMINAL_FF_STATUSES_FOR_AVAIL.includes(s.ff_status))
        .reduce((sum, s) => sum + (Number(s.picked_qty ?? s.fg_qty) || 0), 0);
      fulfilledUnitsByProductCode.set(code, (fulfilledUnitsByProductCode.get(code) || 0) + done);
    }

    const planningRows = await PlanningExtracted.findAll({
      where: { sales_order_id: salesOrder.id },
      attributes: ['id', 'batch_count', 'order_qty_display', 'total_kg_display', 'sent_batch_indices'],
      include: [
        { model: ProductModel, as: 'product', attributes: ['product_id', 'product_name', 'product_code', 'zoho_sku_code'] },
      ],
    });
    console.log('[FULFILLMENT-AVAIL] PLANNING_ROWS', {
      soNo,
      planningRowCount: planningRows.length,
      planningRowIds: planningRows.map((r) => (r.get ? r.get('id') : r.id)),
    });

    const items = [];

    for (const plan of planningRows) {
      const planPlain = plan.get ? plan.get({ plain: true }) : plan;
      const planId = planPlain.id;
      const totalBatches = Number(planPlain.batch_count ?? 0) || 0;
      const sentIndices = Array.isArray(planPlain.sent_batch_indices) ? planPlain.sent_batch_indices : [];
      const qtyCtx = parsePlanningOrderQtyContext(planPlain);

      const planningBatches = await PlanningBatch.findAll({
        where: { planning_extracted_id: planId },
        order: [['sequence', 'ASC']],
        attributes: ['id', 'sequence', 'size_kg', 'rm_lines', 'pm_lines', 'batch_code'],
      });
      console.log('[FULFILLMENT-AVAIL] PLAN_BATCHES', {
        soNo,
        planningExtractedId: planId,
        totalBatchesConfigured: totalBatches,
        planningBatchCount: planningBatches.length,
        sentIndices,
      });

      const effectiveTotalBatches = totalBatches > 0 ? totalBatches : planningBatches.length;
      const sentCount = planningBatches.filter((b) => sentIndices.includes((b.sequence ?? 1) - 1)).length;

      // Collect required RM/PM identifiers across planning batches for this PI.
      // Prefer explicit IDs when present (raw_material_id / pack_material_id), else fall back to codes.
      const requiredRmIds = new Set();
      const requiredPmIds = new Set();
      const requiredRmCodes = new Set();
      const requiredPmCodes = new Set();
      const requiredPmNameKeys = new Set();
      for (const b of planningBatches) {
        const plain = b.get ? b.get({ plain: true }) : b;
        const rmLines = Array.isArray(plain.rm_lines) ? plain.rm_lines : [];
        const pmLines = Array.isArray(plain.pm_lines) ? plain.pm_lines : [];
        for (const line of rmLines) {
          const id = line.raw_material_id ?? line.rawMaterialId;
          if (id != null) {
            const n = Number(id);
            if (!Number.isNaN(n)) requiredRmIds.add(n);
          } else {
            const code = line.rm_code || line.rmCode || line.code;
            if (code) requiredRmCodes.add(code);
          }
        }
        for (const line of pmLines) {
          const id = line.pack_material_id ?? line.packMaterialId;
          if (id != null) {
            const n = Number(id);
            if (!Number.isNaN(n)) requiredPmIds.add(n);
          } else {
            const code = line.pm_code || line.pmCode || line.code;
            if (code) {
              requiredPmCodes.add(code);
            } else {
              const desc = line.description || line.name;
              if (desc) requiredPmNameKeys.add(String(desc).trim().toLowerCase());
            }
          }
        }
      }

      const rmListById = requiredRmIds.size
        ? await RawMaterial.findAll({ where: { id: { [Op.in]: [...requiredRmIds] } }, attributes: ['id', 'code'] })
        : [];
      const rmListByCode = requiredRmCodes.size
        ? await RawMaterial.findAll({ where: { code: { [Op.in]: [...requiredRmCodes] } }, attributes: ['id', 'code'] })
        : [];
      const rmList = [...rmListById, ...rmListByCode].filter((v, i, arr) => arr.findIndex((x) => x.id === v.id) === i);

      const pmListById = requiredPmIds.size
        ? await PackMaterial.findAll({ where: { id: { [Op.in]: [...requiredPmIds] } }, attributes: ['id', 'code'] })
        : [];
      const pmListByCode = requiredPmCodes.size
        ? await PackMaterial.findAll({ where: { code: { [Op.in]: [...requiredPmCodes] } }, attributes: ['id', 'code', 'description'] })
        : [];
      const pmListByDesc = requiredPmNameKeys.size
        ? await PackMaterial.findAll({
          where: PackMaterial.sequelize.where(
            PackMaterial.sequelize.fn('lower', PackMaterial.sequelize.col('description')),
            { [Op.in]: [...requiredPmNameKeys] }
          ),
          attributes: ['id', 'code', 'description'],
        })
        : [];
      const pmList = [...pmListById, ...pmListByCode, ...pmListByDesc].filter((v, i, arr) => arr.findIndex((x) => x.id === v.id) === i);
      console.log('[FULFILLMENT-AVAIL] REQUIRED_ITEMS', {
        soNo,
        planningExtractedId: planId,
        requiredRmIds: [...requiredRmIds],
        requiredRmCodes: [...requiredRmCodes],
        resolvedRmIds: rmList.map((r) => (r.get ? r.get('id') : r.id)),
        requiredPmIds: [...requiredPmIds],
        requiredPmCodes: [...requiredPmCodes],
        resolvedPmIds: pmList.map((p) => (p.get ? p.get('id') : p.id)),
      });

      const rmCodeToId = new Map(rmList.map((r) => {
        const d = r.get ? r.get({ plain: true }) : r;
        return [d.code, d.id];
      }));
      const pmCodeToId = new Map(pmList.map((p) => {
        const d = p.get ? p.get({ plain: true }) : p;
        return [d.code, d.id];
      }));
      const pmByName = new Map();
      pmList.forEach((p) => {
        const d = p.get ? p.get({ plain: true }) : p;
        const key = String(d.description || '').trim().toLowerCase();
        if (key) pmByName.set(key, d.id);
      });

      // Fetch current warehouse availability for these RM/PM codes.
      const rmIds = rmList.map((r) => (r.get ? r.get({ plain: true }).id : r.id));
      const pmIds = pmList.map((p) => (p.get ? p.get({ plain: true }).id : p.id));

      const rmInvRows = rmIds.length
        ? await WarehouseInventory.findAll({ where: { item_type: 'RM', raw_material_id: { [Op.in]: rmIds } }, attributes: ['raw_material_id', 'stock_in_hand', 'reserved'] })
        : [];
      const pmInvRows = pmIds.length
        ? await WarehouseInventory.findAll({ where: { item_type: 'PM', pack_material_id: { [Op.in]: pmIds } }, attributes: ['pack_material_id', 'stock_in_hand', 'reserved'] })
        : [];

      const rmAvailableById = {};
      rmInvRows.forEach((r) => {
        const d = r.get ? r.get({ plain: true }) : r;
        const avail = Number(d.stock_in_hand ?? 0) - Number(d.reserved ?? 0);
        rmAvailableById[d.raw_material_id] = Math.max(0, avail);
      });
      const pmAvailableById = {};
      pmInvRows.forEach((r) => {
        const d = r.get ? r.get({ plain: true }) : r;
        const avail = Number(d.stock_in_hand ?? 0) - Number(d.reserved ?? 0);
        pmAvailableById[d.pack_material_id] = Math.max(0, avail);
      });
      console.log('[FULFILLMENT-AVAIL] INVENTORY_AVAILABLE', {
        soNo,
        planningExtractedId: planId,
        rmAvailableById,
        pmAvailableById,
      });

      // Production batches linked to planning rows (for reserve + BMR/BPR fulfilled overrides).
      const planningBatchIds = planningBatches.map((b) => (b.get ? b.get({ plain: true }).id : b.id));
      const prodBatches = planningBatchIds.length
        ? await ProductionBatchModel.findAll({
          where: { planning_batch_id: { [Op.in]: planningBatchIds } },
          attributes: ['id', 'planning_batch_id', 'bmr_status', 'bpr_status'],
        })
        : [];
      const prodByPlanningId = {};
      const prodMetaByPlanningId = {};
      const BMR_RM_FULFILLED = new Set([
        'dispensing', 'in_production', 'bulk_qc', 'cleared',
      ]);
      const BPR_PM_FULFILLED = new Set([
        'pm_reserved', 'scheduled', 'pm_connected',
        'pm_dispensing', 'filling', 'fill_qc', 'packaging', 'pack_qc', 'fg_ready',
      ]);
      prodBatches.forEach((pb) => {
        const d = pb.get ? pb.get({ plain: true }) : pb;
        prodByPlanningId[d.planning_batch_id] = d.id;
        prodMetaByPlanningId[d.planning_batch_id] = d;
      });

      // For each planning batch: compute RM/PM required totals + for simulation per-code availability.
      const batchRequired = new Map(); // planningBatchId -> { rmReqById, rmNeededTotal, pmReqById, pmNeededTotal }
      const batchNeededTotals = new Map(); // planningBatchId -> { rmNeededTotal, pmNeededTotal }
      let rmLineTotalCount = 0;
      let rmLineAvailableCount = 0;
      let pmLineTotalCount = 0;
      let pmLineAvailableCount = 0;

      for (const b of planningBatches) {
        const plain = b.get ? b.get({ plain: true }) : b;
        const planningBatchId = plain.id;
        const sizeKg = plain.size_kg != null ? Number(plain.size_kg) : 0;
        const prodMeta = prodMetaByPlanningId[planningBatchId];
        const bmrStatus = String(prodMeta?.bmr_status || '').toLowerCase();
        const bprStatus = String(prodMeta?.bpr_status || '').toLowerCase();
        const rmBmrFulfilled = BMR_RM_FULFILLED.has(bmrStatus);
        const pmBprFulfilled = BPR_PM_FULFILLED.has(bprStatus);

        const rmLines = Array.isArray(plain.rm_lines) ? plain.rm_lines : [];
        const pmLines = Array.isArray(plain.pm_lines) ? plain.pm_lines : [];

        const rmReqById = {};
        let rmNeededTotal = 0;
        for (const line of rmLines) {
          let rid = line.raw_material_id ?? line.rawMaterialId;
          if (rid == null) {
            const code = line.rm_code || line.rmCode || line.code;
            if (!code) continue;
            rid = rmCodeToId.get(code);
          }
          const ridNum = rid != null ? Number(rid) : null;
          if (ridNum == null || Number.isNaN(ridNum)) continue;
          let qtyKg = 0;
          const pct = Number(line.pct_w_w ?? line.pct ?? 0);
          if (Number.isFinite(pct) && pct > 0 && sizeKg > 0) {
            qtyKg = (sizeKg * pct) / 100;
          } else if (line.quantity != null) {
            // When saved from SO-level override, planning_bom_override may store precomputed quantities.
            qtyKg = Number(line.quantity ?? 0) || 0;
          }
          if (qtyKg <= 0) continue;
          rmReqById[ridNum] = (rmReqById[ridNum] ?? 0) + qtyKg;
          rmNeededTotal += qtyKg;
          rmLineTotalCount += 1;
          if (rmBmrFulfilled || Number(rmAvailableById[ridNum] ?? 0) >= qtyKg) rmLineAvailableCount += 1;
        }

        const pmReqById = {};
        let pmNeededTotal = 0;
        const batchSizeUnits = batchOutputUnits(sizeKg, qtyCtx);
        for (const line of pmLines) {
          let pid = line.pack_material_id ?? line.packMaterialId;
          if (pid == null) {
            const code = line.pm_code || line.pmCode || line.code;
            if (code) pid = pmCodeToId.get(code);
            if (pid == null) {
              const nameKey = String(line.description || line.name || '').trim().toLowerCase();
              if (nameKey) pid = pmByName.get(nameKey);
            }
            if (pid == null) continue;
          }
          const pidNum = pid != null ? Number(pid) : null;
          if (pidNum == null || Number.isNaN(pidNum)) continue;
          let qtyUnits = 0;
          if (line.qty_per_unit != null) {
            const qtyPerUnit = Number(line.qty_per_unit);
            if (Number.isFinite(qtyPerUnit) && qtyPerUnit > 0 && batchSizeUnits > 0) {
              qtyUnits = qtyPerUnit * batchSizeUnits;
            }
          } else if (line.quantity != null) {
            qtyUnits = Number(line.quantity ?? 0) || 0;
          } else if (line.value != null) {
            // Some legacy payloads store "value" as qty_per_unit.
            const qtyPerUnit = Number(line.value ?? 0);
            if (Number.isFinite(qtyPerUnit) && qtyPerUnit > 0 && batchSizeUnits > 0) {
              qtyUnits = qtyPerUnit * batchSizeUnits;
            }
          }
          if (qtyUnits <= 0) continue;
          pmReqById[pidNum] = (pmReqById[pidNum] ?? 0) + qtyUnits;
          pmNeededTotal += qtyUnits;
          pmLineTotalCount += 1;
          if (pmBprFulfilled || Number(pmAvailableById[pidNum] ?? 0) >= qtyUnits) pmLineAvailableCount += 1;
        }

        batchRequired.set(planningBatchId, { rmReqById, rmNeededTotal, pmReqById, pmNeededTotal });
        batchNeededTotals.set(planningBatchId, { rmNeededTotal, pmNeededTotal });
      }

      const prodIds = prodBatches.map((pb) => (pb.get ? pb.get({ plain: true }).id : pb.id));
      const reservedRows = prodIds.length
        ? await ReservedBatchItem.findAll({
          where: { production_batch_id: { [Op.in]: prodIds } },
          attributes: ['production_batch_id', 'raw_material_id', 'pack_material_id', 'quantity_reserved'],
        })
        : [];

      const reservedRMByProductionId = {};
      const reservedPMByProductionId = {};
      reservedRows.forEach((r) => {
        const d = r.get ? r.get({ plain: true }) : r;
        const qty = Number(d.quantity_reserved ?? 0) || 0;
        const pid = d.production_batch_id;
        if (d.raw_material_id != null) reservedRMByProductionId[pid] = (reservedRMByProductionId[pid] ?? 0) + qty;
        if (d.pack_material_id != null) reservedPMByProductionId[pid] = (reservedPMByProductionId[pid] ?? 0) + qty;
      });

      // Simulate how many batches can be started with current warehouse availability.
      const rmAvailableSim = { ...rmAvailableById };
      let rmStartableCount = 0;
      const rmStartableByPlanningId = {};

      const pmAvailableSim = { ...pmAvailableById };
      let pmStartableCount = 0;
      const pmStartableByPlanningId = {};

      for (const b of planningBatches) {
        const plain = b.get ? b.get({ plain: true }) : b;
        const planningBatchId = plain.id;
        const { rmReqById, rmNeededTotal, pmReqById, pmNeededTotal } = batchRequired.get(planningBatchId) || {
          rmReqById: {}, rmNeededTotal: 0, pmReqById: {}, pmNeededTotal: 0,
        };

        // RM simulation
        const rmHasRequirements = Object.keys(rmReqById).length > 0 && rmNeededTotal > 0;
        const prodMetaSim = prodMetaByPlanningId[planningBatchId];
        const rmBmrFulfilledSim = BMR_RM_FULFILLED.has(String(prodMetaSim?.bmr_status || '').toLowerCase());
        const rmOk = rmBmrFulfilledSim || (rmHasRequirements && Object.entries(rmReqById).every(([ridStr, reqQty]) => {
          const rid = Number(ridStr);
          return Number(reqQty ?? 0) <= Number(rmAvailableSim[rid] ?? 0);
        }));
        if (rmOk) {
          rmStartableCount += 1;
          rmStartableByPlanningId[planningBatchId] = true;
          for (const [ridStr, reqQty] of Object.entries(rmReqById)) {
            const rid = Number(ridStr);
            rmAvailableSim[rid] = Number(rmAvailableSim[rid] ?? 0) - Number(reqQty ?? 0);
          }
        } else {
          rmStartableByPlanningId[planningBatchId] = false;
        }

        // PM simulation
        const pmHasRequirements = Object.keys(pmReqById).length > 0 && pmNeededTotal > 0;
        const pmBprFulfilledSim = BPR_PM_FULFILLED.has(String(prodMetaSim?.bpr_status || '').toLowerCase());
        const pmOk = pmBprFulfilledSim || (pmHasRequirements && Object.entries(pmReqById).every(([pidStr, reqQty]) => {
          const pid = Number(pidStr);
          return Number(reqQty ?? 0) <= Number(pmAvailableSim[pid] ?? 0);
        }));
        if (pmOk) {
          pmStartableCount += 1;
          pmStartableByPlanningId[planningBatchId] = true;
          for (const [pidStr, reqQty] of Object.entries(pmReqById)) {
            const pid = Number(pidStr);
            pmAvailableSim[pid] = Number(pmAvailableSim[pid] ?? 0) - Number(reqQty ?? 0);
          }
        } else {
          pmStartableByPlanningId[planningBatchId] = false;
        }
      }

      // Started counts = batches that already have reserved/requested RM/PM via production.
      let rmStartedCount = 0;
      let pmStartedCount = 0;
      const batchRows = planningBatches.map((b) => {
        const plain = b.get ? b.get({ plain: true }) : b;
        const planningBatchId = plain.id;
        const batchNo = Number(plain.sequence ?? 1);
        const sent = sentIndices.includes(batchNo - 1);

        const needed = batchNeededTotals.get(planningBatchId) || { rmNeededTotal: 0, pmNeededTotal: 0 };
        const prodId = prodByPlanningId[planningBatchId] ?? null;
        const prodMetaRow = prodMetaByPlanningId[planningBatchId];
        const rmRequested = prodId != null ? Number(reservedRMByProductionId[prodId] ?? 0) : 0;
        const pmRequested = prodId != null ? Number(reservedPMByProductionId[prodId] ?? 0) : 0;
        const bmrSt = String(prodMetaRow?.bmr_status || '').toLowerCase();
        const bprSt = String(prodMetaRow?.bpr_status || '').toLowerCase();

        if (rmRequested > 0 || BMR_RM_FULFILLED.has(bmrSt)) rmStartedCount += 1;
        if (pmRequested > 0 || BPR_PM_FULFILLED.has(bprSt)) pmStartedCount += 1;

        return {
          sequence: batchNo,
          sent,
          rmNeededTotalKg: needed.rmNeededTotal,
          rmRequestedTotalKg: rmRequested,
          rmRemainingTotalKg: Math.max(0, needed.rmNeededTotal - rmRequested),
          pmNeededTotalUnits: needed.pmNeededTotal,
          pmRequestedTotalUnits: pmRequested,
          pmRemainingTotalUnits: Math.max(0, needed.pmNeededTotal - pmRequested),
          rmStartable: !!rmStartableByPlanningId[planningBatchId],
          pmStartable: !!pmStartableByPlanningId[planningBatchId],
        };
      });

      const product = planPlain.product || {};
      const fulfilledUnits = fulfilledUnitsByProductCode.get((product.product_code || '').trim().toLowerCase()) || 0;
      console.log('[FULFILLMENT-AVAIL] PLAN_RESULT', {
        soNo,
        planningExtractedId: planId,
        productName: product.product_name || '',
        sku: product.zoho_sku_code || product.product_code || '',
        effectiveTotalBatches,
        sentCount,
        rmStartableCount,
        rmStartedCount,
        pmStartableCount,
        pmStartedCount,
        rmLineAvailableCount,
        rmLineTotalCount,
        pmLineAvailableCount,
        pmLineTotalCount,
        batchRows: batchRows.map((b) => ({
          sequence: b.sequence,
          sent: b.sent,
          rmStartable: b.rmStartable,
          pmStartable: b.pmStartable,
          rmNeededTotalKg: b.rmNeededTotalKg,
          rmRequestedTotalKg: b.rmRequestedTotalKg,
          pmNeededTotalUnits: b.pmNeededTotalUnits,
          pmRequestedTotalUnits: b.pmRequestedTotalUnits,
        })),
      });
      items.push({
        productName: product.product_name || '',
        sku: product.zoho_sku_code || product.product_code || '',
        totalBatches: effectiveTotalBatches,
        sentCount,
        rmStartableCount,
        rmStartedCount,
        pmStartableCount,
        pmStartedCount,
        rmLineAvailableCount,
        rmLineTotalCount,
        pmLineAvailableCount,
        pmLineTotalCount,
        // Units already invoiced/shipped/delivered in Fulfillment for this product on this SO (e.g.
        // via Fast Forward) — "Pending to plan" subtracts this so it doesn't keep demanding a batch
        // for a portion that's already done.
        fulfilledUnits,
        batches: batchRows,
      });
    }

    console.log('[FULFILLMENT-AVAIL] END', {
      soNo,
      itemCount: items.length,
      items: items.map((i) => ({
        productName: i.productName,
        sku: i.sku,
        totalBatches: i.totalBatches,
        rmStartableCount: i.rmStartableCount,
        pmStartableCount: i.pmStartableCount,
      })),
    });
    res.json({ success: true, soNo, items });
  } catch (err) {
    console.error('getSoPlanningAvailability error:', err);
    res.status(500).json({ error: 'Failed to fetch so planning availability' });
  }
}

module.exports = {
  listOrders,
  getOrderById,
  createOrder,
  updateOrder,
  deleteOrder,
  cancelOrder,
  manualFulfillOrder,
  pickSplits,
  invoiceSplits,
  shipSplits,
  deliverSplits,
  listBatchSplits,
  getNextSoNo,
  getCustomers,
  getProducts,
  getClientProductPrice,
  listTransporters,
  createInvoice,
  fastForwardInvoice,
  listInvoices,
  getSoPlanningAvailability,
};

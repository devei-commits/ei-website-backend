/**
 * Fulfillment Dashboard Controllers — View 1 (Sales Orders Dashboard) + View 2 (Products & Batches)
 * + Comments, SLA Templates, Transporter CRUD.
 *
 * All endpoints are read-only aggregations over fulfillment_orders / fulfillment_batch_splits,
 * enriched with production batch stage, client codes, product codes, SLA deltas, and comment counts.
 *
 * ISOLATION: Only imports from src/fulfillment/* and Sequelize models already used by controller.js.
 * Does NOT modify any other module's files.
 */

'use strict';

const { Op } = require('sequelize');
const db = require('../../db');
const {
  FulfillmentOrder, FulfillmentOrderItem, FulfillmentBatchSplit,
  Transporter, BatchStageLog, FulfillmentComment, FulfillmentSlaTemplate,
} = require('./models');
const { ProductionBatch } = require('../production/models');
const { Product } = require('../products/models');
const VendorClient = require('../vendorClient/models');
const SalesOrder = require('../salesOrders/models');
const PlanningExtracted = require('../planningExtracted/models');
const { buildActiveClientWhere } = require('../vendorClient/clientMasterQuery');
const { activeRowWhere } = require('../lib/softDelete');

async function tryInvalidateCache() {
  try {
    const { invalidateCacheForModule } = require('../cache/invalidateCacheForModule');
    if (typeof invalidateCacheForModule === 'function') await invalidateCacheForModule('fulfillment');
  } catch (_) { /* cache module not available — TTL expiry will handle staleness */ }
}

/* ─────────────────────────────────────────────────────────────────────────────
   CONSTANTS & HELPERS
───────────────────────────────────────────────────────────────────────────── */

/** In-memory global SLA defaults (days). Used when no sla_template row exists. */
const SLA_DEFAULTS = { picking: 2, invoiced: 1, shipped: 3, delivered: 1 };

/**
 * Map ff_status (+ optional bpr_status from production) → spec display stage label.
 * Returned value is one of: PLANNING / PROCUREMENT / PRODUCTION / FG_READY / PACKED / INVOICED / SHIPPED
 */
function deriveBatchDisplayStage(ffStatus, bprStatus) {
  const ff = String(ffStatus || '').toLowerCase();
  const bpr = String(bprStatus || '').toLowerCase();

  if (['shipped', 'delivered', 'closed'].includes(ff)) return 'SHIPPED';
  if (ff === 'invoiced') return 'INVOICED';
  if (ff === 'picking') return 'PACKED';
  if (ff === 'fg_ready') return 'FG_READY';
  if (ff === 'bulk_qc') return 'PRODUCTION';

  // Early stages — derive from production bpr_status
  if (['filling', 'fill_qc', 'packaging', 'pack_qc'].includes(bpr)) return 'PRODUCTION';
  if (['pm_dispensing'].includes(bpr)) return 'PRODUCTION';
  if (['pm_reserved', 'scheduled', 'pm_connected'].includes(bpr)) return 'PROCUREMENT';
  if (bpr === 'fg_ready') return 'FG_READY';

  return 'PLANNING';
}

/** Human-readable label for a display stage. */
const STAGE_LABEL = {
  PLANNING: 'Planning',
  PROCUREMENT: 'Procurement',
  PRODUCTION: 'Production',
  FG_READY: 'FG Ready',
  PACKED: 'Packed',
  INVOICED: 'Invoiced',
  SHIPPED: 'Shipped',
};

/**
 * Compute commercial_status from shipped qty vs ordered qty.
 * Only auto-advances if current status is in the post-approval track.
 * Returns null if no change is warranted.
 */
function computeCommercialStatusFromShippedQty(currentCommercialStatus, totalOrderedQty, totalShippedQty) {
  const autoTrack = ['approved', 'partial_closed', 'closed'];
  if (!autoTrack.includes(currentCommercialStatus)) return null;
  if (totalShippedQty >= totalOrderedQty && totalOrderedQty > 0) return 'closed';
  if (totalShippedQty > 0) return 'partial_closed';
  return null;
}

/**
 * SLA helpers — business day diff approximation (treat every day equally for now; can upgrade later).
 */
function calendarDaysDiff(from, to) {
  if (!from || !to) return null;
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.max(0, Math.round((new Date(to) - new Date(from)) / msPerDay));
}

/** Fetch committed_days from sla_templates for a given product_id + stage. Falls back to global default. */
async function getCommittedDays(productId, stage) {
  try {
    if (productId) {
      const specific = await FulfillmentSlaTemplate.findOne({
        where: { product_id: productId, stage },
        attributes: ['committed_days'],
      });
      if (specific) return Number(specific.committed_days);
    }
    const global = await FulfillmentSlaTemplate.findOne({
      where: { product_id: null, stage },
      attributes: ['committed_days'],
    });
    if (global) return Number(global.committed_days);
  } catch (_e) { /* silent */ }
  return SLA_DEFAULTS[stage] ?? null;
}

/** Batch open stage log entry (started_at = now, completed_at = null). */
async function openStageLog({ splitId, orderId, stage, actorName, actorUserId, productId, transaction }) {
  const committed = await getCommittedDays(productId, stage);
  return BatchStageLog.create({
    fulfillment_batch_split_id: splitId,
    fulfillment_order_id: orderId,
    stage,
    started_at: new Date(),
    completed_at: null,
    actor_name: actorName || null,
    actor_user_id: actorUserId || null,
    committed_days: committed,
  }, transaction ? { transaction } : {});
}

/** Close any open stage log entry for a split+stage. */
async function closeStageLog({ splitId, stage, transaction }) {
  const open = await BatchStageLog.findOne({
    where: { fulfillment_batch_split_id: splitId, stage, completed_at: null },
    transaction: transaction || undefined,
  });
  if (open) {
    open.set('completed_at', new Date());
    await open.save(transaction ? { transaction } : {});
  }
}

/**
 * Helper: given an array of batch splits (plain objects with ff_status, picked_qty, fg_qty),
 * compute the four aggregated qty metrics for a single SO.
 */
function aggregateSplitQtys(splits) {
  let fgReadyQty = 0, packedQty = 0, invoicedQty = 0, shippedQty = 0;
  for (const s of splits) {
    const status = String(s.ff_status || '');
    const fgQ = Number(s.fg_qty) || 0;
    const pkQ = Number(s.picked_qty) || 0;

    if (['fg_ready', 'picking', 'invoiced', 'shipped', 'delivered', 'closed'].includes(status)) {
      fgReadyQty += fgQ;
    }
    if (['picking', 'invoiced', 'shipped', 'delivered', 'closed'].includes(status)) {
      packedQty += pkQ;
    }
    if (['invoiced', 'shipped', 'delivered', 'closed'].includes(status)) {
      invoicedQty += pkQ;
    }
    if (['shipped', 'delivered', 'closed'].includes(status)) {
      shippedQty += pkQ;
    }
  }
  return { fgReadyQty, packedQty, invoicedQty, shippedQty };
}

/**
 * Per-stage fulfillment status for a single SO, expressed in BATCHES + BATCH UNITS
 * (not KG). FG uses the production batch's fg_yield/fill_yield (real finished units);
 * packed/invoiced/shipped use picked_qty (units confirmed by the picker).
 * Splits are deduped by bpr_no so sync-race duplicates don't double-count.
 */
function computeStageStatus(splits, batchMap) {
  const seen = new Set();
  const unique = [];
  for (const s of splits) {
    const key = s.bpr_no || `__id_${s.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(s);
  }

  const FG_PLUS  = ['fg_ready', 'picking', 'invoiced', 'shipped', 'delivered', 'closed'];
  const PK_PLUS  = ['picking', 'invoiced', 'shipped', 'delivered', 'closed'];
  const INV_PLUS = ['invoiced', 'shipped', 'delivered', 'closed'];
  const SHP_PLUS = ['shipped', 'delivered', 'closed'];

  const fgUnits = (s) => {
    const pb = s.production_batch_id ? batchMap[s.production_batch_id] : null;
    const y = pb && pb.fg_yield != null ? Number(pb.fg_yield)
      : pb && pb.fill_yield != null ? Number(pb.fill_yield) : null;
    if (y != null && y > 0) return y;
    return Number(s.picked_qty) || 0; // fallback: picker units
  };

  let fgB = 0, fgQ = 0, pkB = 0, pkQ = 0, invB = 0, invQ = 0, shpB = 0, shpQ = 0;
  for (const s of unique) {
    const st = String(s.ff_status || '');
    const pk = Number(s.picked_qty) || 0;
    if (FG_PLUS.includes(st))  { fgB++;  fgQ  += fgUnits(s); }
    if (PK_PLUS.includes(st))  { pkB++;  pkQ  += pk; }
    if (INV_PLUS.includes(st)) { invB++; invQ += pk; }
    if (SHP_PLUS.includes(st)) { shpB++; shpQ += pk; }
  }

  return [
    { key: 'fg_ready', label: 'FG Ready', batches: fgB,  qty: Math.round(fgQ) },
    { key: 'packed',   label: 'Packed',   batches: pkB,  qty: Math.round(pkQ) },
    { key: 'invoiced', label: 'Invoiced', batches: invB, qty: Math.round(invQ) },
    { key: 'shipped',  label: 'Shipped',  batches: shpB, qty: Math.round(shpQ) },
  ];
}

/** Compute SLA flag from due_date vs now. */
function computeSlaFlag(dueDate, soStatus) {
  const terminal = ['shipped', 'delivered', 'closed'];
  if (!dueDate || terminal.includes(soStatus)) return { overdue: false, approaching: false, daysOverdue: 0 };
  const msPerDay = 1000 * 60 * 60 * 24;
  const today = new Date();
  const due = new Date(dueDate);
  const diffDays = Math.round((due - today) / msPerDay);
  if (diffDays < 0) return { overdue: true, approaching: false, daysOverdue: Math.abs(diffDays) };
  if (diffDays <= 2) return { overdue: false, approaching: true, daysOverdue: 0 };
  return { overdue: false, approaching: false, daysOverdue: 0 };
}

/** Build batch pill array for a SO (max 3 shown + total count). */
function buildBatchPills(splits, batchMap) {
  const pills = [];
  for (const s of splits) {
    if (!s.bpr_no) continue;
    const pb = s.production_batch_id && batchMap[s.production_batch_id];
    const bprStatus = pb ? pb.bpr_status : null;
    const displayStage = deriveBatchDisplayStage(s.ff_status, bprStatus);
    const batchNo = pb ? (pb.batch_no || s.bpr_no) : s.bpr_no;
    pills.push({
      batchNo,
      bprNo: s.bpr_no,
      stage: displayStage,
      stageLabel: STAGE_LABEL[displayStage] || displayStage,
    });
  }
  // Deduplicate by bprNo (a split is the canonical record per bpr_no)
  const seen = new Set();
  const unique = pills.filter((p) => {
    if (seen.has(p.bprNo)) return false;
    seen.add(p.bprNo);
    return true;
  });
  return { pills: unique.slice(0, 3), total: unique.length };
}

/* ─────────────────────────────────────────────────────────────────────────────
   VIEW 1 — Sales Orders Dashboard
───────────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/v1/fulfillment/sales-orders-dashboard
 * Query: client_id, status[], date_from, date_to, search, page, page_size, flagged_only
 * Returns one row per SO with aggregated FG-ready/packed/invoiced/shipped qtys + batch pills.
 * Rows grouped by client on the frontend (we return a flat list sorted by customer + due_date).
 */
async function listSalesOrdersDashboard(req, res) {
  try {
    const {
      client_id, status, date_from, date_to, search,
      flagged_only, page = 1, page_size = 100,
    } = req.query;

    // --- Build fulfillment_orders WHERE clause ---
    const where = activeRowWhere();

    if (date_from || date_to) {
      where.order_date = {};
      if (date_from) where.order_date[Op.gte] = date_from;
      if (date_to) where.order_date[Op.lte] = date_to;
    }

    // Filter by the authoritative order status (sales_orders.status) — this is what the dashboard
    // Status column + Edit SO "Update SO Status" use. Resolve matching sales_order_ids first, then
    // restrict the fulfillment orders (keeps server-side pagination correct).
    const orderStatuses = status ? (Array.isArray(status) ? status : [status]) : null;
    if (orderStatuses && orderStatuses.length) {
      const wanted = orderStatuses.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
      const soRows = wanted.length
        ? await SalesOrder.findAll({
            where: db.where(db.fn('lower', db.col('status')), { [Op.in]: wanted }),
            attributes: ['id'],
          })
        : [];
      const soIds = soRows.map((r) => Number(r.get('id'))).filter((n) => Number.isFinite(n));
      where.sales_order_id = soIds.length ? { [Op.in]: soIds } : { [Op.in]: [-1] };
    }

    if (client_id) {
      where.vendor_client_id = parseInt(client_id, 10);
    }

    if (search) {
      const s = `%${search}%`;
      // Also match the SO's line items by PR name / PR code. The Product column shows the first
      // item's product_name and product_code (falling back to sku), so those are matched too.
      // Resolved to order ids first, which keeps server-side pagination counts correct.
      const itemMatches = await FulfillmentOrderItem.findAll({
        where: activeRowWhere({
          [Op.or]: [
            { product_name: { [Op.iLike]: s } },
            { product_code: { [Op.iLike]: s } },
            { sku: { [Op.iLike]: s } },
          ],
        }),
        attributes: ['fulfillment_order_id'],
        group: ['fulfillment_order_id'],
      });
      const itemOrderIds = [...new Set(
        itemMatches.map((r) => Number(r.get('fulfillment_order_id'))).filter((n) => Number.isFinite(n))
      )];
      where[Op.or] = [
        { so_no: { [Op.iLike]: s } },
        { customer_name: { [Op.iLike]: s } },
        ...(itemOrderIds.length ? [{ id: { [Op.in]: itemOrderIds } }] : []),
      ];
    }

    // Pagination
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(page_size, 10) || 100));
    const offset = (pageNum - 1) * limit;

    // --- Fetch orders ---
    const { count: totalCount, rows: orderRows } = await FulfillmentOrder.findAndCountAll({
      where,
      order: [['customer_name', 'ASC'], ['due_date', 'ASC'], ['id', 'ASC']],
      limit,
      offset,
      attributes: [
        'id', 'so_no', 'order_date', 'due_date', 'priority',
        'so_status', 'commercial_status', 'so_value', 'sales_order_id',
        'customer_name', 'customer_city', 'vendor_client_id',
        'invoice_no', 'dispatch_date',
      ],
    });

    if (!orderRows.length) {
      return res.json({ total: totalCount, page: pageNum, pageSize: limit, rows: [] });
    }

    const orderIds = orderRows.map((r) => r.id);

    // --- Authoritative order status lives on sales_orders.status (Draft/Approved/Confirmed/
    // Cancelled/Closed). Surface it as `orderStatus` so the Edit-SO "Update SO Status" control
    // shows the real value and it stays reconciled with Planning → PIS Extracted visibility. ---
    const salesOrderIds = [...new Set(orderRows.map((r) => r.sales_order_id).filter(Boolean))];
    const orderStatusById = new Map();
    if (salesOrderIds.length) {
      const soRows = await SalesOrder.findAll({
        where: { id: { [Op.in]: salesOrderIds } },
        attributes: ['id', 'status'],
      });
      soRows.forEach((r) => {
        const d = r.get({ plain: true });
        orderStatusById.set(d.id, d.status || null);
      });
    }

    // --- Committed date: planner-set target, lives on planning_extracted (one row per SO×product).
    // A SO with multiple products can have multiple committed dates set independently; mirror the
    // "first line is the representative line" convention used for productDisplay below and take the
    // earliest row's (lowest id) value, same as orderStatusById above keys strictly by SO. ---
    const committedDateBySalesOrderId = new Map();
    if (salesOrderIds.length) {
      const planRows = await PlanningExtracted.findAll({
        where: { sales_order_id: { [Op.in]: salesOrderIds }, committed_date: { [Op.ne]: null } },
        attributes: ['id', 'sales_order_id', 'committed_date'],
        order: [['id', 'ASC']],
      });
      planRows.forEach((r) => {
        const d = r.get({ plain: true });
        if (!committedDateBySalesOrderId.has(d.sales_order_id)) {
          committedDateBySalesOrderId.set(d.sales_order_id, d.committed_date);
        }
      });
    }

    // --- Fetch items + splits in bulk (2 queries) ---
    const [items, splits] = await Promise.all([
      FulfillmentOrderItem.findAll({
        where: { fulfillment_order_id: { [Op.in]: orderIds } },
        attributes: ['id', 'fulfillment_order_id', 'sku', 'product_code', 'product_name', 'pack', 'ordered_qty', 'unit_price'],
      }),
      FulfillmentBatchSplit.findAll({
        where: { fulfillment_order_id: { [Op.in]: orderIds } },
        attributes: ['id', 'fulfillment_order_id', 'fulfillment_order_item_id', 'production_batch_id', 'bpr_no', 'ff_status', 'fg_qty', 'picked_qty'],
      }),
    ]);

    // --- Fetch production batches for batch pills + reliable FG unit yield ---
    const prodBatchIds = [...new Set(splits.map((s) => s.production_batch_id).filter(Boolean))];
    const prodBatchRows = prodBatchIds.length
      ? await ProductionBatch.findAll({
          where: { id: { [Op.in]: prodBatchIds } },
          attributes: ['id', 'batch_no', 'bpr_no', 'bpr_status', 'bmr_status', 'fg_yield', 'fill_yield'],
        })
      : [];
    const batchMap = {};
    prodBatchRows.forEach((pb) => {
      const d = pb.get({ plain: true });
      batchMap[d.id] = d;
    });

    // --- Fetch vendor_client entity codes ---
    const clientIds = [...new Set(orderRows.map((r) => r.vendor_client_id).filter(Boolean))];
    const clientsByName = new Map();
    const clientsById = new Map();
    if (clientIds.length) {
      const clientRows = await VendorClient.findAll({
        where: { id: { [Op.in]: clientIds } },
        attributes: ['id', 'entity_code', 'name'],
      });
      clientRows.forEach((c) => {
        const d = c.get({ plain: true });
        clientsById.set(d.id, d);
        clientsByName.set(String(d.name || '').toLowerCase().trim(), d);
      });
    }
    // Fallback: for orders without vendor_client_id, try matching by customer_name
    const unmatchedNames = orderRows
      .filter((r) => !r.vendor_client_id)
      .map((r) => String(r.customer_name || '').toLowerCase().trim())
      .filter((n) => n && !clientsByName.has(n));
    if (unmatchedNames.length) {
      const fallbackClients = await VendorClient.findAll({
        where: {
          [Op.and]: [
            buildActiveClientWhere(),
            db.where(db.fn('lower', db.col('name')), { [Op.in]: unmatchedNames }),
          ],
        },
        attributes: ['id', 'entity_code', 'name'],
      });
      fallbackClients.forEach((c) => {
        const d = c.get({ plain: true });
        clientsByName.set(String(d.name || '').toLowerCase().trim(), d);
      });
    }

    // --- Fetch comment counts per SO ---
    const commentCounts = await FulfillmentComment.findAll({
      where: {
        entity_type: 'so',
        entity_id: { [Op.in]: orderIds },
        lifecycle_status: 'active',
      },
      attributes: ['entity_id', [db.fn('COUNT', db.col('id')), 'cnt']],
      group: ['entity_id'],
      raw: true,
    });
    const commentCountMap = {};
    commentCounts.forEach((r) => { commentCountMap[r.entity_id] = parseInt(r.cnt, 10) || 0; });

    // --- Index items and splits by order id ---
    const itemsByOrder = {};
    items.forEach((it) => {
      const oid = it.fulfillment_order_id;
      if (!itemsByOrder[oid]) itemsByOrder[oid] = [];
      itemsByOrder[oid].push(it.get({ plain: true }));
    });

    const splitsByOrder = {};
    splits.forEach((s) => {
      const oid = s.fulfillment_order_id;
      if (!splitsByOrder[oid]) splitsByOrder[oid] = [];
      splitsByOrder[oid].push(s.get({ plain: true }));
    });

    // --- Build response rows ---
    const rows = [];
    for (const order of orderRows) {
      const o = order.get({ plain: true });
      const orderItems = itemsByOrder[o.id] || [];
      const orderSplits = splitsByOrder[o.id] || [];

      // First product (name + code) + "+N more" badge
      const firstItem = orderItems[0];
      const productDisplay = firstItem
        ? { name: firstItem.product_name, code: firstItem.product_code || firstItem.sku || '', extraCount: Math.max(0, orderItems.length - 1) }
        : null;
      // Unit price: primary line's unit_price (single-line SOs show exact; multi-line uses first line as representative)
      const unitPrice = firstItem && firstItem.unit_price != null ? Number(firstItem.unit_price) : 0;

      // Aggregated quantities
      const { fgReadyQty, packedQty, invoicedQty, shippedQty } = aggregateSplitQtys(orderSplits);
      const totalOrderedQty = orderItems.reduce((sum, it) => sum + (Number(it.ordered_qty) || 0), 0);

      // Batch pills
      const { pills: batchPills, total: batchTotal } = buildBatchPills(orderSplits, batchMap);

      // SLA flag
      const slaFlag = computeSlaFlag(o.due_date, o.so_status);

      // Client info
      const clientFromId = o.vendor_client_id ? clientsById.get(o.vendor_client_id) : null;
      const clientFromName = clientsByName.get(String(o.customer_name || '').toLowerCase().trim());
      const clientInfo = clientFromId || clientFromName || null;

      const row = {
        id: o.id,
        soNo: o.so_no,
        soDate: o.order_date,
        dueDate: o.due_date,
        committedDate: committedDateBySalesOrderId.get(o.sales_order_id) || null,
        priority: o.priority,
        soStatus: o.so_status,
        commercialStatus: o.commercial_status || 'received',
        orderStatus: orderStatusById.get(o.sales_order_id) || null,
        soValue: o.so_value != null ? Number(o.so_value) : 0,
        unitPrice,
        customer: {
          name: o.customer_name,
          code: clientInfo ? clientInfo.entity_code : null,
          city: o.customer_city || '',
          clientId: o.vendor_client_id || (clientInfo ? clientInfo.id : null),
        },
        product: productDisplay,
        totalOrderedQty,
        fgReadyQty,
        fgReadyPct: totalOrderedQty > 0 ? Math.round((fgReadyQty / totalOrderedQty) * 100) : 0,
        packedQty,
        packedPct: totalOrderedQty > 0 ? Math.round((packedQty / totalOrderedQty) * 100) : 0,
        invoicedQty,
        invoicedPct: totalOrderedQty > 0 ? Math.round((invoicedQty / totalOrderedQty) * 100) : 0,
        shippedQty,
        shippedPct: totalOrderedQty > 0 ? Math.round((shippedQty / totalOrderedQty) * 100) : 0,
        stageStatus: computeStageStatus(orderSplits, batchMap),
        batchPills,
        batchPillsTotal: batchTotal,
        slaFlag,
        commentCount: commentCountMap[o.id] || 0,
      };

      // Apply flagged_only filter post-aggregation (overdue SOs)
      if (flagged_only === 'true' && !slaFlag.overdue) continue;

      rows.push(row);
    }

    res.json({ total: totalCount, page: pageNum, pageSize: limit, rows });
  } catch (err) {
    console.error('listSalesOrdersDashboard error:', err);
    res.status(500).json({ error: 'Failed to fetch sales orders dashboard' });
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   VIEW 2 — Products & Batches Dashboard
───────────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/v1/fulfillment/batches-dashboard
 * Query: stage[], due_before, due_after, client_id, product_id, flagged_only, group_by, search, page, page_size
 * Returns one row per batch split enriched with stage_log + SLA deltas.
 */
async function listBatchesDashboard(req, res) {
  try {
    const {
      stage, due_before, due_after, client_id, product_id,
      flagged_only, search, page = 1, page_size = 200,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limit = Math.min(1000, Math.max(1, parseInt(page_size, 10) || 200));
    const offset = (pageNum - 1) * limit;

    // --- Build split WHERE ---
    const splitWhere = {};

    // Stage filter: map spec stage labels back to ff_status values
    if (stage) {
      const stages = Array.isArray(stage) ? stage : [stage];
      const ffStatuses = new Set();
      stages.forEach((s) => {
        switch (String(s).toUpperCase()) {
          case 'PLANNING': ffStatuses.add('fg_pending'); ffStatuses.add('wip'); break;
          case 'PROCUREMENT': ffStatuses.add('fg_pending'); break;
          case 'PRODUCTION': ffStatuses.add('wip'); ffStatuses.add('bulk_qc'); ffStatuses.add('fg_pending'); break;
          case 'FG_READY': case 'FG READY': ffStatuses.add('fg_ready'); break;
          case 'PACKED': ffStatuses.add('picking'); break;
          case 'INVOICED': ffStatuses.add('invoiced'); break;
          case 'SHIPPED': ffStatuses.add('shipped'); ffStatuses.add('delivered'); ffStatuses.add('closed'); break;
        }
      });
      if (ffStatuses.size > 0) {
        splitWhere.ff_status = { [Op.in]: [...ffStatuses] };
      }
    }

    // --- Build order WHERE for join ---
    const orderWhere = activeRowWhere();
    if (due_before) orderWhere.due_date = { ...(orderWhere.due_date || {}), [Op.lte]: due_before };
    if (due_after) orderWhere.due_date = { ...(orderWhere.due_date || {}), [Op.gte]: due_after };
    if (client_id) orderWhere.vendor_client_id = parseInt(client_id, 10);

    // search by so_no or customer_name
    if (search) {
      const s = `%${search}%`;
      orderWhere[Op.or] = [{ so_no: { [Op.iLike]: s } }, { customer_name: { [Op.iLike]: s } }];
    }

    // --- Fetch qualifying order IDs ---
    const matchingOrders = await FulfillmentOrder.findAll({
      where: orderWhere,
      attributes: ['id', 'so_no', 'order_date', 'due_date', 'priority', 'so_status', 'commercial_status', 'customer_name', 'vendor_client_id'],
    });
    const orderIdSet = new Set(matchingOrders.map((o) => o.id));
    if (!orderIdSet.size) return res.json({ total: 0, page: pageNum, pageSize: limit, rows: [] });
    splitWhere.fulfillment_order_id = { [Op.in]: [...orderIdSet] };

    // Product-level filter via item (match by product_code/sku from products table)
    let matchingItemIds = null;
    if (product_id) {
      const pid = parseInt(product_id, 10);
      const itemWhere = { fulfillment_order_id: { [Op.in]: [...orderIdSet] } };
      if (!Number.isNaN(pid) && pid > 0) {
        const prod = await Product.findByPk(pid, { attributes: ['product_code', 'zoho_sku_code'] });
        if (prod) {
          const d = prod.get({ plain: true });
          const skuFilters = [d.product_code, d.zoho_sku_code].filter(Boolean);
          if (skuFilters.length) {
            itemWhere[Op.or] = [
              { product_code: { [Op.in]: skuFilters } },
              { sku: { [Op.in]: skuFilters } },
            ];
          }
        }
      }
      const matchedItems = await FulfillmentOrderItem.findAll({ where: itemWhere, attributes: ['id'] });
      matchingItemIds = matchedItems.map((it) => it.id);
      if (!matchingItemIds.length) return res.json({ total: 0, page: pageNum, pageSize: limit, rows: [] });
      splitWhere.fulfillment_order_item_id = { [Op.in]: matchingItemIds };
    }

    // --- Count + fetch splits ---
    const totalCount = await FulfillmentBatchSplit.count({ where: splitWhere });

    const splitRows = await FulfillmentBatchSplit.findAll({
      where: splitWhere,
      order: [['fulfillment_order_id', 'ASC'], ['id', 'ASC']],
      limit,
      offset,
      attributes: [
        'id', 'fulfillment_order_id', 'fulfillment_order_item_id',
        'production_batch_id', 'bmr_no', 'bpr_no',
        'planned_qty', 'fg_qty', 'fg_location', 'ff_status',
        'picked_qty', 'picker_name', 'pick_date',
        'invoice_no', 'awb_no', 'courier', 'dispatch_date', 'eta_date',
        'delivery_date', 'received_by',
      ],
      include: [{
        model: BatchStageLog,
        as: 'stageLogs',
        required: false,
        order: [['started_at', 'ASC']],
      }],
    });

    if (!splitRows.length) return res.json({ total: totalCount, page: pageNum, pageSize: limit, rows: [] });

    const splitIds = splitRows.map((s) => s.id);
    const splitOrderIds = [...new Set(splitRows.map((s) => s.fulfillment_order_id))];
    const splitItemIds = [...new Set(splitRows.map((s) => s.fulfillment_order_item_id))];

    // --- Bulk-fetch items + production batches + comment counts ---
    const prodBatchIds = [...new Set(splitRows.map((s) => s.production_batch_id).filter(Boolean))];
    const [itemRows, prodBatchRows, commentCounts] = await Promise.all([
      FulfillmentOrderItem.findAll({
        where: { id: { [Op.in]: splitItemIds } },
        attributes: ['id', 'fulfillment_order_id', 'sku', 'product_code', 'product_name', 'pack', 'ordered_qty', 'unit_price'],
      }),
      prodBatchIds.length
        ? ProductionBatch.findAll({
            where: { id: { [Op.in]: prodBatchIds } },
            attributes: ['id', 'batch_no', 'bpr_no', 'bpr_status', 'bmr_status', 'so_no', 'fg_yield', 'fill_yield'],
          })
        : Promise.resolve([]),
      FulfillmentComment.findAll({
        where: { entity_type: 'batch', entity_id: { [Op.in]: splitIds }, lifecycle_status: 'active' },
        attributes: ['entity_id', [db.fn('COUNT', db.col('id')), 'cnt']],
        group: ['entity_id'],
        raw: true,
      }),
    ]);

    // Build lookup maps
    const orderMap = {};
    matchingOrders.forEach((o) => { orderMap[o.id] = o.get({ plain: true }); });

    const itemMap = {};
    itemRows.forEach((it) => { itemMap[it.id] = it.get({ plain: true }); });

    const batchMap = {};
    prodBatchRows.forEach((pb) => { batchMap[pb.id] = pb.get({ plain: true }); });

    const commentCountMap = {};
    commentCounts.forEach((r) => { commentCountMap[r.entity_id] = parseInt(r.cnt, 10) || 0; });

    // Client codes
    const clientIds = [...new Set(Object.values(orderMap).map((o) => o.vendor_client_id).filter(Boolean))];
    const clientsById = new Map();
    if (clientIds.length) {
      const clientRows = await VendorClient.findAll({
        where: { id: { [Op.in]: clientIds } },
        attributes: ['id', 'entity_code', 'name'],
      });
      clientRows.forEach((c) => { const d = c.get({ plain: true }); clientsById.set(d.id, d); });
    }

    // SLA templates (fetch all relevant stages for items' product codes)
    const allSlaTemplates = await FulfillmentSlaTemplate.findAll({
      where: { [Op.or]: [{ product_id: null }, { product_id: null }] }, // fetch global defaults
      attributes: ['product_id', 'stage', 'committed_days'],
    });
    const globalSlaMap = {};
    allSlaTemplates.forEach((t) => {
      const d = t.get({ plain: true });
      if (d.product_id == null) globalSlaMap[d.stage] = Number(d.committed_days);
    });

    // --- Build response rows ---
    const rows = [];
    const now = new Date();

    for (const splitRow of splitRows) {
      const s = splitRow.get ? splitRow.get({ plain: true }) : splitRow;
      const stageLogs = (splitRow.stageLogs || []).map((l) => l.get ? l.get({ plain: true }) : l);
      const order = orderMap[s.fulfillment_order_id] || {};
      const item = itemMap[s.fulfillment_order_item_id] || {};
      const pb = s.production_batch_id ? batchMap[s.production_batch_id] : null;
      const client = order.vendor_client_id ? clientsById.get(order.vendor_client_id) : null;

      const displayStage = deriveBatchDisplayStage(s.ff_status, pb ? pb.bpr_status : null);
      const batchNo = pb ? (pb.batch_no || s.bpr_no) : s.bpr_no;

      // Enrich stage logs with SLA data
      const enrichedLogs = stageLogs.map((log) => {
        const committed = log.committed_days != null
          ? Number(log.committed_days)
          : (globalSlaMap[log.stage] ?? SLA_DEFAULTS[log.stage] ?? null);
        const actualDays = log.completed_at
          ? calendarDaysDiff(log.started_at, log.completed_at)
          : calendarDaysDiff(log.started_at, now);
        const slipped = committed != null && actualDays != null && actualDays > committed;
        const approaching = !slipped && committed != null && actualDays != null && actualDays >= committed * 0.8;
        return {
          stage: log.stage,
          stageLabel: STAGE_LABEL[log.stage === 'picking' ? 'PACKED' : log.stage?.toUpperCase()] || log.stage,
          startedAt: log.started_at,
          completedAt: log.completed_at,
          actorName: log.actor_name,
          committedDays: committed,
          actualDays,
          slipped,
          approaching,
        };
      });

      // SLA flag for due_date
      const slaFlag = computeSlaFlag(order.due_date, s.ff_status);

      // flagged_only: skip if neither overdue nor any stage slipped
      if (flagged_only === 'true' && !slaFlag.overdue && !enrichedLogs.some((l) => l.slipped)) continue;

      rows.push({
        id: s.id,
        soId: s.fulfillment_order_id,
        soNo: order.so_no || '',
        soDate: order.order_date || null,
        dueDate: order.due_date || null,
        priority: order.priority || 'normal',
        soStatus: order.so_status || '',
        commercialStatus: order.commercial_status || 'received',
        client: {
          name: order.customer_name || '',
          code: client ? client.entity_code : null,
          city: order.customer_city || '',
          id: order.vendor_client_id || null,
        },
        product: {
          name: item.product_name || '',
          code: item.product_code || item.sku || '',
          pack: item.pack || '',
          orderedQty: Number(item.ordered_qty) || 0,
          unitPrice: item.unit_price != null ? Number(item.unit_price) : 0,
        },
        batch: {
          batchNo,
          bprNo: s.bpr_no || '',
          bmrNo: s.bmr_no || '',
          plannedQty: Number(s.planned_qty) || 0,
          coveragePct: (item.ordered_qty > 0 && s.planned_qty > 0)
            ? Math.round((Number(s.planned_qty) / Number(item.ordered_qty)) * 100)
            : 0,
          stage: displayStage,
          stageLabel: STAGE_LABEL[displayStage] || displayStage,
          fgLocation: s.fg_location || null,
        },
        ffStatus: s.ff_status,
        // FG in batch UNITS (fg_yield → fill_yield → picker units), never KG
        fgQty: (pb && pb.fg_yield != null && Number(pb.fg_yield) > 0) ? Number(pb.fg_yield)
          : (pb && pb.fill_yield != null && Number(pb.fill_yield) > 0) ? Number(pb.fill_yield)
          : (Number(s.picked_qty) || 0),
        pickedQty: Number(s.picked_qty) || 0,
        // Stage-gated quantities (mirror SO-dashboard aggregateSplitQtys, per single split)
        packedQty: ['picking', 'invoiced', 'shipped', 'delivered', 'closed'].includes(String(s.ff_status || ''))
          ? Number(s.picked_qty) || 0 : 0,
        invoicedQty: ['invoiced', 'shipped', 'delivered', 'closed'].includes(String(s.ff_status || ''))
          ? Number(s.picked_qty) || 0 : 0,
        shippedQty: ['shipped', 'delivered', 'closed'].includes(String(s.ff_status || ''))
          ? Number(s.picked_qty) || 0 : 0,
        invoiceNo: s.invoice_no || null,
        awbNo: s.awb_no || null,
        courier: s.courier || null,
        dispatchDate: s.dispatch_date || null,
        etaDate: s.eta_date || null,
        deliveryDate: s.delivery_date || null,
        stageLogs: enrichedLogs,
        slaFlag,
        commentCount: commentCountMap[s.id] || 0,
      });
    }

    res.json({ total: totalCount, page: pageNum, pageSize: limit, rows });
  } catch (err) {
    console.error('listBatchesDashboard error:', err);
    res.status(500).json({ error: 'Failed to fetch batches dashboard' });
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   COMMENTS
───────────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/v1/fulfillment/comments/:entityType/:entityId
 * Returns all comments + system stage log events interleaved by date (newest first).
 */
async function listComments(req, res) {
  try {
    const { entityType, entityId } = req.params;
    if (!['so', 'batch'].includes(entityType)) {
      return res.status(400).json({ error: 'entityType must be "so" or "batch"' });
    }
    const id = parseInt(entityId, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid entityId' });

    const [comments, stageLogs] = await Promise.all([
      FulfillmentComment.findAll({
        where: { entity_type: entityType, entity_id: id, lifecycle_status: 'active' },
        order: [['created_at', 'DESC']],
        attributes: ['id', 'by_user_name', 'by_user_id', 'text', 'tagged_users', 'attachments', 'resolved', 'created_at'],
      }),
      entityType === 'batch'
        ? BatchStageLog.findAll({
            where: { fulfillment_batch_split_id: id },
            order: [['started_at', 'DESC']],
            attributes: ['id', 'stage', 'started_at', 'completed_at', 'actor_name', 'committed_days'],
          })
        : Promise.resolve([]),
    ]);

    const feed = [
      ...comments.map((c) => {
        const d = c.get({ plain: true });
        return {
          kind: 'comment',
          id: d.id,
          at: d.created_at,
          byName: d.by_user_name,
          byUserId: d.by_user_id,
          text: d.text,
          taggedUsers: d.tagged_users || [],
          attachments: d.attachments || [],
          resolved: d.resolved,
        };
      }),
      ...stageLogs.map((l) => {
        const d = l.get({ plain: true });
        const actualDays = d.completed_at
          ? calendarDaysDiff(d.started_at, d.completed_at)
          : calendarDaysDiff(d.started_at, new Date());
        const committed = d.committed_days != null ? Number(d.committed_days) : null;
        return {
          kind: 'stage_event',
          id: d.id,
          at: d.started_at,
          stage: d.stage,
          stageLabel: STAGE_LABEL[d.stage === 'picking' ? 'PACKED' : (d.stage || '').toUpperCase()] || d.stage,
          startedAt: d.started_at,
          completedAt: d.completed_at,
          actorName: d.actor_name,
          committedDays: committed,
          actualDays,
          slipped: committed != null && actualDays != null && actualDays > committed,
        };
      }),
    ].sort((a, b) => new Date(b.at) - new Date(a.at));

    res.json(feed);
  } catch (err) {
    console.error('listComments error:', err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
}

/**
 * POST /api/v1/fulfillment/comments/:entityType/:entityId
 * Body: { text, taggedUsers: [{id, name}], attachments: [{name, url}] }
 */
async function addComment(req, res) {
  try {
    const { entityType, entityId } = req.params;
    if (!['so', 'batch'].includes(entityType)) {
      return res.status(400).json({ error: 'entityType must be "so" or "batch"' });
    }
    const id = parseInt(entityId, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid entityId' });

    const { text, taggedUsers, attachments } = req.body;
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: 'text is required' });
    }

    const actorName = req.user ? (req.user.fullName || req.user.email || null) : null;
    const actorId = req.user ? (req.user.id || req.user.userId || null) : null;

    const comment = await FulfillmentComment.create({
      entity_type: entityType,
      entity_id: id,
      by_user_id: actorId,
      by_user_name: actorName,
      text: String(text).trim(),
      tagged_users: Array.isArray(taggedUsers) ? taggedUsers : [],
      attachments: Array.isArray(attachments) ? attachments : [],
      resolved: false,
    });

    const d = comment.get({ plain: true });
    res.status(201).json({
      id: d.id,
      entityType,
      entityId: id,
      byName: d.by_user_name,
      byUserId: d.by_user_id,
      text: d.text,
      taggedUsers: d.tagged_users || [],
      attachments: d.attachments || [],
      resolved: d.resolved,
      createdAt: d.created_at,
    });
  } catch (err) {
    console.error('addComment error:', err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
}

/**
 * PATCH /api/v1/fulfillment/comments/:commentId/resolve
 * Marks a comment as resolved.
 */
async function resolveComment(req, res) {
  try {
    const commentId = parseInt(req.params.commentId, 10);
    if (Number.isNaN(commentId)) return res.status(400).json({ error: 'Invalid commentId' });

    const comment = await FulfillmentComment.findOne({
      where: { id: commentId, lifecycle_status: 'active' },
    });
    if (!comment) return res.status(404).json({ error: 'Comment not found' });

    comment.set('resolved', true);
    await comment.save();
    res.json({ id: comment.id, resolved: true });
  } catch (err) {
    console.error('resolveComment error:', err);
    res.status(500).json({ error: 'Failed to resolve comment' });
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   SLA TEMPLATES
───────────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/v1/fulfillment/sla-templates/:productId
 * Returns SLA stage durations for a product (product-specific overrides merged with global defaults).
 */
async function getSlaTemplate(req, res) {
  try {
    const productId = parseInt(req.params.productId, 10);
    if (Number.isNaN(productId) || productId <= 0) {
      return res.status(400).json({ error: 'Valid productId is required' });
    }

    const [specific, global] = await Promise.all([
      FulfillmentSlaTemplate.findAll({
        where: { product_id: productId },
        attributes: ['stage', 'committed_days', 'notes'],
      }),
      FulfillmentSlaTemplate.findAll({
        where: { product_id: null },
        attributes: ['stage', 'committed_days', 'notes'],
      }),
    ]);

    const result = { picking: null, invoiced: null, shipped: null, delivered: null };

    // Apply global defaults first
    global.forEach((t) => { const d = t.get({ plain: true }); result[d.stage] = Number(d.committed_days); });
    // Layer in system defaults for any still-null
    Object.keys(SLA_DEFAULTS).forEach((s) => { if (result[s] == null) result[s] = SLA_DEFAULTS[s]; });
    // Override with product-specific
    specific.forEach((t) => { const d = t.get({ plain: true }); result[d.stage] = Number(d.committed_days); });

    res.json({ productId, stages: result });
  } catch (err) {
    console.error('getSlaTemplate error:', err);
    res.status(500).json({ error: 'Failed to fetch SLA template' });
  }
}

/**
 * PUT /api/v1/fulfillment/sla-templates/:productId
 * Upsert stage durations for a product (or global defaults when productId = 0).
 * Body: { stages: { picking: N, invoiced: N, shipped: N, delivered: N } }
 */
async function upsertSlaTemplate(req, res) {
  try {
    const productIdParam = parseInt(req.params.productId, 10);
    const productId = productIdParam === 0 ? null : productIdParam;
    if (productId !== null && (Number.isNaN(productId) || productId <= 0)) {
      return res.status(400).json({ error: 'productId must be a positive integer, or 0 for global defaults' });
    }

    const { stages } = req.body || {};
    if (!stages || typeof stages !== 'object') {
      return res.status(400).json({ error: 'stages object is required' });
    }

    const validStages = ['picking', 'invoiced', 'shipped', 'delivered'];
    const results = [];
    for (const s of validStages) {
      if (stages[s] == null) continue;
      const days = parseFloat(stages[s]);
      if (!Number.isFinite(days) || days <= 0) continue;
      const [row] = await FulfillmentSlaTemplate.findOrCreate({
        where: { product_id: productId ?? null, stage: s },
        defaults: { committed_days: days },
      });
      if (Number(row.committed_days) !== days) {
        row.set('committed_days', days);
        await row.save();
      }
      results.push({ stage: s, committedDays: days });
    }

    res.json({ productId: productId ?? 0, updated: results });
  } catch (err) {
    console.error('upsertSlaTemplate error:', err);
    res.status(500).json({ error: 'Failed to save SLA template' });
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   COMMERCIAL STATUS
───────────────────────────────────────────────────────────────────────────── */

/**
 * PATCH /api/v1/fulfillment/:id/commercial-status
 * Body: { status: 'approved' | 'on_hold' | 'received' | ... }
 * Handles ON HOLD ↔ previous status round-trip.
 */
async function updateCommercialStatus(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const { status, reason } = req.body;
    const VALID = ['draft', 'received', 'advance_pending', 'under_review', 'approved', 'partial_closed', 'closed', 'on_hold'];
    if (!status || !VALID.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID.join(', ')}` });
    }

    const order = await FulfillmentOrder.findByPk(id);
    if (!order) return res.status(404).json({ error: 'Fulfillment order not found' });

    const current = order.commercial_status || 'received';

    // PARTIAL CLOSED and CLOSED are auto-computed; block manual set (unless admin override)
    if (['partial_closed', 'closed'].includes(status)) {
      // Compute actual shipped qty to validate
      const splits = await FulfillmentBatchSplit.findAll({
        where: { fulfillment_order_id: id },
        attributes: ['ff_status', 'picked_qty'],
      });
      const items = await FulfillmentOrderItem.findAll({
        where: { fulfillment_order_id: id },
        attributes: ['ordered_qty'],
      });
      const totalOrdered = items.reduce((s, it) => s + (Number(it.ordered_qty) || 0), 0);
      const totalShipped = splits
        .filter((s) => ['shipped', 'delivered', 'closed'].includes(s.ff_status))
        .reduce((s, sp) => s + (Number(sp.picked_qty) || 0), 0);
      if (status === 'closed' && totalShipped < totalOrdered) {
        return res.status(409).json({ error: `Cannot set CLOSED: shipped qty (${totalShipped}) < ordered qty (${totalOrdered})` });
      }
    }

    // ON HOLD round-trip
    if (status === 'on_hold') {
      if (current === 'on_hold') {
        return res.status(409).json({ error: 'Order is already on hold' });
      }
      order.set({ commercial_status: 'on_hold', on_hold_previous_status: current });
    } else if (current === 'on_hold' && status !== 'on_hold') {
      // Un-hold: restore previous if not explicitly overriding
      order.set({ commercial_status: status, on_hold_previous_status: null });
    } else {
      order.set({ commercial_status: status });
    }

    await order.save();

    // Auto-write a comment when reason is provided
    if (reason && String(reason).trim()) {
      const actorName = req.user ? (req.user.fullName || req.user.email || null) : null;
      const actorId = req.user ? (req.user.id || req.user.userId || null) : null;
      await FulfillmentComment.create({
        entity_type: 'so',
        entity_id: id,
        by_user_id: actorId,
        by_user_name: actorName,
        text: `Status changed from ${current} → ${status}. ${String(reason).trim()}`,
        tagged_users: [],
        attachments: [],
        resolved: false,
      });
    }

    await tryInvalidateCache();

    res.json({
      id,
      commercialStatus: order.commercial_status,
      previousStatus: current,
    });
  } catch (err) {
    console.error('updateCommercialStatus error:', err);
    res.status(500).json({ error: 'Failed to update commercial status' });
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   TRANSPORTER CRUD
───────────────────────────────────────────────────────────────────────────── */

function formatTransporter(d) {
  return {
    id: d.id,
    name: d.name,
    code: d.code || null,
    phone: d.contact_phone || null,
    email: d.contact_email || null,
    trackingUrl: d.tracking_url || null,
    status: d.status,
  };
}

/** POST /api/v1/fulfillment/transporters */
async function createTransporter(req, res) {
  try {
    const { name, code, phone, email, trackingUrl, status } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const transporter = await Transporter.create({
      name: String(name).trim(),
      code: code ? String(code).trim() : null,
      contact_phone: phone || null,
      contact_email: email || null,
      tracking_url: trackingUrl || null,
      status: status === 'inactive' ? 'inactive' : 'active',
    });
    await tryInvalidateCache();
    res.status(201).json(formatTransporter(transporter.get({ plain: true })));
  } catch (err) {
    console.error('createTransporter error:', err);
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'A transporter with this code already exists' });
    }
    res.status(500).json({ error: 'Failed to create transporter' });
  }
}

/** PATCH /api/v1/fulfillment/transporters/:id */
async function updateTransporter(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const transporter = await Transporter.findByPk(id);
    if (!transporter) return res.status(404).json({ error: 'Transporter not found' });

    const { name, code, phone, email, trackingUrl, status } = req.body;
    if (name !== undefined) transporter.set('name', String(name).trim());
    if (code !== undefined) transporter.set('code', code ? String(code).trim() : null);
    if (phone !== undefined) transporter.set('contact_phone', phone || null);
    if (email !== undefined) transporter.set('contact_email', email || null);
    if (trackingUrl !== undefined) transporter.set('tracking_url', trackingUrl || null);
    if (status !== undefined) transporter.set('status', ['active', 'inactive'].includes(status) ? status : 'active');

    await transporter.save();
    await tryInvalidateCache();
    res.json(formatTransporter(transporter.get({ plain: true })));
  } catch (err) {
    console.error('updateTransporter error:', err);
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'A transporter with this code already exists' });
    }
    res.status(500).json({ error: 'Failed to update transporter' });
  }
}

/** DELETE /api/v1/fulfillment/transporters/:id — soft-delete (status=inactive) */
async function deleteTransporter(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

    const transporter = await Transporter.findByPk(id);
    if (!transporter) return res.status(404).json({ error: 'Transporter not found' });

    // Don't hard-delete — existing invoices reference this transporter. Mark inactive.
    transporter.set('status', 'inactive');
    await transporter.save();
    await tryInvalidateCache();
    res.json({ id, status: 'inactive', message: 'Transporter deactivated' });
  } catch (err) {
    console.error('deleteTransporter error:', err);
    res.status(500).json({ error: 'Failed to deactivate transporter' });
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   EXPORTS (functions + stage log helpers consumed by controller.js)
───────────────────────────────────────────────────────────────────────────── */

module.exports = {
  // Dashboard views
  listSalesOrdersDashboard,
  listBatchesDashboard,
  // Comments
  listComments,
  addComment,
  resolveComment,
  // SLA
  getSlaTemplate,
  upsertSlaTemplate,
  // Commercial status
  updateCommercialStatus,
  computeCommercialStatusFromShippedQty,
  // Transporter CRUD
  createTransporter,
  updateTransporter,
  deleteTransporter,
  // Stage log helpers (used by controller.js workflow actions)
  openStageLog,
  closeStageLog,
};

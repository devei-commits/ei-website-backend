/**
 * Regression test for: a production batch created against a sale order's PR (planning row)
 * did not show up in the Sales Orders dashboard's "Batch Stage" column, because
 * listSalesOrdersDashboard() read fulfillment_batch_splits directly without ever running the
 * production -> fulfillment sync that listOrders()/getOrderById() already ran. See
 * src/fulfillment/batchSplitSync.js.
 */
const db = require('../../db');
require('../../app');

const { Op } = require('sequelize');
const { Product } = require('../../src/products/models');
const SalesOrder = require('../../src/salesOrders/models');
const PlanningExtracted = require('../../src/planningExtracted/models');
const PlanningBatch = require('../../src/planningExtracted/planningBatchModel');
const { ProductionBatch } = require('../../src/production/models');
const { FulfillmentOrder, FulfillmentOrderItem, FulfillmentBatchSplit } = require('../../src/fulfillment/models');
const { listSalesOrdersDashboard } = require('../../src/fulfillment/dashboardController');
const { isDbAvailable } = require('../helpers/dbAvailability');

const SO_NO_PREFIX = 'EI-SO-2026-STAGE-';

/** This suite runs against the shared dev DB (see jest.config.js) — hard-delete every fixture it wrote. */
async function cleanupFixtures() {
  const orders = await FulfillmentOrder.findAll({ where: { so_no: { [Op.like]: `${SO_NO_PREFIX}%` } } });
  const orderIds = orders.map((o) => o.id);
  const batches = await ProductionBatch.findAll({ where: { so_no: { [Op.like]: `${SO_NO_PREFIX}%` } } });
  const batchIds = batches.map((b) => b.id);
  const planningBatchIds = [...new Set(batches.map((b) => b.planning_batch_id).filter(Boolean))];

  await FulfillmentBatchSplit.destroy({ where: { [Op.or]: [{ fulfillment_order_id: orderIds }, { production_batch_id: batchIds }] } });
  await FulfillmentOrderItem.destroy({ where: { fulfillment_order_id: orderIds } });
  await FulfillmentOrder.destroy({ where: { id: orderIds } });
  await ProductionBatch.destroy({ where: { id: batchIds } });

  const salesOrders = await SalesOrder.findAll({ where: { order_id: { [Op.like]: `${SO_NO_PREFIX}%` } } });
  const salesOrderIds = salesOrders.map((s) => s.id);
  await PlanningBatch.destroy({ where: { id: planningBatchIds } });
  await PlanningExtracted.destroy({ where: { sales_order_id: salesOrderIds } });
  await SalesOrder.destroy({ where: { id: salesOrderIds } });

  await Product.destroy({ where: { product_code: { [Op.like]: 'PR-STAGE-%' } } });
}

function resMock() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('Sales Orders dashboard batch-stage sync (regression)', () => {
  let dbAvailable = true;

  beforeAll(async () => {
    dbAvailable = await isDbAvailable(db);
    if (dbAvailable) await cleanupFixtures();
  });

  afterAll(async () => {
    if (dbAvailable) {
      await cleanupFixtures();
      await db.close();
    }
  });

  test('a batch created against the SO with no prior split row shows up in Batch Stage (direct sku match)', async () => {
    if (!dbAvailable) return;

    const soNo = 'EI-SO-2026-STAGE-001';
    const product = await Product.create({
      zoho_sku_code: 'SKU-STAGE-001',
      product_name: 'Stage Sync Product',
      status: 'Active',
      product_code: 'PR-STAGE-001',
    });

    const fulfillmentOrder = await FulfillmentOrder.create({
      so_no: soNo,
      customer_name: 'Stage Sync Customer',
      priority: 'normal',
      so_status: 'planned',
      so_value: 0,
      order_date: '2026-08-01',
      due_date: '2026-09-01',
    });
    await FulfillmentOrderItem.create({
      fulfillment_order_id: fulfillmentOrder.id,
      item_no: '1',
      sku: product.zoho_sku_code,
      product_code: product.product_code,
      product_name: product.product_name,
      pack: 'PCS',
      ordered_qty: 1000,
      rate: 90,
      unit_price: 90,
    });

    // Batch created in Production (e.g. via Planning "send to production"), but nothing has
    // touched GET /fulfillment or GET /fulfillment/:id yet, so no fulfillment_batch_splits row
    // exists for it — this is the exact "created one batch, not reflecting" scenario reported.
    await ProductionBatch.create({
      bmr_no: 'BMR-2026-STAGE-001',
      bpr_no: 'BPR-2026-STAGE-001',
      product_name: product.product_name,
      sku: product.zoho_sku_code,
      so_no: soNo,
      order_qty: 400,
      batch_size: 20,
      batch_index: 1,
      total_batches: 1,
      planning_batch_id: null,
      bmr_status: 'draft',
      bpr_status: 'draft',
    });

    // Filter to just this SO — the dashboard is paginated and the shared dev DB has plenty of
    // other orders, so an unfiltered query could miss this row on page 1.
    const req = { query: { search: soNo } };
    const res = resMock();
    await listSalesOrdersDashboard(req, res);

    expect(res.statusCode).toBe(200);
    const row = res.body.rows.find((r) => r.soNo === soNo);
    expect(row).toBeTruthy();
    expect(row.batchPillsTotal).toBeGreaterThan(0);
    expect(row.batchPills.some((p) => p.bprNo === 'BPR-2026-STAGE-001')).toBe(true);
  });

  test('matches a batch to its SO line via the Planning PR product_code when sku/product_name diverge', async () => {
    if (!dbAvailable) return;

    const soNo = 'EI-SO-2026-STAGE-002';
    const product = await Product.create({
      zoho_sku_code: null, // pre-Zoho-sync draft: blank, like the real-world case
      product_name: 'Stage Sync Product Renamed',
      status: 'Active',
      product_code: 'PR-STAGE-002',
    });

    const salesOrder = await SalesOrder.create({
      order_id: soNo,
      customer_name: 'Stage Sync Customer 2',
      status: 'Approved',
    });
    const planningExtracted = await PlanningExtracted.create({
      sales_order_id: salesOrder.id,
      product_id: product.product_id,
      order_qty_display: '1000 pcs',
    });
    const planningBatch = await PlanningBatch.create({
      planning_extracted_id: planningExtracted.id,
      sequence: 1,
      batch_code: 'PE-STAGE-002-B1',
      size_kg: 20,
    });

    const fulfillmentOrder = await FulfillmentOrder.create({
      so_no: soNo,
      sales_order_id: salesOrder.id,
      customer_name: 'Stage Sync Customer 2',
      priority: 'normal',
      so_status: 'planned',
      so_value: 0,
      order_date: '2026-08-01',
      due_date: '2026-09-01',
    });
    await FulfillmentOrderItem.create({
      fulfillment_order_id: fulfillmentOrder.id,
      item_no: '1',
      sku: null,
      product_code: product.product_code, // SO line's cached product_code — the "PR"
      product_name: 'test15', // deliberately different display name than the batch below
      pack: 'PCS',
      ordered_qty: 1000,
      rate: 90,
      unit_price: 90,
    });

    // Production batch's own sku/product_name do NOT match the fulfillment item's — only the
    // Planning PR linkage (planning_batch_id -> planning_extracted -> product_code) ties them.
    await ProductionBatch.create({
      bmr_no: 'BMR-2026-STAGE-002',
      bpr_no: 'BPR-2026-STAGE-002',
      product_name: 'Some Other Display Name',
      sku: '',
      so_no: soNo,
      order_qty: 400,
      batch_size: 20,
      batch_index: 1,
      total_batches: 1,
      planning_batch_id: planningBatch.id,
      bmr_status: 'draft',
      bpr_status: 'draft',
    });

    // Filter to just this SO — the dashboard is paginated and the shared dev DB has plenty of
    // other orders, so an unfiltered query could miss this row on page 1.
    const req = { query: { search: soNo } };
    const res = resMock();
    await listSalesOrdersDashboard(req, res);

    expect(res.statusCode).toBe(200);
    const row = res.body.rows.find((r) => r.soNo === soNo);
    expect(row).toBeTruthy();
    expect(row.batchPillsTotal).toBeGreaterThan(0);
    expect(row.batchPills.some((p) => p.bprNo === 'BPR-2026-STAGE-002')).toBe(true);
  });
});

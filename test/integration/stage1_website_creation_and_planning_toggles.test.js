/**
 * Stage 1 gaps:
 * - Create SO via website/Admin order route (`POST /api/v1/orders`)
 *   and verify it auto-creates SalesOrder, FulfillmentOrder, PlanningExtracted,
 *   plus initial production/fulfillment placeholders.
 * - Verify planning reservation toggles when `bom_confirmed_at` transitions
 *   (null <-> non-null) updates `warehouse_inventory.reserved`.
 * - Verify `sent_batch_indices` impacts global `GET /api/v1/planning-extracted/items-involved`
 *   (only included sent batches contribute to `totalRequired`).
 */

if (!process.env.ACCESS_TOKEN_SECRET) process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../../db');
const app = require('../../app');

const RawMaterial = require('../../src/rawMaterials/models');
const PackMaterial = require('../../src/packMaterials/models');
const BOM = require('../../src/bom/models');
const WarehouseInventory = require('../../src/warehouseInventory/models');
const { Product } = require('../../src/products/models');
const { User } = require('../../src/users/models');
const Address = require('../../src/models/Addresses');
const { isDbAvailable } = require('../helpers/dbAvailability');

const SalesOrder = require('../../src/salesOrders/models');
const PlanningExtracted = require('../../src/planningExtracted/models');
const PlanningBatch = require('../../src/planningExtracted/planningBatchModel');
const { ProductionBatch } = require('../../src/production/models');
const { FulfillmentOrder, FulfillmentBatchSplit } = require('../../src/fulfillment/models');
const { ReservedBatchItem } = require('../../src/fulfillment/models');

describe('Stage 1: website order -> planning placeholders + toggles (integration)', () => {
  let token;
  let dbAvailable = true;

  let user;
  let rm;
  let pm;
  let fg;
  let bom;

  let plan;

  const rmCode = 'EI-RM-STAGE1-001';
  const pmCode = 'EI-PM-STAGE1-001';
  const sku = 'SKU-FG-STAGE1-001';

  beforeAll(async () => {
    dbAvailable = await isDbAvailable(db);
    if (!dbAvailable) return;

    await db.sync({ force: true });

    // Auth user (admin so `requireModule('order-management')` passes for planning endpoints)
    user = await User.create({
      fname: 'Stage1',
      lname: 'User',
      email: 'stage1-admin@example.com',
      password: 'hash',
      usertype: 'admin',
    });
    token = jwt.sign(
      { email: user.email, role: user.usertype || 'admin' },
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: '7d' }
    );

    // Master data
    rm = await RawMaterial.create({ code: rmCode, name: 'Stage1 RM', status: 'Active' });
    pm = await PackMaterial.create({ code: pmCode, description: 'Stage1 PM', status: 'Active' });
    fg = await Product.create({
      product_sku: sku,
      product_name: 'Stage1 FG Product',
      status: 'Active',
      product_code: 'FG-STAGE1-001',
      batch_size_kg: 500,
      mrp_price: 12,
    });

    bom = await BOM.create({
      bom_code: 'BOM-STAGE1-001',
      name: 'Stage1 BOM',
      product_id: fg.product_id,
      rm_lines: [{ rm_code: rm.code, pct_w_w: 10, uom: 'KG', specific_gravity: 1 }],
      pm_lines: [{ pm_code: pm.code, qty_per_unit: 1, uom: 'PCS' }],
    });

    // Seed WH inventory rows required by reservation sync
    await WarehouseInventory.create({
      item_type: 'RM',
      raw_material_id: rm.id,
      pack_material_id: null,
      product_id: null,
      wh_stock: 100,
      wh_unit: 'KG',
      ml1_stock: 0,
      ml2_stock: 0,
      stock_in_hand: 100,
      reserved: 0,
      in_transit: 0,
      reorder_pt: 0,
      avg_mo: 0,
      qc_status: 'In Stock',
    });
    await WarehouseInventory.create({
      item_type: 'PM',
      raw_material_id: null,
      pack_material_id: pm.id,
      product_id: null,
      wh_stock: 100,
      wh_unit: 'PCS',
      ml1_stock: 0,
      ml2_stock: 0,
      stock_in_hand: 100,
      reserved: 0,
      in_transit: 0,
      reorder_pt: 0,
      avg_mo: 0,
      qc_status: 'In Stock',
    });

    // Addresses for website order creation
    const billing = await Address.create({
      user_id: user.userid,
      address_type: 'billing',
      address_line1: '1 Test Street',
      first_name: 'Stage1',
      last_name: 'User',
      city_text: 'Test City',
      state_text: 'Test State',
      country_text: 'IN',
      pincode: '000000',
    });
    const shipping = await Address.create({
      user_id: user.userid,
      address_type: 'shipping',
      address_line1: '2 Test Avenue',
      first_name: 'Stage1',
      last_name: 'User',
      city_text: 'Test City',
      state_text: 'Test State',
      country_text: 'IN',
      pincode: '000000',
    });

    // Create SO via website/Admin route (`POST /api/v1/orders`)
    const createResp = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        billing_address_id: billing.address_id,
        shipping_address_id: shipping.address_id,
        order_items: [
          {
            product_id: fg.product_id,
            quantity: 10,
            unit_price: 5,
            tax_amount: 0,
            discount_amount: 0,
          },
        ],
        shipping_total: 0,
        discount_total: 0,
      });

    expect(createResp.status).toBe(201);

    const soNo = createResp.body.so_no;
    expect(typeof soNo).toBe('string');

    // Verify auto-created: SalesOrder, FulfillmentOrder, PlanningExtracted, production + fulfillment placeholders
    const salesOrder = await SalesOrder.findOne({ where: { order_id: soNo } });
    expect(salesOrder).toBeTruthy();

    const fulfillmentOrder = await FulfillmentOrder.findOne({ where: { so_no: soNo } });
    expect(fulfillmentOrder).toBeTruthy();

    plan = await PlanningExtracted.findOne({ where: { sales_order_id: salesOrder.id, product_id: fg.product_id } });
    expect(plan).toBeTruthy();

    // Production batch placeholder
    const prodBatches = await ProductionBatch.findAll({ where: { so_no: soNo } });
    expect(prodBatches.length).toBeGreaterThanOrEqual(1);

    // Fulfillment placeholders (split)
    const splits = await FulfillmentBatchSplit.findAll({ where: { fulfillment_order_id: fulfillmentOrder.id } });
    expect(splits.length).toBeGreaterThanOrEqual(1);

    // Add planning_batches required by items-involved (global) endpoint
    await PlanningBatch.create({
      planning_extracted_id: plan.id,
      sequence: 1,
      batch_code: `PE-${plan.id}-B1`,
      size_kg: 50,
      rm_lines: [{ rm_code: rm.code, pct_w_w: 10, uom: 'KG', specific_gravity: 1 }],
      pm_lines: [{ pm_code: pm.code, qty_per_unit: 1, uom: 'PCS' }],
    });
    await PlanningBatch.create({
      planning_extracted_id: plan.id,
      sequence: 2,
      batch_code: `PE-${plan.id}-B2`,
      size_kg: 50,
      rm_lines: [{ rm_code: rm.code, pct_w_w: 10, uom: 'KG', specific_gravity: 1 }],
      pm_lines: [{ pm_code: pm.code, qty_per_unit: 1, uom: 'PCS' }],
    });

    // Ensure items-involved PM calculations have non-null plan total_kg_display
    await plan.update({
      order_qty_display: '10 units',
      total_kg_display: '10 KG',
      sent_batch_indices: [0],
    });
  });

  afterAll(async () => {
    if (dbAvailable) await db.close();
  });

  function authHeaders() {
    return { Authorization: `Bearer ${token}` };
  }

  test('PUT `bom_confirmed_at` -> null releases warehouse_inventory.reserved', async () => {
    if (!dbAvailable) return;

    const rmInvBefore = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rm.id } });
    const pmInvBefore = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pm.id } });
    expect(Number(rmInvBefore.reserved)).toBeGreaterThan(0);
    expect(Number(pmInvBefore.reserved)).toBeGreaterThan(0);

    // Release by transitioning bom_confirmed_at from non-null -> null
    const releaseResp = await request(app)
      .patch(`/api/v1/planning-extracted/${plan.id}`)
      .set('Authorization', authHeaders().Authorization)
      .send({ bomConfirmedAt: null });

    expect(releaseResp.status).toBe(200);

    const rmInvAfter = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rm.id } });
    const pmInvAfter = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pm.id } });
    expect(Number(rmInvAfter.reserved)).toBe(0);
    expect(Number(pmInvAfter.reserved)).toBe(0);

    const reservedRows = await ReservedBatchItem.findAll({ where: { planning_extracted_id: plan.id } });
    expect(reservedRows.length).toBe(0);
  });

  test('PUT `bom_confirmed_at` -> non-null re-creates warehouse_inventory.reserved', async () => {
    if (!dbAvailable) return;

    const resetResp = await request(app)
      .patch(`/api/v1/planning-extracted/${plan.id}`)
      .set('Authorization', authHeaders().Authorization)
      .send({ bomConfirmedAt: new Date().toISOString() });

    expect(resetResp.status).toBe(200);

    const rmInvAfter = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rm.id } });
    const pmInvAfter = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pm.id } });
    expect(Number(rmInvAfter.reserved)).toBeGreaterThan(0);
    expect(Number(pmInvAfter.reserved)).toBeGreaterThan(0);

    const reservedRows = await ReservedBatchItem.findAll({ where: { planning_extracted_id: plan.id } });
    expect(reservedRows.length).toBeGreaterThan(0);
  });

  test('sent_batch_indices filters `items-involved.totalRequired` by sent PlanningBatch sequence', async () => {
    if (!dbAvailable) return;

    // Only sequence 1 sent -> totalRequired should reflect only batch #1
    const p0Resp = await request(app)
      .patch(`/api/v1/planning-extracted/${plan.id}`)
      .set('Authorization', authHeaders().Authorization)
      .send({ sentBatchIndices: [0] });
    expect(p0Resp.status).toBe(200);

    const items0 = await request(app)
      .get('/api/v1/planning-extracted/items-involved')
      .set('Authorization', authHeaders().Authorization);
    expect(items0.status).toBe(200);

    const rmItem0 = items0.body.find((x) => x.type === 'RM' && x.code === rm.code);
    expect(rmItem0).toBeTruthy();

    // RM qty per sent batch = size_kg * pct / 100 = 50 * 10 / 100 = 5
    expect(Number(rmItem0.totalRequired)).toBe(5);

    // sequence 1 + 2 sent -> totalRequired should double
    const p01Resp = await request(app)
      .patch(`/api/v1/planning-extracted/${plan.id}`)
      .set('Authorization', authHeaders().Authorization)
      .send({ sentBatchIndices: [0, 1] });
    expect(p01Resp.status).toBe(200);

    const items01 = await request(app)
      .get('/api/v1/planning-extracted/items-involved')
      .set('Authorization', authHeaders().Authorization);
    expect(items01.status).toBe(200);

    const rmItem01 = items01.body.find((x) => x.type === 'RM' && x.code === rm.code);
    expect(rmItem01).toBeTruthy();
    expect(Number(rmItem01.totalRequired)).toBe(10);
  });
});


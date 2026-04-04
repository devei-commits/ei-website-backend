/**
 * Stage 2 gaps (excluding Redis):
 * - Shortfall detection -> PR creation:
 *   * compute shortages via `GET /api/v1/planning-extracted/items-involved`
 *   * create a procurement request via `POST /api/v1/procurement`
 *   * verify PR items quantities match detected shortfall quantities.
 * - Quotation selection -> draft PO creation (partial coverage):
 *   * create a procurement quotation via `POST /api/v1/procurement-quotations`
 *   * create a draft purchase order via `POST /api/v1/purchase-orders` using quotation items.
 * - PO release -> GRN creation in inbound warehouse:
 *   * create GRN via `POST /api/v1/grn`
 *   * generate labels via `/generate-labels`
 *   * mark GRN complete via `PUT /api/v1/grn/:id`
 *   * verify `warehouse_inventory.wh_stock` and `stock_in_hand` are updated.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../../db');
const app = require('../../app');

const { isDbAvailable } = require('../helpers/dbAvailability');
const { useStaticJwtSecretsForTests } = require('../helpers/jwtTestEnv');

const RawMaterial = require('../../src/rawMaterials/models');
const PackMaterial = require('../../src/packMaterials/models');
const WarehouseInventory = require('../../src/warehouseInventory/models');
const { Product } = require('../../src/products/models');
const PlanningExtracted = require('../../src/planningExtracted/models');
const PlanningBatch = require('../../src/planningExtracted/planningBatchModel');
const SalesOrder = require('../../src/salesOrders/models');
const VendorClient = require('../../src/vendorClient/models');
const ProcurementQuotation = require('../../src/procurementQuotations/models');
const ProcurementRequest = require('../../src/procurementRequests/models');
const PurchaseOrder = require('../../src/purchaseOrders/models');
const GoodsReceivedNote = require('../../src/grn/models');
const { User } = require('../../src/users/models');

describe('Stage 2: shortfall -> PR; PO -> GRN -> inventory (integration)', () => {
  let dbAvailable = true;
  let token;
  let user;

  let rm;
  let pm;
  let fg;

  let plan;
  let planBatch;
  let rmItemTotalRequired = 0;
  let rmItemSurplusShortage = 0;

  const rmCode = 'EI-RM-STAGE2-001';
  const pmCode = 'EI-PM-STAGE2-001';
  const sku = 'SKU-FG-STAGE2-001';

  beforeAll(async () => {
    dbAvailable = await isDbAvailable(db);
    if (!dbAvailable) return;

    useStaticJwtSecretsForTests();

    await db.sync({ force: true });

    // Auth user (admin: order-management + sales-purchase)
    user = await User.create({
      fname: 'Stage2',
      lname: 'User',
      email: 'stage2-admin@example.com',
      password: 'hash',
      usertype: 'admin',
    });
    token = jwt.sign(
      {
        email: user.email,
        role: user.usertype || 'admin',
        sub: user.userid,
        id: user.userid,
      },
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: '7d' }
    );

    // Masters
    rm = await RawMaterial.create({ code: rmCode, name: 'Stage2 RM', status: 'Active' });
    pm = await PackMaterial.create({ code: pmCode, description: 'Stage2 PM', status: 'Active' });
    fg = await Product.create({
      product_sku: sku,
      product_name: 'Stage2 FG Product',
      status: 'Active',
      product_code: 'FG-STAGE2-001',
      batch_size_kg: 500,
      mrp_price: 12,
    });

    // Planning rows
    const so = await SalesOrder.create({ order_id: 'SO-STAGE2-001', customer_name: 'Stage2 Customer', status: 'Approved' });
    plan = await PlanningExtracted.create({
      sales_order_id: so.id,
      product_id: fg.product_id,
      order_qty_display: '10 units',
      total_kg_display: '10 KG',
      bom_status: 'Confirmed',
      bom_confirmed_at: new Date(),
      raw_materials: [{ raw_material_id: rm.id, quantity: 5, unit: 'KG' }],
      packaging_materials: [{ pack_material_id: pm.id, quantity: 5, unit: 'PCS' }],
      sent_batch_indices: [0],
      batch_size_kg: 50,
      batches_required: 1,
      batch_count: 1,
    });
    planBatch = await PlanningBatch.create({
      planning_extracted_id: plan.id,
      sequence: 1,
      batch_code: `PE-${plan.id}-B1`,
      size_kg: 50,
      rm_lines: [{ rm_code: rm.code, pct_w_w: 10, uom: 'KG', specific_gravity: 1 }],
      pm_lines: [{ pm_code: pm.code, qty_per_unit: 1, uom: 'PCS' }],
    });

    // Inventory seed so shortage can be computed:
    // sih = wh_stock + ml1_stock + ml2_stock, reserved doesn't reduce sih in this endpoint's `surplusShortage`.
    await WarehouseInventory.create({
      item_type: 'RM',
      raw_material_id: rm.id,
      pack_material_id: null,
      product_id: null,
      wh_stock: 2,
      wh_unit: 'KG',
      ml1_stock: 0,
      ml2_stock: 0,
      stock_in_hand: 2,
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
      wh_stock: 2,
      wh_unit: 'PCS',
      ml1_stock: 0,
      ml2_stock: 0,
      stock_in_hand: 2,
      reserved: 0,
      in_transit: 0,
      reorder_pt: 0,
      avg_mo: 0,
      qc_status: 'In Stock',
    });
  });

  afterAll(async () => {
    if (dbAvailable) await db.close();
  });

  function auth() {
    return { Authorization: `Bearer ${token}` };
  }

  test('Shortfall detection creates ProcurementRequest with correct item quantities', async () => {
    if (!dbAvailable) return;

    const itemsResp = await request(app)
      .get('/api/v1/planning-extracted/items-involved')
      .set('Authorization', auth().Authorization);
    expect(itemsResp.status).toBe(200);

    const rmItem = itemsResp.body.find((x) => x.type === 'RM' && x.code === rm.code);
    expect(rmItem).toBeTruthy();

    rmItemTotalRequired = Number(rmItem.totalRequired);
    rmItemSurplusShortage = Number(rmItem.surplusShortage);
    expect(rmItemTotalRequired).toBe(5); // 50kg * 10% / 100
    expect(rmItemSurplusShortage).toBe(-3); // sih(2) - totalRequired(5)

    const shortageQty = Math.max(0, -rmItemSurplusShortage);

    const prResp = await request(app)
      .post('/api/v1/procurement')
      .set('Authorization', auth().Authorization)
      .send({
        planningExtractedId: plan.id,
        planningBatchId: planBatch.id,
        priority: 'normal',
        requiredByDate: '2026-03-30',
        status: 'Pending',
        items: [
          {
            type: 'RM',
            raw_material_id: rm.id,
            quantity_requested: shortageQty,
            unit: 'KG',
          },
        ],
      });

    expect(prResp.status).toBe(201);
    expect(prResp.body.planningExtractedId).toBe(plan.id);

    const created = await ProcurementRequest.findByPk(prResp.body.id);
    expect(created).toBeTruthy();
    expect(Array.isArray(created.items)).toBe(true);
    expect(created.items[0].quantity_requested).toBe(shortageQty);
  });

  test('Draft PO can be created from quotation items; GRN completion updates inventory', async () => {
    if (!dbAvailable) return;

    const vendor = await VendorClient.create({
      entity_code: 'EI-VEN-STAGE2-0001',
      type: 'vendor',
      name: 'Stage2 Vendor',
      status: 'active',
    });

    // Seed procurement request (quotation creation expects a PR or explicit items)
    const pr = await ProcurementRequest.create({
      planning_extracted_id: plan.id,
      planning_batch_id: planBatch.id,
      priority: 'normal',
      required_by_date: '2026-03-30',
      status: 'Pending',
      items: [
        {
          type: 'RM',
          raw_material_id: rm.id,
          quantity_requested: 3,
          unit: 'KG',
          code: rm.code,
          name: rm.name,
        },
      ],
    });

    // Procurement quotation (provide explicit pricePerUnit to avoid dependency on items-list/vendor price tables)
    const quotePayload = {
      procurementRequestId: pr.id,
      vendorId: vendor.id,
      status: 'confirmed',
      items: [
        {
          itemId: rm.code,
          name: rm.name,
          raw_material_id: rm.id,
          orderQty: 3,
          uom: 'KG',
          pricePerUnit: 10,
          totalValue: 30,
        },
      ],
      total_value: 30,
    };

    const quoteResp = await request(app)
      .post('/api/v1/procurement-quotations')
      .set('Authorization', auth().Authorization)
      .send(quotePayload);
    expect(quoteResp.status).toBe(201);

    const createdQuote = await ProcurementQuotation.findByPk(quoteResp.body.id);
    expect(createdQuote).toBeTruthy();

    // Draft PO from quotation items (partial coverage of quotation -> draft PO chain)
    const poOrderId = 'PO-STAGE2-001';
    const poResp = await request(app)
      .post('/api/v1/purchase-orders')
      .set('Authorization', auth().Authorization)
      .send({
        orderId: poOrderId,
        vendorName: vendor.name,
        branch: 'Main',
        orderDate: '2026-03-20',
        expectedShipmentDate: '2026-03-25',
        reference: 'From quotation',
        paymentTerms: '15 days',
        status: 'Draft',
        items: [
          { raw_material_id: rm.id, quantity: 3, uom: 'KG' },
        ],
      });
    expect(poResp.status).toBe(201);

    const createdPo = await PurchaseOrder.findByPk(poResp.body.id);
    expect(createdPo).toBeTruthy();

    // Create GRN with QC passed + generate labels + mark complete
    const grnResp = await request(app)
      .post('/api/v1/grn')
      .set('Authorization', auth().Authorization)
      .send({
        grnNo: 'GRN-STAGE2-001',
        purchase_order_id: createdPo.id,
        poNo: createdPo.orderId || createdPo.order_id || poOrderId,
        vendor: vendor.name,
        type: 'RM',
        qcStatus: 'Passed',
        qcBy: 'Inspector',
        assignedTo: 'Warehouse Team',
        status: 'Under GRN',
        lineItems: [
          { raw_material_id: rm.id, itemCode: rm.code, item: rm.name, rcvdQty: 3, poQty: 3, quantity: 3, unit: 'KG' },
        ],
        workflowSteps: [],
      });
    expect(grnResp.status).toBe(201);
    expect(grnResp.body.status).toBeDefined();

    const grnId = parseInt(grnResp.body.id, 10);

    const labelsResp = await request(app)
      .post(`/api/v1/grn/${grnId}/generate-labels`)
      .set('Authorization', auth().Authorization)
      .send({
        noOfBoxes: 1,
        unitsPerBox: 3,
        locationPrefix: 'LOC-MU01',
        grnBatchMfg: 'BATCH',
        expiry: '2027-01-01',
        mfgBatch: 'MFG-1',
        productName: fg.product_name,
        itemCode: rm.code,
      });
    expect(labelsResp.status).toBe(200);
    expect(Array.isArray(labelsResp.body.labels)).toBe(true);
    expect(labelsResp.body.labels.length).toBe(1);

    const completeResp = await request(app)
      .put(`/api/v1/grn/${grnId}`)
      .set('Authorization', auth().Authorization)
      .send({ status: 'GRN Complete' });
    expect(completeResp.status).toBe(200);

    const rmInv = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rm.id } });
    expect(Number(rmInv.wh_stock)).toBe(5); // started with 2, GRN adds 3
    expect(Number(rmInv.stock_in_hand)).toBe(5);

    const grnRow = await GoodsReceivedNote.findByPk(grnId);
    expect(grnRow).toBeTruthy();
  });
});


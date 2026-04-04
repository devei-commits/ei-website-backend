/**
 * Stage 3 gaps:
 * - Production sync-from-planning (`POST /api/v1/production/batches/sync-from-planning`)
 * - MRN/MTR flow details:
 *   * create outbound MTR MRN with `source: 'MTR'` and `bmr_no`
 *   * update to `Completed` with MU zone/rack
 *   * verify WH -> MU inventory move + production rm_connected/pm_connected
 *   * verify location history entries + MRN labels generation
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
const WarehouseInventoryLocationHistory = require('../../src/warehouseInventory/locationHistoryModel');

const { Product } = require('../../src/products/models');
const SalesOrder = require('../../src/salesOrders/models');
const PlanningExtracted = require('../../src/planningExtracted/models');
const PlanningBatch = require('../../src/planningExtracted/planningBatchModel');

const { ProductionBatch } = require('../../src/production/models');
const MaterialRequestNote = require('../../src/mrn/models');
const mrnController = require('../../src/mrn/controller');

const Address = require('../../src/models/Addresses');
const { User } = require('../../src/users/models');

describe('Stage 3: sync-from-planning + MTR MRN completion (labels + history)', () => {
  let dbAvailable = true;
  let token;
  let rm;
  let pm;

  // Production batch used for MTR/MRN flow assertions
  let mtrProductionBatch;
  let mtrMrn;

  // Separate planning rows used for sync-from-planning assertions
  let syncSo;
  let syncProduct;
  let syncPlan;
  let syncPlanningBatch;

  beforeAll(async () => {
    dbAvailable = await isDbAvailable(db);
    if (!dbAvailable) return;

    useStaticJwtSecretsForTests();

    await db.sync({ force: true });

    const user = await User.create({
      fname: 'Stage3',
      lname: 'User',
      email: 'stage3-admin@example.com',
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

    // Masters + warehouse inventory for MRN completion checks
    rm = await RawMaterial.create({ code: 'EI-RM-STAGE3-001', name: 'Stage3 RM', status: 'Active' });
    pm = await PackMaterial.create({ code: 'EI-PM-STAGE3-001', description: 'Stage3 PM', status: 'Active' });

    await WarehouseInventory.create({
      item_type: 'RM',
      raw_material_id: rm.id,
      pack_material_id: null,
      product_id: null,
      wh_stock: 30,
      wh_unit: 'KG',
      ml1_stock: 0,
      ml2_stock: 0,
      stock_in_hand: 30,
      reserved: 30,
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
      wh_stock: 30,
      wh_unit: 'PCS',
      ml1_stock: 0,
      ml2_stock: 0,
      stock_in_hand: 30,
      reserved: 30,
      in_transit: 0,
      reorder_pt: 0,
      avg_mo: 0,
      qc_status: 'In Stock',
    });

    mtrProductionBatch = await ProductionBatch.create({
      bmr_no: 'BMR-2026-888',
      bpr_no: 'BPR-2026-888',
      product_name: 'Stage3 Production Product',
      sku: 'SKU-STAGE3-888',
      so_no: 'SO-STAGE3-888',
      order_qty: 30,
      batch_size: 30,
      batch_no: 'B-01',
      batch_index: 1,
      total_batches: 1,
      planning_batch_id: null,
      bmr_status: 'rm_reserved',
      bpr_status: 'pm_reserved',
      rm_connected: false,
      pm_connected: false,
      rm_reserved: false,
      pm_reserved: false,
    });

    // Build minimal data for sync-from-planning
    syncProduct = await Product.create({
      product_sku: 'SKU-FG-STAGE3-SYNC-001',
      product_name: 'Stage3 Sync FG',
      product_code: 'FG-SYNC-001',
      batch_size_kg: 100,
      mrp_price: 10,
      status: 'Active',
    });
    syncSo = await SalesOrder.create({
      order_id: 'EI-SO-STAGE3-SYNC-001',
      customer_name: 'Sync Customer',
      status: 'Approved',
      items: [],
    });
    // This planning row needs sent_batch_indices for sync endpoint to pick it up
    syncPlan = await PlanningExtracted.create({
      sales_order_id: syncSo.id,
      product_id: syncProduct.product_id,
      order_qty_display: '20 units',
      total_kg_display: '20 KG',
      bom_status: 'Confirmed',
      bom_confirmed_at: new Date(),
      raw_materials: [{ raw_material_id: rm.id, quantity: 20, unit: 'KG' }],
      packaging_materials: [{ pack_material_id: pm.id, quantity: 20, unit: 'PCS' }],
      sent_batch_indices: [0],
      batch_size_kg: 100,
      batches_required: 1,
      batch_count: 1,
    });
    syncPlanningBatch = await PlanningBatch.create({
      planning_extracted_id: syncPlan.id,
      sequence: 1,
      batch_code: `PE-${syncPlan.id}-B1`,
      size_kg: 50,
      rm_lines: [{ rm_code: rm.code, pct_w_w: 100, uom: 'KG', specific_gravity: 1 }],
      pm_lines: [{ pm_code: pm.code, qty_per_unit: 1, uom: 'PCS' }],
    });

    // (Sync test doesn't require BOM here; production batches created by sync are independent of BOM copy.)
    void mrnController;
  });

  afterAll(async () => {
    if (dbAvailable) await db.close();
  });

  function auth() {
    return { Authorization: `Bearer ${token}` };
  }

  test('sync-from-planning creates ProductionBatch for each sent PlanningBatch sequence', async () => {
    if (!dbAvailable) return;

    const resp = await request(app)
      .post('/api/v1/production/batches/sync-from-planning')
      .set('Authorization', auth().Authorization);

    expect(resp.status).toBe(200);
    expect(resp.body.success).toBe(true);
    expect(resp.body.created).toBeGreaterThanOrEqual(1);

    const created = await ProductionBatch.findOne({
      where: {
        planning_batch_id: syncPlanningBatch.id,
        batch_index: 1,
      },
    });
    expect(created).toBeTruthy();
  });

  test('MTR MRN Completed moves WH -> MU, writes history, advances to dispensing, and can generate labels', async () => {
    if (!dbAvailable) return;

    // Create outbound MTR MRN (initial status must be Received at MU)
    const mrnResp = await request(app)
      .post('/api/v1/mrn')
      .set('Authorization', auth().Authorization)
      .send({
        mrnNo: 'MRN-STAGE3-001',
        status: 'Received at MU',
        source: 'MTR',
        bmrNo: mtrProductionBatch.bmr_no,
        isInboundFromMu: false,
        lineItems: [
          { raw_material_id: rm.id, quantity: 30, unit: 'KG' },
          { pack_material_id: pm.id, quantity: 30, unit: 'PCS' },
        ],
      });
    expect(mrnResp.status).toBe(201);

    mtrMrn = await MaterialRequestNote.findOne({ where: { mrn_no: 'MRN-STAGE3-001' } });
    expect(mtrMrn).toBeTruthy();

    // Complete MRN transfer with MU zone/rack
    const completeResp = await request(app)
      .put(`/api/v1/mrn/${mtrMrn.id}`)
      .set('Authorization', auth().Authorization)
      .send({
        status: 'Completed',
        muReceiveZone: 'LOC-MU01',
        muReceiveRack: 'R1',
      });
    expect(completeResp.status).toBe(200);

    const rmInv = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rm.id } });
    const pmInv = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pm.id } });

    // WH decreased and ML1 increased for outbound MTR
    expect(Number(rmInv.wh_stock)).toBe(0);
    expect(Number(rmInv.ml1_stock)).toBe(30);
    expect(Number(rmInv.reserved)).toBe(0);

    expect(Number(pmInv.wh_stock)).toBe(0);
    expect(Number(pmInv.ml1_stock)).toBe(30);
    expect(Number(pmInv.reserved)).toBe(0);

    // Production connected flags advanced when this was the last pending MTR
    const refreshedBatch = await ProductionBatch.findByPk(mtrProductionBatch.id);
    expect(refreshedBatch.rm_connected).toBe(true);
    expect(refreshedBatch.pm_connected).toBe(true);
    expect(refreshedBatch.bmr_status).toBe('dispensing');
    expect(refreshedBatch.bpr_status).toBe('pm_dispensing');

    // Verify location history entries (MRN_IN_MU)
    const historyRows = await WarehouseInventoryLocationHistory.findAll({
      where: { source_mrn_id: mtrMrn.id, action_type: 'MRN_IN_MU' },
    });
    expect(historyRows.length).toBeGreaterThanOrEqual(1);

    // MRN labels (MU put-away labels)
    const labelsResp = await request(app)
      .post(`/api/v1/mrn/${mtrMrn.id}/generate-labels`)
      .set('Authorization', auth().Authorization)
      .send({
        noOfBoxes: 2,
        unitsPerBox: 1,
        locationPrefix: 'LOC-MU01',
        expiry: '2027-01-01',
        mfgBatch: 'MFG-1',
        productName: 'Stage3 FG',
        itemCode: rm.code,
      });
    expect(labelsResp.status).toBe(200);
    expect(Array.isArray(labelsResp.body.labels)).toBe(true);
    expect(labelsResp.body.labels.length).toBe(2);

    const refreshedMrn = await MaterialRequestNote.findByPk(mtrMrn.id);
    expect(Array.isArray(refreshedMrn.generated_labels)).toBe(true);
    expect(refreshedMrn.generated_labels.length).toBe(2);
  });
});


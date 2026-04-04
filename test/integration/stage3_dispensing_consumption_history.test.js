/**
 * Stage 3 remaining item:
 * - Dispensing consumption updates MU stock (ML1/ML2/WH -> stock_in_hand)
 * - and records `warehouse_inventory_location_history` rows linked to the production batch.
 *
 * This test drives the real production PATCH endpoint:
 *   PATCH /api/v1/production/batches/:id
 * with `dispensing_rm` / `dispensing_pm`.
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
const { ProductionBatch } = require('../../src/production/models');
const { User } = require('../../src/users/models');

describe('Stage 3: dispensing consumption -> MU stock + history link (integration)', () => {
  let dbAvailable = true;
  let token;

  let rm;
  let pm;
  let batch;

  beforeAll(async () => {
    dbAvailable = await isDbAvailable(db);
    if (!dbAvailable) return;

    useStaticJwtSecretsForTests();

    await db.sync({ force: true });

    const user = await User.create({
      fname: 'Stage3Dispense',
      lname: 'User',
      email: 'stage3-dispense@example.com',
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

    rm = await RawMaterial.create({ code: 'EI-RM-STAGE3-DISP-001', name: 'Disp RM', status: 'Active' });
    pm = await PackMaterial.create({ code: 'EI-PM-STAGE3-DISP-001', description: 'Disp PM', status: 'Active' });

    // Start with MU stock in ML1 only so consumption is deterministic.
    await WarehouseInventory.create({
      item_type: 'RM',
      raw_material_id: rm.id,
      pack_material_id: null,
      product_id: null,
      wh_stock: 0,
      wh_unit: 'KG',
      ml1_stock: 10,
      ml2_stock: 0,
      stock_in_hand: 10,
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
      wh_stock: 0,
      wh_unit: 'PCS',
      ml1_stock: 10,
      ml2_stock: 0,
      stock_in_hand: 10,
      reserved: 0,
      in_transit: 0,
      reorder_pt: 0,
      avg_mo: 0,
      qc_status: 'In Stock',
    });

    batch = await ProductionBatch.create({
      bmr_no: 'BMR-2026-DISP-001',
      bpr_no: 'BPR-2026-DISP-001',
      product_name: 'Disp Product',
      sku: 'SKU-DISP-001',
      so_no: 'SO-IGNORE-DISP',
      order_qty: 10,
      batch_size: 10,
      batch_no: 'B-01',
      batch_index: 1,
      total_batches: 1,
      planning_batch_id: null,
      bmr_status: 'dispensing',
      bpr_status: 'pm_dispensing',
      rm_connected: true,
      pm_connected: true,
      rm_reserved: false,
      pm_reserved: false,
      dispensing_rm: null,
      dispensing_pm: null,
      mu_dispensing_bundle_id: null,
    });
  });

  afterAll(async () => {
    if (dbAvailable) await db.close();
  });

  test('PATCH dispensing reduces MU stock and creates history linked to production batch', async () => {
    if (!dbAvailable) return;

    const beforeRm = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rm.id } });
    const beforePm = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pm.id } });

    expect(Number(beforeRm.ml1_stock)).toBe(10);
    expect(Number(beforePm.ml1_stock)).toBe(10);

    // Consume 7 units from ML1 for each of RM/PM.
    const deltaRm = 7;
    const deltaPm = 7;
    const resp = await request(app)
      .patch(`/api/v1/production/batches/${batch.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        dispensing_rm: [{ code: rm.code, dispensed: deltaRm }],
        dispensing_pm: [{ code: pm.code, dispensed: deltaPm }],
      });

    expect(resp.status).toBe(200);

    const afterRm = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rm.id } });
    const afterPm = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pm.id } });

    expect(Number(afterRm.ml1_stock)).toBe(10 - deltaRm);
    expect(Number(afterPm.ml1_stock)).toBe(10 - deltaPm);
    expect(Number(afterRm.stock_in_hand)).toBe(10 - deltaRm);
    expect(Number(afterPm.stock_in_hand)).toBe(10 - deltaPm);

    // History should link dispensing consumption to this production batch.
    const history = await WarehouseInventoryLocationHistory.findAll({
      where: { production_batch_id: batch.id, action_type: 'BMR_DISPENSING' },
    });
    expect(history.length).toBeGreaterThanOrEqual(2);

    // Validate RM history row.
    const rmHist = history.find((h) => h.raw_material_id === rm.id);
    expect(rmHist).toBeTruthy();
    expect(Number(rmHist.qty_delta)).toBeCloseTo(-deltaRm, 5);
    expect(rmHist.production_batch_id).toBe(batch.id);

    // Validate PM history row.
    const pmHist = history.find((h) => h.pack_material_id === pm.id);
    expect(pmHist).toBeTruthy();
    expect(Number(pmHist.qty_delta)).toBeCloseTo(-deltaPm, 5);
    expect(pmHist.production_batch_id).toBe(batch.id);
  });
});


/**
 * Integration: applyRmReservedToInventory / applyPmReservedToInventory create ReservedBatchItem from BOM and sync warehouse_inventory.reserved.
 */
const db = require('../../db');
require('../../app');
const RawMaterial = require('../../src/rawMaterials/models');
const PackMaterial = require('../../src/packMaterials/models');
const WarehouseInventory = require('../../src/warehouseInventory/models');
const { Product } = require('../../src/products/models');
const BOM = require('../../src/bom/models');
const { ProductionBatch } = require('../../src/production/models');
const { ReservedBatchItem } = require('../../src/fulfillment/models');
const {
  applyRmReservedToInventory,
  applyPmReservedToInventory,
  applyDispensingDeltaToWarehouseInventory,
} = require('../../src/production/controller');
const { isDbAvailable } = require('../helpers/dbAvailability');

describe('production reserved', () => {
  let productId;
  let rmId;
  let pmId;
  let batchId;
  let dbAvailable = true;

  beforeAll(async () => {
    dbAvailable = await isDbAvailable(db);
    if (!dbAvailable) return;
    await db.sync({ force: true });
    const product = await Product.create({
      product_sku: 'SKU-PROD-001',
      product_name: 'Test Product',
      status: 'Active',
    });
    productId = product.product_id;
    const rm = await RawMaterial.create({ code: 'RM-PROD-001', name: 'Test RM', status: 'Active' });
    const pm = await PackMaterial.create({ code: 'PM-PROD-001', description: 'Test PM', status: 'Active' });
    rmId = rm.id;
    pmId = pm.id;
    await BOM.create({
      bom_code: 'BOM-001',
      name: 'Test BOM',
      product_id: productId,
      rm_lines: [{ rm_code: 'RM-PROD-001', pct_w_w: 10, uom: 'kg' }],
      pm_lines: [{ pm_code: 'PM-PROD-001', qty_per_unit: 1, uom: 'PCS' }],
    });
    await WarehouseInventory.create({
      item_type: 'RM',
      raw_material_id: rmId,
      wh_stock: 100,
      stock_in_hand: 100,
      reserved: 0,
    });
    await WarehouseInventory.create({
      item_type: 'PM',
      pack_material_id: pmId,
      wh_stock: 50,
      stock_in_hand: 50,
      reserved: 0,
    });
    const batch = await ProductionBatch.create({
      bmr_no: 'BMR-001',
      bpr_no: 'BPR-001',
      product_name: 'Test Product',
      sku: 'SKU-PROD-001',
      batch_size: 500,
      order_qty: 500,
      bmr_status: 'draft',
      bpr_status: 'draft',
    });
    batchId = batch.id;
  });

  afterAll(async () => {
    if (dbAvailable) await db.close();
  });

  test('applyRmReservedToInventory creates ReservedBatchItem and syncs warehouse_inventory.reserved', async () => {
    if (!dbAvailable) return;
    const row = await ProductionBatch.findByPk(batchId);
    await applyRmReservedToInventory(row);
    const items = await ReservedBatchItem.findAll({ where: { production_batch_id: batchId, raw_material_id: rmId } });
    expect(items.length).toBe(1);
    expect(Number(items[0].quantity_reserved)).toBe(50);
    const wh = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rmId } });
    expect(Number(wh.reserved)).toBe(50);
  });

  test('applyPmReservedToInventory creates ReservedBatchItem and syncs warehouse_inventory.reserved', async () => {
    if (!dbAvailable) return;
    const row = await ProductionBatch.findByPk(batchId);
    await applyPmReservedToInventory(row);
    const items = await ReservedBatchItem.findAll({ where: { production_batch_id: batchId, pack_material_id: pmId } });
    expect(items.length).toBe(1);
    expect(Number(items[0].quantity_reserved)).toBe(500);
    const wh = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pmId } });
    expect(Number(wh.reserved)).toBe(500);
  });

  test('dispensing delta reduces ReservedBatchItem and warehouse reserved for RM', async () => {
    if (!dbAvailable) return;
    const batchPlain = { id: batchId, bmr_no: 'BMR-001', bpr_no: 'BPR-001' };
    await applyDispensingDeltaToWarehouseInventory({
      type: 'RM',
      code: 'RM-PROD-001',
      delta: 20,
      sampleLine: { code: 'RM-PROD-001', dispensed: 20 },
      batchPlain,
      dispensingBundleId: null,
    });
    const items = await ReservedBatchItem.findAll({ where: { production_batch_id: batchId, raw_material_id: rmId } });
    expect(Number(items[0].quantity_reserved)).toBe(30);
    const wh = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rmId } });
    expect(Number(wh.reserved)).toBe(30);
  });

  test('dispensing delta reduces ReservedBatchItem and warehouse reserved for PM', async () => {
    if (!dbAvailable) return;
    const batchPlain = { id: batchId, bmr_no: 'BMR-001', bpr_no: 'BPR-001' };
    await applyDispensingDeltaToWarehouseInventory({
      type: 'PM',
      code: 'PM-PROD-001',
      delta: 100,
      sampleLine: { code: 'PM-PROD-001', dispensed: 100 },
      batchPlain,
      dispensingBundleId: null,
    });
    const items = await ReservedBatchItem.findAll({ where: { production_batch_id: batchId, pack_material_id: pmId } });
    expect(Number(items[0].quantity_reserved)).toBe(400);
    const wh = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pmId } });
    expect(Number(wh.reserved)).toBe(400);
  });
});

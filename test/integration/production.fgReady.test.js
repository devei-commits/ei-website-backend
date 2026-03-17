/**
 * Integration: applyBprFgReadyToInventory reduces RM/PM from dispensing, adds FG to warehouse.
 */
const db = require('../../db');
require('../../app');
const RawMaterial = require('../../src/rawMaterials/models');
const PackMaterial = require('../../src/packMaterials/models');
const WarehouseInventory = require('../../src/warehouseInventory/models');
const { Product } = require('../../src/products/models');
const { ProductionBatch } = require('../../src/production/models');
const { applyBprFgReadyToInventory } = require('../../src/production/controller');

describe('production fg_ready', () => {
  let productId;
  let rmId;
  let pmId;
  let batchId;
  let whRmId;
  let whPmId;

  beforeAll(async () => {
    await db.sync({ force: true });
    const product = await Product.create({
      product_sku: 'SKU-FG-001',
      product_name: 'FG Product',
      status: 'Active',
    });
    productId = product.product_id;
    const rm = await RawMaterial.create({ code: 'RM-FG-001', name: 'RM FG', status: 'Active' });
    const pm = await PackMaterial.create({ code: 'PM-FG-001', description: 'PM FG', status: 'Active' });
    rmId = rm.id;
    pmId = pm.id;
    const whRm = await WarehouseInventory.create({
      item_type: 'RM',
      raw_material_id: rmId,
      wh_stock: 100,
      stock_in_hand: 100,
      reserved: 0,
    });
    const whPm = await WarehouseInventory.create({
      item_type: 'PM',
      pack_material_id: pmId,
      wh_stock: 200,
      stock_in_hand: 200,
      reserved: 0,
    });
    whRmId = whRm.id;
    whPmId = whPm.id;
    const batch = await ProductionBatch.create({
      bmr_no: 'BMR-FG-001',
      bpr_no: 'BPR-FG-001',
      product_name: 'FG Product',
      sku: 'SKU-FG-001',
      batch_size: 50,
      order_qty: 50,
      bpr_status: 'packaging',
      dispensing_rm: [{ code: 'RM-FG-001', required: 25, dispensed: 25 }],
      dispensing_pm: [{ code: 'PM-FG-001', required: 50, dispensed: 50 }],
    });
    batchId = batch.id;
  });

  afterAll(async () => {
    await db.close();
  });

  test('applyBprFgReadyToInventory reduces RM and PM wh_stock, adds FG to warehouse', async () => {
    const row = await ProductionBatch.findByPk(batchId);
    await applyBprFgReadyToInventory(row);
    const whRm = await WarehouseInventory.findByPk(whRmId);
    const whPm = await WarehouseInventory.findByPk(whPmId);
    expect(Number(whRm.wh_stock)).toBe(75);
    expect(Number(whPm.wh_stock)).toBe(150);
    const whPr = await WarehouseInventory.findOne({ where: { item_type: 'PR', product_id: productId } });
    expect(whPr).toBeDefined();
    expect(Number(whPr.wh_stock)).toBe(50);
    expect(Number(whPr.stock_in_hand)).toBe(50);
  });
});

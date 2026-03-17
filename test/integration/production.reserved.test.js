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
} = require('../../src/production/controller');

describe('production reserved', () => {
  let productId;
  let rmId;
  let pmId;
  let batchId;

  beforeAll(async () => {
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
    await db.close();
  });

  test('applyRmReservedToInventory creates ReservedBatchItem and syncs warehouse_inventory.reserved', async () => {
    const row = await ProductionBatch.findByPk(batchId);
    await applyRmReservedToInventory(row);
    const items = await ReservedBatchItem.findAll({ where: { production_batch_id: batchId, raw_material_id: rmId } });
    expect(items.length).toBe(1);
    expect(Number(items[0].quantity_reserved)).toBe(50);
    const wh = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rmId } });
    expect(Number(wh.reserved)).toBe(50);
  });

  test('applyPmReservedToInventory creates ReservedBatchItem and syncs warehouse_inventory.reserved', async () => {
    const row = await ProductionBatch.findByPk(batchId);
    await applyPmReservedToInventory(row);
    const items = await ReservedBatchItem.findAll({ where: { production_batch_id: batchId, pack_material_id: pmId } });
    expect(items.length).toBe(1);
    expect(Number(items[0].quantity_reserved)).toBe(500);
    const wh = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pmId } });
    expect(Number(wh.reserved)).toBe(500);
  });
});

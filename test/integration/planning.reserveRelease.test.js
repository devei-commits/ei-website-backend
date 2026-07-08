/**
 * Integration: reserveStockForPlanningExtracted creates ReservedBatchItem and syncs reserved; releaseStockForPlanningExtracted destroys and syncs.
 */
const db = require('../../db');
require('../../app');
const RawMaterial = require('../../src/rawMaterials/models');
const PackMaterial = require('../../src/packMaterials/models');
const WarehouseInventory = require('../../src/warehouseInventory/models');
const PlanningExtracted = require('../../src/planningExtracted/models');
const SalesOrder = require('../../src/salesOrders/models');
const { Product } = require('../../src/products/models');
const { ReservedBatchItem } = require('../../src/fulfillment/models');
const {
  reserveStockForPlanningExtracted,
  releaseStockForPlanningExtracted,
} = require('../../src/planningExtracted/controller');
const { isDbAvailable } = require('../helpers/dbAvailability');

describe('planning reserve and release', () => {
  let planId;
  let rmId;
  let pmId;
  let dbAvailable = true;

  beforeAll(async () => {
    dbAvailable = await isDbAvailable(db);
    if (!dbAvailable) return;
    const so = await SalesOrder.create({ order_id: 'SO-PLAN-001', customer_name: 'Test', status: 'Approved' });
    const product = await Product.create({ zoho_sku_code: 'SKU-PLAN-001', product_name: 'Plan Product', status: 'Active' });
    const rm = await RawMaterial.create({ code: 'RM-PLAN-001', name: 'Plan RM', status: 'Active' });
    const pm = await PackMaterial.create({ code: 'PM-PLAN-001', description: 'Plan PM', status: 'Active' });
    rmId = rm.id;
    pmId = pm.id;
    const plan = await PlanningExtracted.create({
      sales_order_id: so.id,
      product_id: product.product_id,
      order_qty_display: '100',
      total_kg_display: '500',
      bom_status: 'In Progress',
      raw_materials: [{ raw_material_id: rmId, quantity: 20, unit: 'KG' }],
      packaging_materials: [{ pack_material_id: pmId, quantity: 10, unit: 'PCS' }],
    });
    planId = plan.id;
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
  });

  afterAll(async () => {
    if (dbAvailable) await db.close();
  });

  test('reserveStockForPlanningExtracted creates ReservedBatchItem and syncs warehouse_inventory.reserved', async () => {
    if (!dbAvailable) return;
    const row = await PlanningExtracted.findByPk(planId);
    await reserveStockForPlanningExtracted(planId, row);
    const rmItems = await ReservedBatchItem.findAll({ where: { planning_extracted_id: planId, raw_material_id: rmId } });
    const pmItems = await ReservedBatchItem.findAll({ where: { planning_extracted_id: planId, pack_material_id: pmId } });
    expect(rmItems.length).toBe(1);
    expect(Number(rmItems[0].quantity_reserved)).toBe(20);
    expect(pmItems.length).toBe(1);
    expect(Number(pmItems[0].quantity_reserved)).toBe(10);
    const whRm = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rmId } });
    const whPm = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pmId } });
    expect(Number(whRm.reserved)).toBe(20);
    expect(Number(whPm.reserved)).toBe(10);
  });

  test('releaseStockForPlanningExtracted destroys ReservedBatchItem and syncs reserved to 0', async () => {
    if (!dbAvailable) return;
    await releaseStockForPlanningExtracted(planId);
    const count = await ReservedBatchItem.count({ where: { planning_extracted_id: planId } });
    expect(count).toBe(0);
    const whRm = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rmId } });
    const whPm = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: pmId } });
    expect(Number(whRm.reserved)).toBe(0);
    expect(Number(whPm.reserved)).toBe(0);
  });
});

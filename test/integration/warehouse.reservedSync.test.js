/**
 * Integration: syncWarehouseReserved sets warehouse_inventory.reserved = sum(reserved_batch_items.quantity_reserved).
 */
const db = require('../../db');
require('../../app');
const RawMaterial = require('../../src/rawMaterials/models');
const PackMaterial = require('../../src/packMaterials/models');
const WarehouseInventory = require('../../src/warehouseInventory/models');
const { ReservedBatchItem } = require('../../src/fulfillment/models');
const { syncWarehouseReserved } = require('../../src/planningExtracted/controller');
const { isDbAvailable } = require('../helpers/dbAvailability');

describe('warehouse reserved sync', () => {
  let rmId;
  let pmId;
  let whRmId;
  let whPmId;
  let dbAvailable = true;

  beforeAll(async () => {
    dbAvailable = await isDbAvailable(db);
    if (!dbAvailable) return;
    await db.sync({ force: true });
    const rm = await RawMaterial.create({ code: 'RM-TEST-001', name: 'Test RM', status: 'Active' });
    const pm = await PackMaterial.create({ code: 'PM-TEST-001', description: 'Test PM', status: 'Active' });
    rmId = rm.id;
    pmId = pm.id;
    const whRm = await WarehouseInventory.create({
      item_type: 'RM',
      raw_material_id: rmId,
      pack_material_id: null,
      product_id: null,
      wh_stock: 100,
      stock_in_hand: 100,
      reserved: 0,
    });
    const whPm = await WarehouseInventory.create({
      item_type: 'PM',
      raw_material_id: null,
      pack_material_id: pmId,
      product_id: null,
      wh_stock: 50,
      stock_in_hand: 50,
      reserved: 0,
    });
    whRmId = whRm.id;
    whPmId = whPm.id;
  });

  afterAll(async () => {
    if (dbAvailable) await db.close();
  });

  test('syncWarehouseReserved sets reserved to sum of ReservedBatchItem for RM', async () => {
    if (!dbAvailable) return;
    await ReservedBatchItem.create({
      raw_material_id: rmId,
      pack_material_id: null,
      quantity_reserved: 10,
      unit: 'KG',
    });
    await ReservedBatchItem.create({
      raw_material_id: rmId,
      pack_material_id: null,
      quantity_reserved: 20,
      unit: 'KG',
    });
    await syncWarehouseReserved([rmId], []);
    const wh = await WarehouseInventory.findByPk(whRmId);
    expect(Number(wh.reserved)).toBe(30);
  });

  test('syncWarehouseReserved sets reserved for PM', async () => {
    if (!dbAvailable) return;
    await ReservedBatchItem.create({
      raw_material_id: null,
      pack_material_id: pmId,
      quantity_reserved: 5,
      unit: 'PCS',
    });
    await syncWarehouseReserved([], [pmId]);
    const wh = await WarehouseInventory.findByPk(whPmId);
    expect(Number(wh.reserved)).toBe(5);
  });

  test('after destroy items and sync, reserved goes to 0', async () => {
    if (!dbAvailable) return;
    await ReservedBatchItem.destroy({ where: { raw_material_id: rmId } });
    await ReservedBatchItem.destroy({ where: { pack_material_id: pmId } });
    await syncWarehouseReserved([rmId], [pmId]);
    const whR = await WarehouseInventory.findByPk(whRmId);
    const whP = await WarehouseInventory.findByPk(whPmId);
    expect(Number(whR.reserved)).toBe(0);
    expect(Number(whP.reserved)).toBe(0);
  });
});

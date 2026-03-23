/**
 * Integration: recalculateInventoryForItem sums rack qty_wh and updates wh_stock, stock_in_hand.
 * applyDeltaToRack applies delta then recalculates.
 */
const db = require('../../db');
require('../../app');
const RawMaterial = require('../../src/rawMaterials/models');
const WarehouseInventory = require('../../src/warehouseInventory/models');
const { WarehouseLocation, WarehouseRack, WarehouseRackItem } = require('../../src/warehouseLocations/models');
const { recalculateInventoryForItem, applyDeltaToRack } = require('../../src/warehouseInventory/inventoryMath');
const { isDbAvailable } = require('../helpers/dbAvailability');

describe('warehouse rack and SIH', () => {
  let invId;
  let rackId;
  let dbAvailable = true;

  beforeAll(async () => {
    dbAvailable = await isDbAvailable(db);
    if (!dbAvailable) return;
    await db.sync({ force: true });
    const rm = await RawMaterial.create({ code: 'RM-RACK-001', name: 'Test RM', status: 'Active' });
    const loc = await WarehouseLocation.create({ code: 'LOC-1', name: 'Location 1', location_type: 'warehouse' });
    const rack = await WarehouseRack.create({ location_id: loc.id, code: 'R1', name: 'Rack 1', levels: 4, slots_total: 16 });
    rackId = rack.id;
    const inv = await WarehouseInventory.create({
      item_type: 'RM',
      raw_material_id: rm.id,
      pack_material_id: null,
      product_id: null,
      wh_stock: 0,
      ml1_stock: 0,
      ml2_stock: 0,
      stock_in_hand: 0,
      reserved: 0,
    });
    invId = inv.id;
  });

  afterAll(async () => {
    if (dbAvailable) await db.close();
  });

  test('recalculateInventoryForItem: sum rack qty_wh -> wh_stock, SIH = wh_stock + ml1 + ml2', async () => {
    if (!dbAvailable) return;
    await WarehouseRackItem.create({ rack_id: rackId, warehouse_inventory_id: invId, qty_wh: 10 });
    await WarehouseRackItem.create({ rack_id: rackId, warehouse_inventory_id: invId, qty_wh: 5 });
    const inv = await WarehouseInventory.findByPk(invId);
    await inv.update({ ml1_stock: 1, ml2_stock: 2 });
    const updated = await recalculateInventoryForItem(invId);
    expect(Number(updated.wh_stock)).toBe(15);
    expect(Number(updated.stock_in_hand)).toBe(15 + 1 + 2);
  });

  test('applyDeltaToRack adds delta and recalculates', async () => {
    if (!dbAvailable) return;
    const before = await WarehouseInventory.findByPk(invId);
    const beforeWh = Number(before.wh_stock);
    const { inventory } = await applyDeltaToRack(invId, rackId, 10);
    expect(inventory).toBeDefined();
    const rackItems = await WarehouseRackItem.findAll({ where: { warehouse_inventory_id: invId } });
    const total = rackItems.reduce((s, r) => s + Number(r.qty_wh), 0);
    expect(total).toBe(15 + 10);
    expect(Number(inventory.wh_stock)).toBe(25);
    expect(Number(inventory.stock_in_hand)).toBe(25 + 1 + 2);
  });
});

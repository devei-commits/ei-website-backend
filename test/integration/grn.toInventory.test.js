/**
 * Integration: applyGrnCompletionToInventory adds line qty to warehouse_inventory.wh_stock and recomputes stock_in_hand.
 */
const db = require('../../db');
require('../../app');
const RawMaterial = require('../../src/rawMaterials/models');
const WarehouseInventory = require('../../src/warehouseInventory/models');
const GoodsReceivedNote = require('../../src/grn/models');
const { applyGrnCompletionToInventory } = require('../../src/grn/controller');

describe('GRN to inventory', () => {
  let rmId;
  let whId;

  beforeAll(async () => {
    await db.sync({ force: true });
    const rm = await RawMaterial.create({ code: 'RM-GRN-001', name: 'Test RM', status: 'Active' });
    rmId = rm.id;
    const wh = await WarehouseInventory.create({
      item_type: 'RM',
      raw_material_id: rmId,
      pack_material_id: null,
      product_id: null,
      wh_stock: 50,
      ml1_stock: 0,
      ml2_stock: 0,
      stock_in_hand: 50,
      reserved: 0,
    });
    whId = wh.id;
  });

  afterAll(async () => {
    await db.close();
  });

  test('applyGrnCompletionToInventory adds rcvdQty to wh_stock and updates stock_in_hand', async () => {
    const grnRow = await GoodsReceivedNote.create({
      grn_no: 'GRN-TEST-001',
      status: 'GRN Complete',
      type: 'RM',
      line_items: [{ raw_material_id: rmId, rcvdQty: 100 }],
    });
    await applyGrnCompletionToInventory(grnRow);
    const wh = await WarehouseInventory.findByPk(whId);
    expect(Number(wh.wh_stock)).toBe(150);
    expect(Number(wh.stock_in_hand)).toBe(150);
  });
});

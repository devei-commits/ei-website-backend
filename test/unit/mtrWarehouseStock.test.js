const {
  aggregateMtrLineQuantities,
  qtyAvailableWh,
  qtyMtrFromReserved,
  validateOutboundMtrWarehouseStock,
} = require('../../src/mrn/mtrWarehouseStock');
const { materialQtyToNum } = require('../../src/utils/materialQtyCompare');

describe('mtrWarehouseStock', () => {
  it('qtyAvailableWh is wh_stock minus reserved floored at 0', () => {
    expect(qtyAvailableWh(100, 30)).toBe(70);
    expect(qtyAvailableWh(10, 25)).toBe(0);
  });

  it('qtyMtrFromReserved uses reserved capped by wh_stock', () => {
    expect(qtyMtrFromReserved(100, 80)).toBe(80);
    expect(qtyMtrFromReserved(50, 80)).toBe(50);
    expect(qtyMtrFromReserved(100, 0)).toBe(0);
  });

  it('qtyMtrFromReserved prefers batchReserved over warehouse reserved', () => {
    expect(qtyMtrFromReserved(100, 0, 40)).toBe(40);
    expect(qtyMtrFromReserved(30, 0, 40)).toBe(30);
    expect(qtyMtrFromReserved(100, 10, 0)).toBe(0);
  });

  it('aggregates duplicate RM lines', () => {
    const { rm } = aggregateMtrLineQuantities([
      { raw_material_id: 1, code: 'RM-001', quantity: 5 },
      { raw_material_id: 1, code: 'RM-001', quantity: 3 },
    ]);
    expect(materialQtyToNum(rm.get(1).qty)).toBe(8);
  });

  it('validateOutboundMtrWarehouseStock passes when request is within reserved pool', async () => {
    const WarehouseInventory = {
      findOne: jest.fn(async () => ({
        get: () => ({ wh_stock: 50, reserved: 40 }),
      })),
    };
    const result = await validateOutboundMtrWarehouseStock(WarehouseInventory, [
      { raw_material_id: 1, code: 'RM-001', quantity: 30, unit: 'KG' },
    ]);
    expect(result.ok).toBe(true);
  });

  it('validateOutboundMtrWarehouseStock fails when request exceeds reserved (even if free stock exists)', async () => {
    const WarehouseInventory = {
      findOne: jest.fn(async ({ where }) => {
        if (where.raw_material_id === 1) {
          return { get: () => ({ wh_stock: 50, reserved: 10 }) };
        }
        return null;
      }),
    };
    const result = await validateOutboundMtrWarehouseStock(WarehouseInventory, [
      { raw_material_id: 1, code: 'RM-001', quantity: 30, unit: 'KG' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Insufficient reserved stock/);
  });

  it('validateOutboundMtrWarehouseStock fails when reserved covers request but WH stock is lower', async () => {
    const WarehouseInventory = {
      findOne: jest.fn(async () => ({
        get: () => ({ wh_stock: 10, reserved: 40 }),
      })),
    };
    const result = await validateOutboundMtrWarehouseStock(WarehouseInventory, [
      { pack_material_id: 2, code: 'PM-001', quantity: 25, unit: 'PCS' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.details[0].available).toBe(10);
  });
});

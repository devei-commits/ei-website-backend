const {
  aggregateMtrLineQuantities,
  qtyAvailableWh,
  validateOutboundMtrWarehouseStock,
} = require('../../src/mrn/mtrWarehouseStock');

describe('mtrWarehouseStock', () => {
  it('qtyAvailableWh is wh_stock minus reserved floored at 0', () => {
    expect(qtyAvailableWh(100, 30)).toBe(70);
    expect(qtyAvailableWh(10, 25)).toBe(0);
  });

  it('aggregates duplicate RM lines', () => {
    const { rm } = aggregateMtrLineQuantities([
      { raw_material_id: 1, code: 'RM-001', quantity: 5 },
      { raw_material_id: 1, code: 'RM-001', quantity: 3 },
    ]);
    expect(rm.get(1).qty).toBe(8);
  });

  it('validateOutboundMtrWarehouseStock fails when requested exceeds WH available', async () => {
    const WarehouseInventory = {
      findOne: jest.fn(async ({ where }) => {
        if (where.raw_material_id === 1) {
          return { get: () => ({ wh_stock: 10, reserved: 4 }) };
        }
        return null;
      }),
    };
    const result = await validateOutboundMtrWarehouseStock(WarehouseInventory, [
      { raw_material_id: 1, code: 'RM-001', quantity: 10, unit: 'KG' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Insufficient warehouse stock/);
  });

  it('validateOutboundMtrWarehouseStock passes when stock covers request', async () => {
    const WarehouseInventory = {
      findOne: jest.fn(async () => ({
        get: () => ({ wh_stock: 50, reserved: 10 }),
      })),
    };
    const result = await validateOutboundMtrWarehouseStock(WarehouseInventory, [
      { pack_material_id: 2, code: 'PM-001', quantity: 30, unit: 'PCS' },
    ]);
    expect(result.ok).toBe(true);
  });
});

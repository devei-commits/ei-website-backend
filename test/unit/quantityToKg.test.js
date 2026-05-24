const { quantityToKg, gramsPerPieceFromSizeSpec } = require('../../src/warehouseInventory/quantityToKg');

describe('quantityToKg', () => {
  test('kg passthrough', () => {
    expect(quantityToKg(10, 'KG', { itemType: 'RM' })).toBe(10);
    expect(quantityToKg(10, 'kgs', { itemType: 'RM' })).toBe(10);
  });

  test('grams to kg', () => {
    expect(quantityToKg(500, 'G', { itemType: 'RM' })).toBe(0.5);
    expect(quantityToKg(1000, 'GM', { itemType: 'RM' })).toBe(1);
  });

  test('PM pcs with size_spec grams', () => {
    expect(quantityToKg(100, 'PCS', { itemType: 'PM', sizeSpec: '50g / tube' })).toBe(5);
    expect(gramsPerPieceFromSizeSpec('150ml')).toBeNull();
  });

  test('RM empty unit defaults to kg scale', () => {
    expect(quantityToKg(20, '', { itemType: 'RM', masterUom: '' })).toBe(20);
  });

  test('litres to kg via specific gravity', () => {
    expect(quantityToKg(10, 'L', { itemType: 'RM', specificGravity: 1.2 })).toBeCloseTo(12, 6);
    expect(quantityToKg(1000, 'ML', { itemType: 'RM', specificGravity: 1.0 })).toBeCloseTo(1, 6);
  });
});

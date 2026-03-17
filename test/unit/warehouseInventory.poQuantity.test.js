/**
 * Unit tests for PO quantity by item: sum of line quantities by rm-{id} / pm-{id} key.
 */
const { sumPoQuantityByItem } = require('../../src/lib/poQuantity');

describe('sumPoQuantityByItem', () => {
  test('aggregates by raw_material_id', () => {
    const items = [
      { raw_material_id: 1, quantity: 100 },
      { raw_material_id: 1, quantity: 50 },
      { raw_material_id: 2, quantity: 200 },
    ];
    const map = sumPoQuantityByItem(items);
    expect(map.get('rm-1')).toBe(150);
    expect(map.get('rm-2')).toBe(200);
  });

  test('aggregates by pack_material_id', () => {
    const items = [
      { pack_material_id: 10, qty: 30 },
      { pack_material_id: 10, poQty: 20 },
    ];
    const map = sumPoQuantityByItem(items);
    expect(map.get('pm-10')).toBe(50);
  });

  test('skips zero or negative qty', () => {
    const items = [
      { raw_material_id: 1, quantity: 10 },
      { raw_material_id: 1, quantity: 0 },
    ];
    const map = sumPoQuantityByItem(items);
    expect(map.get('rm-1')).toBe(10);
  });

  test('skips lines without rm or pm id', () => {
    const items = [
      { raw_material_id: 1, quantity: 10 },
      { quantity: 99 },
    ];
    const map = sumPoQuantityByItem(items);
    expect(map.get('rm-1')).toBe(10);
    expect(map.size).toBe(1);
  });

  test('empty input returns empty map', () => {
    expect(sumPoQuantityByItem([]).size).toBe(0);
    expect(sumPoQuantityByItem(null).size).toBe(0);
  });

  test('mixed rm and pm in same list', () => {
    const items = [
      { raw_material_id: 1, quantity: 10 },
      { pack_material_id: 2, quantity: 20 },
    ];
    const map = sumPoQuantityByItem(items);
    expect(map.get('rm-1')).toBe(10);
    expect(map.get('pm-2')).toBe(20);
    expect(map.size).toBe(2);
  });

  test('negative quantity skipped', () => {
    const items = [{ raw_material_id: 1, quantity: -5 }];
    const map = sumPoQuantityByItem(items);
    expect(map.has('rm-1')).toBe(false);
  });

  test('non-array input treated as empty', () => {
    expect(sumPoQuantityByItem(undefined).size).toBe(0);
  });
});

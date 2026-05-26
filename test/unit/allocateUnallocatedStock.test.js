const {
  rackMatchesBucket,
} = require('../../src/warehouseInventory/allocateUnallocatedStock');

describe('allocateUnallocatedStock', () => {
  test('rackMatchesBucket warehouse vs production ML buckets', () => {
    expect(rackMatchesBucket({ location_type: 'warehouse' }, 'warehouse')).toBe(true);
    expect(rackMatchesBucket({ location_type: 'warehouse' }, 'ml1')).toBe(false);
    expect(
      rackMatchesBucket(
        { location_type: 'production', code: 'LOC-ML1', name: 'ML1 Store' },
        'ml1'
      )
    ).toBe(true);
    expect(
      rackMatchesBucket(
        { location_type: 'production', code: 'LOC-ML2', name: 'ML2 Store' },
        'ml2'
      )
    ).toBe(true);
    expect(
      rackMatchesBucket(
        { location_type: 'production', code: 'LOC-ML1', name: 'ML1 Store' },
        'ml2'
      )
    ).toBe(false);
  });
});

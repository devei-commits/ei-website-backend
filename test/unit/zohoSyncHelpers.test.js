const { isZohoDuplicateItemError } = require('../../src/services/zohoSyncHelpers');

describe('zohoSyncHelpers', () => {
  test('isZohoDuplicateItemError detects already exists', () => {
    const err = new Error('The SKU already exists.');
    err.zohoRaw = { message: 'Item with this SKU already exists' };
    expect(isZohoDuplicateItemError(err)).toBe(true);
  });

  test('isZohoDuplicateItemError false for generic failure', () => {
    const err = new Error('Invalid tax id');
    err.zohoRaw = { code: 400, message: 'Invalid tax id' };
    expect(isZohoDuplicateItemError(err)).toBe(false);
  });
});

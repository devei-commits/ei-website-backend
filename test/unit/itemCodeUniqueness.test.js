const { identifiersFromCodeAndSku } = require('../../src/lib/itemCodeUniqueness');

describe('identifiersFromCodeAndSku', () => {
  test('returns only code when sku is empty or matches code (case-insensitive)', () => {
    expect(identifiersFromCodeAndSku('RM-001', null)).toEqual(['RM-001']);
    expect(identifiersFromCodeAndSku('RM-001', '')).toEqual(['RM-001']);
    expect(identifiersFromCodeAndSku('RM-001', 'rm-001')).toEqual(['RM-001']);
  });

  test('returns code and sku when both are distinct', () => {
    expect(identifiersFromCodeAndSku('RM-001', 'ALT-SKU')).toEqual(['RM-001', 'ALT-SKU']);
  });

  test('trims whitespace', () => {
    expect(identifiersFromCodeAndSku('  X  ', '  Y  ')).toEqual(['X', 'Y']);
  });
});

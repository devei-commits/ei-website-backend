const {
  parseMasterProductsFromPayload,
  parseAssociateItemsText,
} = require('../../src/lib/parseMasterProductsFromPayload');

describe('parseMasterProductsFromPayload', () => {
  test('returns explicit products array from body', () => {
    expect(parseMasterProductsFromPayload({ products: ['EI-PR-00001', 'PR-002'] })).toEqual([
      'EI-PR-00001',
      'PR-002',
    ]);
  });

  test('parses rmAssociateItems newline text', () => {
    expect(
      parseMasterProductsFromPayload({
        rmAssociateItems: 'EI-PR-00001\nPR-002',
      })
    ).toEqual(['EI-PR-00001', 'PR-002']);
  });

  test('preserveWhenUnset returns undefined when products omitted', () => {
    expect(
      parseMasterProductsFromPayload({ inciName: 'Glycerin' }, { preserveWhenUnset: true })
    ).toBeUndefined();
  });

  test('defaults to empty array on create when unset', () => {
    expect(parseMasterProductsFromPayload({ inciName: 'Glycerin' })).toEqual([]);
  });

  test('reads products from nested form_data', () => {
    expect(
      parseMasterProductsFromPayload({
        form_data: { products: ['SKU-A'] },
      })
    ).toEqual(['SKU-A']);
  });
});

describe('parseAssociateItemsText', () => {
  test('splits on commas and semicolons', () => {
    expect(parseAssociateItemsText('A, B; C')).toEqual(['A', 'B', 'C']);
  });
});

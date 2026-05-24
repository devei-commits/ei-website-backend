const { parseMoqQuantity, moqValuesEqual } = require('../../src/lib/moqQuantity');

describe('moqQuantity', () => {
  it('parses decimal MOQ values', () => {
    expect(parseMoqQuantity('0.5')).toBe(0.5);
    expect(parseMoqQuantity('25.25')).toBe(25.25);
    expect(parseMoqQuantity(1)).toBe(1);
  });

  it('compares MOQ with tolerance', () => {
    expect(moqValuesEqual(0.5, '0.5')).toBe(true);
    expect(moqValuesEqual(1, 1.0001)).toBe(false);
  });
});

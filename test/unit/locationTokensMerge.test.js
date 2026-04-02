const { mergeLocationTokens, parseLocationTokens } = require('../../src/warehouseInventory/locationTokensMerge');

describe('locationTokensMerge', () => {
  it('merges new rack without duplicating', () => {
    expect(mergeLocationTokens('A1-L2-S3', 'B2-L1-S1')).toBe('A1-L2-S3 · B2-L1-S1');
    expect(mergeLocationTokens('A1-L2-S3 · B2-L1-S1', 'A1-L2-S3')).toBe('A1-L2-S3 · B2-L1-S1');
  });

  it('dedupes case-insensitively', () => {
    expect(mergeLocationTokens('Zone A', 'zone a')).toBe('Zone A');
  });

  it('parses comma and middle-dot lists', () => {
    expect(parseLocationTokens('X · Y, Z')).toEqual(['X', 'Y', 'Z']);
  });
});

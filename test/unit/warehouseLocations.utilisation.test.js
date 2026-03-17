/**
 * Unit tests for warehouse rack utilisation.
 */
const { computeTotalSlots, computeRackUtilisationPct } = require('../../src/lib/warehouseUtilisation');

describe('computeTotalSlots', () => {
  test('totalSlots = levels * slots_total', () => {
    expect(computeTotalSlots(4, 16)).toBe(64);
  });
});

describe('computeRackUtilisationPct', () => {
  test('utilisationPct = round((storedCount / totalSlots) * 100)', () => {
    expect(computeRackUtilisationPct(4, 16, 32)).toBe(50);
    expect(computeRackUtilisationPct(4, 16, 64)).toBe(100);
    expect(computeRackUtilisationPct(4, 16, 0)).toBe(0);
  });

  test('levels/slotsTotal 0 use defaults so totalSlots 64', () => {
    expect(computeRackUtilisationPct(0, 0, 10)).toBe(16);
  });

  test('computeTotalSlots: null/undefined use defaults 4 and 16', () => {
    expect(computeTotalSlots(null, null)).toBe(64);
  });

  test('negative storedCount yields negative utilisation (current behavior)', () => {
    expect(computeRackUtilisationPct(4, 16, -5)).toBe(-8);
  });
});

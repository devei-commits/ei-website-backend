const { pickTierForQty } = require('../../../src/itemsList/resolveClientProductPrice');

describe('pickTierForQty', () => {
  const tiers = [
    { id: 1, moq_min: 1, moq_max: 99, price_per_unit: 10 },
    { id: 2, moq_min: 100, moq_max: 499, price_per_unit: 9 },
    { id: 3, moq_min: 500, moq_max: null, price_per_unit: 8 },
  ];

  it('picks the highest matching tier for quantity', () => {
    expect(pickTierForQty(tiers, 50)?.id).toBe(1);
    expect(pickTierForQty(tiers, 100)?.id).toBe(2);
    expect(pickTierForQty(tiers, 499)?.id).toBe(2);
    expect(pickTierForQty(tiers, 500)?.id).toBe(3);
    expect(pickTierForQty(tiers, 2000)?.id).toBe(3);
  });

  it('defaults quantity to at least 1', () => {
    expect(pickTierForQty(tiers, 0)?.id).toBe(1);
  });
});

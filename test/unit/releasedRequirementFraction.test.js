/**
 * Items Involved is a batch-driven view, so its requirement must follow what has been RELEASED.
 *
 * Regression: a 200 KG order with one released 100 kg batch reported 1,000 pcs of bottle and
 * 110.86 kg of Aqua, while the Release-to-Planning split for that same batch showed 55.43 kg.
 */
const { releasedRequirementFraction } = require('../../src/planningExtracted/controller');

const b = (size_kg) => ({ size_kg });

describe('releasedRequirementFraction', () => {
  it('halves the requirement when one of two 100 kg batches is released from a 200 KG order', () => {
    const f = releasedRequirementFraction({ total_kg_display: '200 KG' }, [b(100)]);
    expect(f).toBe(0.5);
    expect(1000 * f).toBe(500);          // 200ML HDPE BOTTLE
    expect(Number((110.86 * f).toFixed(2))).toBe(55.43); // Aqua, matches the batch split
  });

  it('is 1 when every batch is released', () => {
    expect(releasedRequirementFraction({ total_kg_display: '200 KG' }, [b(100), b(100)])).toBe(1);
  });

  it('falls back to the full order when nothing is released yet', () => {
    expect(releasedRequirementFraction({ total_kg_display: '200 KG' }, [])).toBe(1);
    expect(releasedRequirementFraction({ total_kg_display: '200 KG' }, null)).toBe(1);
  });

  it('falls back to the full order when the order total is unknown', () => {
    expect(releasedRequirementFraction({ total_kg_display: null }, [b(100)])).toBe(1);
    expect(releasedRequirementFraction({}, [b(100)])).toBe(1);
    expect(releasedRequirementFraction({ total_kg_display: '0 KG' }, [b(100)])).toBe(1);
  });

  it('falls back rather than zeroing the requirement when sent batches carry no size', () => {
    expect(releasedRequirementFraction({ total_kg_display: '200 KG' }, [b(null), b(0)])).toBe(1);
  });

  it('goes above 1 for buffer batches — over-production really does consume more material', () => {
    expect(releasedRequirementFraction({ total_kg_display: '200 KG' }, [b(200), b(50)])).toBe(1.25);
  });

  it('handles decimal order totals', () => {
    expect(releasedRequirementFraction({ total_kg_display: '170.96 KG' }, [b(85.48)])).toBe(0.5);
  });

  it('reads a numeric total_kg_display', () => {
    expect(releasedRequirementFraction({ total_kg_display: 200 }, [b(50)])).toBe(0.25);
  });
});

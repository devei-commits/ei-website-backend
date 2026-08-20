/**
 * Guards that keep a batch plan honest:
 *  - a batch already sent to production keeps the size its BMR was cut for;
 *  - the plan as a whole never allocates more kg than the order, buffer batches excepted.
 *
 * Regression: a 200 KG order ended up with two 200 kg batches (400 kg planned), and the already
 * released 100 kg batch had been resized to 200 kg under a live BMR.
 */
const {
  assertSentBatchSizesUnchanged,
  assertBatchPlanWithinOrder,
  parseTotalKgDisplay,
} = require('../../src/planningExtracted/planningBatchEditLock');

const row = (id, sequence, size_kg, batch_code) => ({ id, sequence, size_kg, batch_code });

function thrown(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

describe('parseTotalKgDisplay', () => {
  it('reads the number out of a display string', () => {
    expect(parseTotalKgDisplay('200 KG')).toBe(200);
    expect(parseTotalKgDisplay('1.544 KG')).toBe(1.544);
    expect(parseTotalKgDisplay(200)).toBe(200);
  });

  it('returns 0 when the total is unknown', () => {
    expect(parseTotalKgDisplay(null)).toBe(0);
    expect(parseTotalKgDisplay('')).toBe(0);
    expect(parseTotalKgDisplay('KG')).toBe(0);
  });
});

describe('assertSentBatchSizesUnchanged', () => {
  const existing = [row(573, 1, '100.00', 'PE-3562-B1'), row(576, 2, '100.00', 'PE-3562-B2')];

  it('rejects resizing a batch that is already sent to production', () => {
    const err = thrown(() =>
      assertSentBatchSizesUnchanged([{ sizeKg: 200 }, { sizeKg: 200 }], existing, [0])
    );
    expect(err).toBeTruthy();
    expect(err.code).toBe('SENT_BATCH_SIZE_LOCKED');
    expect(err.status).toBe(409);
    expect(err.message).toContain('PE-3562-B1');
  });

  it('allows resizing a batch that has not been sent', () => {
    expect(() =>
      assertSentBatchSizesUnchanged([{ sizeKg: 100 }, { sizeKg: 60 }], existing, [0])
    ).not.toThrow();
  });

  it('accepts an unchanged size on a sent batch (idempotent re-save)', () => {
    expect(() =>
      assertSentBatchSizesUnchanged([{ sizeKg: 100 }, { sizeKg: 100 }], existing, [0])
    ).not.toThrow();
  });

  it('tolerates NUMERIC round-trip noise rather than failing on exact equality', () => {
    expect(() =>
      assertSentBatchSizesUnchanged([{ sizeKg: 100.0000001 }], existing, [0])
    ).not.toThrow();
  });

  it('reads snake_case payloads too', () => {
    const err = thrown(() => assertSentBatchSizesUnchanged([{ size_kg: 250 }], existing, [0]));
    expect(err.code).toBe('SENT_BATCH_SIZE_LOCKED');
  });

  it('does nothing when no batch has been sent', () => {
    expect(() =>
      assertSentBatchSizesUnchanged([{ sizeKg: 999 }, { sizeKg: 999 }], existing, [])
    ).not.toThrow();
  });

  it('reads Sequelize instances via get()', () => {
    const inst = { get: (k) => ({ size_kg: '100.00', batch_code: 'PE-3562-B1' }[k]) };
    const err = thrown(() => assertSentBatchSizesUnchanged([{ sizeKg: 200 }], [inst], [0]));
    expect(err.code).toBe('SENT_BATCH_SIZE_LOCKED');
  });

  it('ignores a payload entry that omits the size (partial save)', () => {
    expect(() => assertSentBatchSizesUnchanged([{}], existing, [0])).not.toThrow();
  });
});

describe('assertBatchPlanWithinOrder', () => {
  it('rejects the regression: two 200 kg batches against a 200 KG order', () => {
    const err = thrown(() =>
      assertBatchPlanWithinOrder([{ sizeKg: 200 }, { sizeKg: 200 }], '200 KG', [])
    );
    expect(err).toBeTruthy();
    expect(err.code).toBe('BATCH_PLAN_EXCEEDS_ORDER');
    expect(err.status).toBe(400);
    expect(err.plannedKg).toBe(400);
    expect(err.orderKg).toBe(200);
  });

  it('allows a plan that exactly fills the order', () => {
    expect(() =>
      assertBatchPlanWithinOrder([{ sizeKg: 100 }, { sizeKg: 100 }], '200 KG', [])
    ).not.toThrow();
  });

  it('allows a partially planned order', () => {
    expect(() => assertBatchPlanWithinOrder([{ sizeKg: 100 }], '200 KG', [])).not.toThrow();
  });

  it('exempts buffer batches, which are deliberate over-production', () => {
    expect(() =>
      assertBatchPlanWithinOrder([{ sizeKg: 200 }, { sizeKg: 50 }], '200 KG', [1])
    ).not.toThrow();
  });

  it('still caps the non-buffer batches when a buffer batch exists', () => {
    const err = thrown(() =>
      assertBatchPlanWithinOrder([{ sizeKg: 200 }, { sizeKg: 200 }, { sizeKg: 50 }], '200 KG', [2])
    );
    expect(err.code).toBe('BATCH_PLAN_EXCEEDS_ORDER');
    expect(err.plannedKg).toBe(400);
  });

  it('skips the check when the order total is unknown', () => {
    expect(() => assertBatchPlanWithinOrder([{ sizeKg: 9999 }], null, [])).not.toThrow();
    expect(() => assertBatchPlanWithinOrder([{ sizeKg: 9999 }], '0 KG', [])).not.toThrow();
  });

  it('does not trip on floating-point sums that only just reach the total', () => {
    expect(() =>
      assertBatchPlanWithinOrder([{ sizeKg: 0.1 }, { sizeKg: 0.2 }], '0.3 KG', [])
    ).not.toThrow();
  });

  it('ignores null and negative sizes instead of counting them', () => {
    expect(() =>
      assertBatchPlanWithinOrder([{ sizeKg: 200 }, { sizeKg: null }, { sizeKg: -50 }], '200 KG', [])
    ).not.toThrow();
  });
});

/**
 * Unit tests for the pure core of the Treasury cashflow-gate engine.
 * No DB — exercises projectDaily / lowestPoint / verdictFor / summarize only.
 */
const {
  projectDaily,
  lowestPoint,
  verdictFor,
  daysBelowThreshold,
  summarize,
  addDays,
  dayKey,
} = require('../../src/treasury/cashflowGate');

const CONFIG = { threshold: 1_000_000, tightBuffer: 500_000, horizonDays: 30 };
const ASOF = '2026-07-08';

describe('date helpers', () => {
  test('dayKey normalizes Date and ISO to YYYY-MM-DD', () => {
    expect(dayKey('2026-07-08T12:34:56.000Z')).toBe('2026-07-08');
    expect(dayKey(new Date('2026-07-08T00:00:00Z'))).toBe('2026-07-08');
    expect(dayKey(null)).toBeNull();
  });
  test('addDays is UTC-safe across month boundary', () => {
    expect(addDays('2026-07-30', 3)).toBe('2026-08-02');
  });
});

describe('projectDaily', () => {
  test('runs a daily closing balance and counts', () => {
    const { days } = projectDaily(
      2_000_000,
      [
        { date: '2026-07-08', amount: 500_000, kind: 'inflow' },
        { date: '2026-07-09', amount: 300_000, kind: 'outflow' },
      ],
      { asOf: ASOF, horizonDays: 3 }
    );
    expect(days).toHaveLength(3);
    expect(days[0]).toMatchObject({ date: '2026-07-08', inflow: 500_000, closingBalance: 2_500_000, inflowCount: 1 });
    expect(days[1]).toMatchObject({ date: '2026-07-09', outflow: 300_000, closingBalance: 2_200_000, outflowCount: 1 });
    expect(days[2].closingBalance).toBe(2_200_000);
  });

  test('overdue movements (before asOf) collapse onto day 0', () => {
    const { days } = projectDaily(
      1_000_000,
      [{ date: '2026-07-01', amount: 400_000, kind: 'inflow' }],
      { asOf: ASOF, horizonDays: 2 }
    );
    expect(days[0].closingBalance).toBe(1_400_000);
    expect(days[0].inflowCount).toBe(1);
  });

  test('movements beyond the horizon are ignored', () => {
    const { days } = projectDaily(
      1_000_000,
      [{ date: '2026-09-01', amount: 999_000, kind: 'outflow' }],
      { asOf: ASOF, horizonDays: 5 }
    );
    expect(days.every((d) => d.outflow === 0)).toBe(true);
  });
});

describe('verdictFor', () => {
  test('over below threshold, tight within buffer, safe above', () => {
    expect(verdictFor(900_000, CONFIG)).toBe('over');
    expect(verdictFor(1_200_000, CONFIG)).toBe('tight');
    expect(verdictFor(2_000_000, CONFIG)).toBe('safe');
    // boundaries
    expect(verdictFor(1_000_000, CONFIG)).toBe('tight'); // exactly at floor is not "over"
    expect(verdictFor(1_500_000, CONFIG)).toBe('safe'); // exactly floor+buffer is safe
  });
});

describe('lowestPoint & summarize', () => {
  const movements = [
    { date: '2026-07-10', amount: 1_600_000, kind: 'outflow' }, // dip day
    { date: '2026-07-12', amount: 800_000, kind: 'inflow' },
  ];

  test('finds the floor and its date', () => {
    const { days } = projectDaily(2_000_000, movements, { asOf: ASOF, horizonDays: 7 });
    const low = lowestPoint(2_000_000, days);
    expect(low.amount).toBe(400_000);
    expect(low.date).toBe('2026-07-10');
  });

  test('summarize yields an "over" verdict when the floor breaches the gate', () => {
    const { days } = projectDaily(2_000_000, movements, { asOf: ASOF, horizonDays: 7 });
    const s = summarize(2_000_000, days, CONFIG);
    expect(s.lowest.amount).toBe(400_000);
    expect(s.verdict).toBe('over');
    expect(s.daysBelowThreshold).toBeGreaterThanOrEqual(1);
    expect(daysBelowThreshold(days, CONFIG.threshold)).toBe(s.daysBelowThreshold);
  });
});

describe('before/after reschedule delta (pure)', () => {
  test('moving an inflow later lowers the interim floor', () => {
    const asOf = ASOF;
    const base = [{ date: '2026-07-15', amount: 2_000_000, kind: 'outflow' }];
    const inflow = 1_500_000;

    const before = projectDaily(1_000_000, [...base, { date: '2026-07-14', amount: inflow, kind: 'inflow' }], { asOf, horizonDays: 20 });
    const after = projectDaily(1_000_000, [...base, { date: '2026-07-25', amount: inflow, kind: 'inflow' }], { asOf, horizonDays: 20 });

    const lowBefore = lowestPoint(1_000_000, before.days).amount;
    const lowAfter = lowestPoint(1_000_000, after.days).amount;
    expect(lowAfter).toBeLessThan(lowBefore); // delaying the inflow makes the trough deeper
  });
});

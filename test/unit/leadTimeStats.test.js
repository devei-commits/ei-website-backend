'use strict';

const {
  computeLeadTimeStat,
  percentile,
  winsorize,
  MS_PER_DAY,
} = require('../../src/lib/leadTimeStats');

const NOW = 1_700_000_000_000; // fixed deterministic clock
const daysAgo = (d) => NOW - d * MS_PER_DAY;

describe('percentile', () => {
  it('interpolates linearly', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
    expect(percentile([10], 90)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('winsorize', () => {
  it('clamps extreme values to p10/p90 bounds', () => {
    const vals = [1, 10, 10, 10, 10, 10, 10, 10, 10, 100];
    const w = winsorize(vals);
    expect(Math.max(...w)).toBeLessThan(100);
    expect(Math.min(...w)).toBeGreaterThan(1);
  });
  it('no-ops for tiny samples', () => {
    expect(winsorize([1, 100])).toEqual([1, 100]);
  });
});

describe('computeLeadTimeStat (§10)', () => {
  it('averages actual lead over the 6-month window', () => {
    const samples = [
      { leadDays: 10, completedAtMs: daysAgo(20) },
      { leadDays: 12, completedAtMs: daysAgo(40) },
      { leadDays: 14, completedAtMs: daysAgo(60) },
    ];
    const stat = computeLeadTimeStat(samples, { priceListLeadDays: 30, nowMs: NOW });
    expect(stat.source).toBe('history');
    expect(stat.usingQuoted).toBe(false);
    expect(stat.avgActualDays).toBe(12);
    expect(stat.sampleSize).toBe(3);
  });

  it('extends to 12 months when < 3 in the 6-month window', () => {
    const samples = [
      { leadDays: 10, completedAtMs: daysAgo(200) },
      { leadDays: 20, completedAtMs: daysAgo(250) },
      { leadDays: 30, completedAtMs: daysAgo(300) },
    ];
    const stat = computeLeadTimeStat(samples, { priceListLeadDays: 30, nowMs: NOW });
    expect(stat.source).toBe('history-12m');
    expect(stat.avgActualDays).toBe(20);
    expect(stat.badge).toContain('12mo');
  });

  it('falls back to price-list with "limited history" when < 3 samples in 12mo', () => {
    const samples = [
      { leadDays: 10, completedAtMs: daysAgo(30) },
      { leadDays: 12, completedAtMs: daysAgo(60) },
    ];
    const stat = computeLeadTimeStat(samples, { priceListLeadDays: 45, nowMs: NOW });
    expect(stat.usingQuoted).toBe(true);
    expect(stat.source).toBe('limited');
    expect(stat.avgActualDays).toBe(45);
    expect(stat.badge).toBe('limited history');
    expect(stat.sampleSize).toBe(2);
  });

  it('falls back to price-list with "no history" when there are zero samples', () => {
    const stat = computeLeadTimeStat([], { priceListLeadDays: 60, nowMs: NOW });
    expect(stat.source).toBe('no-history');
    expect(stat.avgActualDays).toBe(60);
    expect(stat.badge).toContain('no history');
    expect(stat.sampleSize).toBe(0);
  });

  it('detects an upward trend (> +20%) over last 3 vs prior 3', () => {
    // prior 3 avg = 10, last 3 avg = 20 → +100% → trendUp
    const samples = [
      { leadDays: 10, completedAtMs: daysAgo(60) },
      { leadDays: 10, completedAtMs: daysAgo(55) },
      { leadDays: 10, completedAtMs: daysAgo(50) },
      { leadDays: 20, completedAtMs: daysAgo(20) },
      { leadDays: 20, completedAtMs: daysAgo(15) },
      { leadDays: 20, completedAtMs: daysAgo(10) },
    ];
    const stat = computeLeadTimeStat(samples, { priceListLeadDays: 30, nowMs: NOW });
    expect(stat.trendUp).toBe(true);
    expect(stat.trendPct).toBeGreaterThan(20);
  });

  it('does not flag trend for a < +20% rise', () => {
    const samples = [
      { leadDays: 10, completedAtMs: daysAgo(60) },
      { leadDays: 10, completedAtMs: daysAgo(55) },
      { leadDays: 10, completedAtMs: daysAgo(50) },
      { leadDays: 11, completedAtMs: daysAgo(20) },
      { leadDays: 11, completedAtMs: daysAgo(15) },
      { leadDays: 11, completedAtMs: daysAgo(10) },
    ];
    const stat = computeLeadTimeStat(samples, { priceListLeadDays: 30, nowMs: NOW });
    expect(stat.trendUp).toBe(false);
  });

  it('winsorizes outliers before averaging', () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({
      leadDays: i === 9 ? 500 : 10, // one wild outlier
      completedAtMs: daysAgo(i * 5 + 1),
    }));
    const stat = computeLeadTimeStat(samples, { priceListLeadDays: 30, nowMs: NOW });
    // Without winsorizing the mean would be ~59; clamped it stays near 10.
    expect(stat.avgActualDays).toBeLessThan(20);
  });

  it('ignores negative / non-finite lead values', () => {
    const samples = [
      { leadDays: -5, completedAtMs: daysAgo(10) },
      { leadDays: Number.NaN, completedAtMs: daysAgo(12) },
      { leadDays: 10, completedAtMs: daysAgo(14) },
      { leadDays: 10, completedAtMs: daysAgo(16) },
      { leadDays: 10, completedAtMs: daysAgo(18) },
    ];
    const stat = computeLeadTimeStat(samples, { priceListLeadDays: 30, nowMs: NOW });
    expect(stat.sampleSize).toBe(3);
    expect(stat.avgActualDays).toBe(10);
  });
});

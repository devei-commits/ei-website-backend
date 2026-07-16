'use strict';

/**
 * Lead-time engine (spec §10) — Avg ACTUAL lead time from purchase history, NOT the price-list
 * (quoted) field. A sample = (GRN-completed date − PO-issued date) in days for one completed GRN,
 * scoped to a single (item, vendor) pair.
 *
 * Rules implemented (§10.1 / §10.2):
 *  - Prefer the last 6 months; if < 3 samples, extend to 12 months.
 *  - If still < 3 samples → fall back to the price-list value with a "limited history" badge.
 *  - Zero samples ever → price-list value with "no history — using quoted" badge.
 *  - Winsorize (clamp to p10/p90) before averaging to blunt outliers.
 *  - Trend: mean(last 3) vs mean(prior 3); > +20% → trendUp (↑ amber).
 *  - Expose p50, p90, sample_size for the §10.4 stats cache.
 *
 * Pure + deterministic: callers pass `nowMs` so there is no hidden clock dependency.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WINDOW_6M_DAYS = 180;
const WINDOW_12M_DAYS = 365;
const MIN_SAMPLES = 3;
const TREND_MIN_SAMPLES = 6;
const TREND_THRESHOLD = 1.2; // +20%

/** Linear-interpolated percentile over an ascending-sorted array. */
function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/** Clamp values outside [p10, p90] to those bounds (winsorize). No-op for tiny samples. */
function winsorize(values) {
  if (values.length < 5) return values.slice();
  const sorted = [...values].sort((a, b) => a - b);
  const lo = percentile(sorted, 10);
  const hi = percentile(sorted, 90);
  return values.map((v) => Math.min(Math.max(v, lo), hi));
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

/**
 * @param {Array<{leadDays:number, completedAtMs:number}>} samples - completed-GRN lead samples for one (item, vendor), any age
 * @param {{ priceListLeadDays?: number|null, nowMs: number }} opts
 * @returns {{
 *   avgActualDays: number|null, p50: number|null, p90: number|null,
 *   trendPct: number, trendUp: boolean, sampleSize: number,
 *   source: 'history'|'history-12m'|'limited'|'no-history', badge: string, usingQuoted: boolean
 * }}
 */
function computeLeadTimeStat(samples, opts) {
  const nowMs = Number(opts && opts.nowMs) || 0;
  const priceList =
    opts && opts.priceListLeadDays != null && Number.isFinite(Number(opts.priceListLeadDays))
      ? Number(opts.priceListLeadDays)
      : null;

  const valid = (samples || [])
    .filter((s) => s && Number.isFinite(Number(s.leadDays)) && Number(s.leadDays) >= 0)
    .map((s) => ({ leadDays: Number(s.leadDays), completedAtMs: Number(s.completedAtMs) || 0 }))
    .sort((a, b) => a.completedAtMs - b.completedAtMs); // oldest → newest

  const inWindow = (days) => valid.filter((s) => nowMs - s.completedAtMs <= days * MS_PER_DAY);

  let chosen = inWindow(WINDOW_6M_DAYS);
  let windowLabel = '6m';
  if (chosen.length < MIN_SAMPLES) {
    const twelve = inWindow(WINDOW_12M_DAYS);
    if (twelve.length >= MIN_SAMPLES) {
      chosen = twelve;
      windowLabel = '12m';
    } else {
      // Not enough recent history — fall back to the quoted price-list value.
      const noHistory = valid.length === 0;
      return {
        avgActualDays: priceList,
        p50: priceList,
        p90: priceList,
        trendPct: 0,
        trendUp: false,
        sampleSize: valid.length,
        source: noHistory ? 'no-history' : 'limited',
        badge: noHistory ? 'no history — using quoted' : 'limited history',
        usingQuoted: true,
      };
    }
  }

  const leadValues = chosen.map((s) => s.leadDays);
  const wins = winsorize(leadValues);
  const avg = round1(mean(wins));
  const sortedWins = [...wins].sort((a, b) => a - b);
  const p50 = round1(percentile(sortedWins, 50));
  const p90 = round1(percentile(sortedWins, 90));

  let trendPct = 0;
  let trendUp = false;
  if (chosen.length >= TREND_MIN_SAMPLES) {
    const last3 = mean(chosen.slice(-3).map((s) => s.leadDays));
    const prior3 = mean(chosen.slice(-6, -3).map((s) => s.leadDays));
    if (prior3 > 0) {
      trendPct = round1(((last3 - prior3) / prior3) * 100);
      trendUp = last3 > prior3 * TREND_THRESHOLD;
    }
  }

  return {
    avgActualDays: avg,
    p50,
    p90,
    trendPct,
    trendUp,
    sampleSize: chosen.length,
    source: windowLabel === '12m' ? 'history-12m' : 'history',
    badge: windowLabel === '12m' ? 'actual (12mo)' : 'actual',
    usingQuoted: false,
  };
}

module.exports = {
  computeLeadTimeStat,
  percentile,
  winsorize,
  mean,
  MS_PER_DAY,
  WINDOW_6M_DAYS,
  WINDOW_12M_DAYS,
  MIN_SAMPLES,
  TREND_THRESHOLD,
};

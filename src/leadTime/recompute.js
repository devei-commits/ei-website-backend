'use strict';

/**
 * Lead-Time Stats recompute service (spec §10.4). Scans PO + completed-GRN history, builds per
 * (item, vendor) lead samples, runs the §10 engine, and upserts the lead_time_stats cache.
 * Called on GRN posting (event-driven freshness) and nightly (drift/backfill).
 */
const PurchaseOrder = require('../purchaseOrders/models');
const GoodsReceivedNote = require('../grn/models');
const LeadTimeStat = require('./leadTimeStatModel');
const { buildLeadTimeSamples, vendorKey } = require('../lib/leadTimeSamples');
const { computeLeadTimeStat } = require('../lib/leadTimeStats');

function itemKey(itemType, itemId, vendor) {
  return `${itemType}:${itemId}:${vendorKey(vendor)}`;
}

/**
 * Recompute the whole cache from current PO/GRN history.
 * Best-effort: swallows a missing lead_time_stats table (pre-sync envs) so callers never crash.
 * @param {{ nowMs?: number }} [opts]
 * @returns {Promise<{ upserts: number, skipped?: boolean }>}
 */
async function recomputeAllLeadTimeStats(opts = {}) {
  const nowMs = Number(opts.nowMs) || Date.now();
  try {
    const [pos, grns] = await Promise.all([
      PurchaseOrder.findAll({ attributes: ['id', 'order_date', 'vendor_name', 'items'] }),
      GoodsReceivedNote.findAll({
        attributes: ['purchase_order_id', 'status', 'stage', 'grn_date', 'received_date', 'vendor'],
      }),
    ]);
    const byKey = buildLeadTimeSamples(pos, grns);
    let upserts = 0;
    for (const [, entry] of byKey) {
      // priceListLeadDays=null: this cache stores ACTUAL history only; the consumer merges price-list
      // on limited/no-history rows (avg_actual_days stays null).
      const stat = computeLeadTimeStat(entry.samples, { priceListLeadDays: null, nowMs });
      await LeadTimeStat.upsert({
        item_key: itemKey(entry.itemType, entry.itemId, entry.vendor),
        item_type: entry.itemType,
        raw_material_id: entry.itemType === 'RM' ? entry.itemId : null,
        pack_material_id: entry.itemType === 'PM' ? entry.itemId : null,
        vendor_name: entry.vendor,
        avg_actual_days: stat.avgActualDays,
        p50: stat.p50,
        p90: stat.p90,
        trend_pct: stat.trendPct,
        trend_up: stat.trendUp,
        sample_size: stat.sampleSize,
        source: stat.source,
        computed_at: new Date(nowMs),
      });
      upserts += 1;
    }
    return { upserts };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : '';
    const code = err && err.original && err.original.code ? String(err.original.code) : '';
    if (code === '42P01' || /lead_time_stats|goods_received_notes|purchase_orders/i.test(msg)) {
      return { upserts: 0, skipped: true };
    }
    throw err;
  }
}

/**
 * Look up the cached actual lead stat for one (item, vendor). Returns null on miss / thin history.
 * @param {'RM'|'PM'} itemType
 * @param {number} itemId
 * @param {string} vendor
 * @returns {Promise<{ avgActualDays:number|null, p50:number|null, p90:number|null, trendPct:number, trendUp:boolean, sampleSize:number, source:string }|null>}
 */
async function getLeadTimeStat(itemType, itemId, vendor) {
  if (!itemType || !Number.isFinite(Number(itemId))) return null;
  try {
    const row = await LeadTimeStat.findOne({ where: { item_key: itemKey(itemType, Number(itemId), vendor) } });
    if (!row) return null;
    const d = row.get ? row.get({ plain: true }) : row;
    return {
      avgActualDays: d.avg_actual_days != null ? Number(d.avg_actual_days) : null,
      p50: d.p50 != null ? Number(d.p50) : null,
      p90: d.p90 != null ? Number(d.p90) : null,
      trendPct: Number(d.trend_pct) || 0,
      trendUp: Boolean(d.trend_up),
      sampleSize: Number(d.sample_size) || 0,
      source: d.source || null,
    };
  } catch (err) {
    const code = err && err.original && err.original.code ? String(err.original.code) : '';
    if (code === '42P01') return null;
    return null;
  }
}

module.exports = { recomputeAllLeadTimeStats, getLeadTimeStat, itemKey };

/**
 * BD per-client rollups & derivations — pure functions, no DB access.
 *
 * Computes the Customer-Tracker numbers (orders, PIS, revenue, CLV, tier,
 * lifecycle) BEST-EFFORT from existing data the BD module only READS:
 *   - SalesOrder  → orders {open, ytd}, revenue (12m), CLV (lifetime), last activity
 *   - ProductCustomization → PIS {inFlight, total}  (the "PIS" entity)
 *
 * Linkage is fuzzy by design (the source data has no hard client FK):
 *   - SalesOrder links by customer_name STRING  → matched to VendorClient.name
 *   - ProductCustomization links by user_id      → matched to VendorClient.user_id
 *
 * Financials with no source (receivable / advances / overdue) are returned null
 * → the UI renders '—'. Queries/grievances/nextMeeting are 0/null until Phase 2.
 */

/* ── tier ────────────────────────────────────────────────────────────────── */
const TIER_THRESHOLDS = [
  { tier: 'platinum', min: 1_00_00_000 }, // ≥ ₹1 Cr (rolling 12m)
  { tier: 'gold', min: 25_00_000 },        // ₹25 L – 1 Cr
  { tier: 'silver', min: 5_00_000 },       // ₹5 L – 25 L
  { tier: 'bronze', min: 0 },              // < ₹5 L
];
function tierFromRevenue(revenue) {
  const r = Number(revenue || 0);
  for (const t of TIER_THRESHOLDS) if (r >= t.min) return t.tier;
  return 'bronze';
}

/* ── lifecycle ───────────────────────────────────────────────────────────── */
const DORMANT_DAYS = 90;
const CHURN_DAYS = 365;
function lifecycleFromActivity(daysSinceLastSO, hasEverOrdered) {
  if (!hasEverOrdered) return 'prospect';
  if (daysSinceLastSO == null) return 'active';
  if (daysSinceLastSO >= CHURN_DAYS) return 'churn';
  if (daysSinceLastSO >= DORMANT_DAYS) return 'dormant';
  return 'active';
}

/* ── date helpers ────────────────────────────────────────────────────────── */
/** Start of the current Indian financial year (Apr 1). YTD counts from here. */
function currentFyStart(now = new Date()) {
  const y = now.getFullYear();
  const fyStartYear = now.getMonth() >= 3 ? y : y - 1; // month index 3 = April
  return new Date(fyStartYear, 3, 1);
}
function daysSince(dateStr, now = new Date()) {
  if (!dateStr) return null;
  const dt = new Date(dateStr);
  if (Number.isNaN(dt.getTime())) return null;
  const a = new Date(dt); a.setHours(0, 0, 0, 0);
  const b = new Date(now); b.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86_400_000));
}

/* ── sales-order helpers ─────────────────────────────────────────────────── */
function normName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
/** Money value of a SO from its items JSON (handles unitPrice|rate, quantity|orderedQty). */
function soValue(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, l) => {
    const qty = Number(l?.quantity ?? l?.orderedQty ?? 0);
    const price = Number(l?.unitPrice ?? l?.rate ?? 0);
    const v = qty * price;
    return sum + (Number.isFinite(v) ? v : 0);
  }, 0);
}
/** Open = not cancelled and not fully shipped/closed (best-effort over Zoho shape). */
function isOpenSO(d) {
  if (String(d.status || '').toLowerCase() === 'cancelled') return false;
  const os = d.order_status && typeof d.order_status === 'object' ? d.order_status : {};
  if (os.quantityOpen != null && os.quantityOpen !== '') return Number(os.quantityOpen) > 0;
  const flag = String(os.shipped || os.orderStatus || '').toLowerCase();
  return !(flag.includes('shipped') || flag.includes('closed') || flag.includes('delivered'));
}

/* ── product-customization (PIS) helpers ─────────────────────────────────── */
const PIS_CLOSED = new Set(['closed', 'completed', 'rejected', 'cancelled', 'delivered', 'done']);
function isInFlightPis(c) {
  const s = String(c.status || '').toLowerCase();
  return !PIS_CLOSED.has(s);
}
function pisCreatedAt(c) { return c.created_at || c.createdAt || c.assigned_at || null; }

/**
 * Build per-client rollups.
 * @param {object} p
 * @param {Array} p.clients         VendorClient plain rows (type='client')
 * @param {Array} p.salesOrders     SalesOrder plain rows
 * @param {Array} p.customizations  ProductCustomization plain rows (PIS)
 * @param {Array} [p.queries]       BdQuery plain rows
 * @param {Array} [p.grievances]    BdGrievance plain rows
 * @param {Array} [p.meetings]      BdMeeting plain rows
 * @param {Date}  [p.now]
 * @returns {Map<number, object>} clientId → rollup
 */
const CLOSED_TXN = new Set(['resolved', 'closed', 'cancelled']);
function computeClientRollups({ clients, salesOrders, customizations, queries = [], grievances = [], meetings = [], now = new Date() }) {
  const fyStart = currentFyStart(now);
  const twelveMonthsAgo = new Date(now); twelveMonthsAgo.setFullYear(now.getFullYear() - 1);

  // Index clients for fuzzy linkage.
  const byName = new Map();   // normName → client
  const byUserId = new Map(); // user_id   → client
  for (const c of clients) {
    if (c.name) byName.set(normName(c.name), c);
    if (c.user_id != null) byUserId.set(Number(c.user_id), c);
  }

  // Seed an aggregate per client.
  const agg = new Map();
  for (const c of clients) {
    agg.set(c.id, {
      ordersOpen: 0, ordersYtd: 0, ordersTotal: 0,
      revenue12m: 0, clv: 0,
      lastOrderDate: null,
      pisInFlight: 0, pisTotal: 0,
    });
  }

  // Sales orders → orders / revenue / activity.
  for (const so of salesOrders) {
    const client = byName.get(normName(so.customer_name));
    if (!client) continue;
    const a = agg.get(client.id);
    if (!a) continue;
    const val = soValue(so.items);
    a.clv += val;
    a.ordersTotal += 1;
    if (isOpenSO(so)) a.ordersOpen += 1;
    const od = so.order_date ? new Date(so.order_date) : null;
    if (od && !Number.isNaN(od.getTime())) {
      if (od >= fyStart) a.ordersYtd += 1;
      if (od >= twelveMonthsAgo && String(so.status || '').toLowerCase() !== 'cancelled') a.revenue12m += val;
      if (!a.lastOrderDate || od > a.lastOrderDate) a.lastOrderDate = od;
    }
  }

  // Product customizations (PIS) → pis counts, linked via user_id.
  for (const c of customizations) {
    if (String(c.lifecycle_status || '').toLowerCase() === 'deleted') continue;
    const client = c.user_id != null ? byUserId.get(Number(c.user_id)) : null;
    if (!client) continue;
    const a = agg.get(client.id);
    if (!a) continue;
    a.pisTotal += 1;
    if (isInFlightPis(c)) a.pisInFlight += 1;
  }

  // Phase 2 transaction aggregates (queries / grievances / meetings).
  const txn = new Map();
  for (const c of clients) txn.set(c.id, { qOpen: 0, qBreached: 0, gOpen: 0, gEscalated: 0, nextMeeting: null });
  const slaBreached = (row) => {
    const hrs = Number(row.sla_target_hours || 0);
    if (!hrs || !row.created_at) return false;
    return new Date(new Date(row.created_at).getTime() + hrs * 3600000) < now;
  };
  for (const q of queries) {
    const a = txn.get(Number(q.client_id)); if (!a) continue;
    if (CLOSED_TXN.has(String(q.status || '').toLowerCase())) continue;
    a.qOpen += 1;
    if (slaBreached(q)) a.qBreached += 1;
  }
  for (const g of grievances) {
    const a = txn.get(Number(g.client_id)); if (!a) continue;
    if (CLOSED_TXN.has(String(g.status || '').toLowerCase())) continue;
    a.gOpen += 1;
    if (String(g.status || '').toLowerCase() === 'escalated') a.gEscalated += 1;
  }
  for (const m of meetings) {
    const a = txn.get(Number(m.client_id)); if (!a) continue;
    if (CLOSED_TXN.has(String(m.status || '').toLowerCase())) continue;
    const when = m.scheduled_for ? new Date(m.scheduled_for) : null;
    if (!when || Number.isNaN(when.getTime()) || when < now) continue;
    if (!a.nextMeeting || when < new Date(a.nextMeeting.date)) {
      a.nextMeeting = { date: when.toISOString(), mode: m.mode || null };
    }
  }

  // Finalize derived fields.
  const out = new Map();
  for (const c of clients) {
    const a = agg.get(c.id);
    const lastOrderStr = a.lastOrderDate ? a.lastOrderDate.toISOString() : null;
    const dSince = daysSince(lastOrderStr, now);
    // Revenue basis for tier/CLV: prefer computed SO revenue, fall back to stored revenue_value.
    const revenue12m = a.revenue12m || Number(c.revenue_value || 0);
    const clv = a.clv || Number(c.revenue_value || 0);
    out.set(c.id, {
      orders: { open: a.ordersOpen, ytd: a.ordersYtd, total: a.ordersTotal },
      pis: { inFlight: a.pisInFlight, total: a.pisTotal },
      revenue12m,
      clv,
      lastOrderDate: lastOrderStr,
      daysSinceLastSO: dSince,
      hasEverOrdered: a.ordersTotal > 0,
      // No source today → null (UI renders '—').
      receivable: null, overdue: null, advances: null,
      // Phase 2 transaction rollups.
      queries: { open: txn.get(c.id).qOpen, breached: txn.get(c.id).qBreached },
      grievances: { open: txn.get(c.id).gOpen, escalated: txn.get(c.id).gEscalated },
      nextMeeting: txn.get(c.id).nextMeeting,
    });
  }
  return out;
}

module.exports = {
  computeClientRollups,
  tierFromRevenue,
  lifecycleFromActivity,
  currentFyStart,
  daysSince,
  normName,
  soValue,
  isOpenSO,
  isInFlightPis,
  pisCreatedAt,
  DORMANT_DAYS,
  CHURN_DAYS,
};

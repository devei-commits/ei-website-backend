/**
 * Cashflow-Gate Engine — the core safety mechanism of the Treasury module.
 *
 * Every outflow approval/execution and every inward reschedule asks the same
 * question: "If this action happens, what is the LOWEST the combined bank
 * balance will be at any point in the next 30 days?" If that floor drops below
 * the configured threshold (₹10L default) the verdict is `over` and the caller
 * must force an override (logged to `treasury_gate_overrides` → Cash-Risk report).
 *
 * Design: a PURE core (projectDaily / lowestPoint / verdictFor / summarize) that
 * takes plain numbers/arrays and is trivially unit-testable, plus a thin async
 * DB layer (loadConfig / getBankSummary / loadBaseMovements) and orchestrators
 * (evaluateScenario / evaluateGate) that compose them. Controllers in later
 * phases build "before"/"after" movement deltas and call evaluateGate.
 *
 * Money in this module is handled as plain JS numbers (rupees). Sequelize
 * returns DECIMAL as strings, so the loaders coerce with Number().
 */
const { Op } = require('sequelize');
const {
  TreasuryBankAccount,
  TreasurySetting,
  TreasuryInwardPayment,
  TreasuryOutwardPayment,
} = require('./models');

/* ── Defaults (overridable via treasury_settings rows) ── */
const DEFAULTS = {
  cashflow_gate_threshold: 1_000_000, // ₹10L floor
  cashflow_gate_tight_buffer: 500_000, // within ₹5L above the floor ⇒ "tight"
  cashflow_horizon_days: 30,
};

// Inward statuses that still represent money expected to LAND (feed the projection).
const PENDING_INWARD = ['expected', 'rescheduled', 'partial'];
// Outward statuses that represent a committed OUTflow not yet gone from the bank.
const COMMITTED_OUTWARD = [
  'submitted',
  'function_approved',
  'treasury_approved',
  'admin_approved',
  'scheduled',
];

/* ══════════════════════════ Pure date helpers ══════════════════════════ */

/** Normalize any Date/ISO/`YYYY-MM-DD` to a UTC `YYYY-MM-DD` key. */
function dayKey(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Add `n` days to a `YYYY-MM-DD` key (UTC-safe). */
function addDays(key, n) {
  const d = new Date(`${key}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Today as a `YYYY-MM-DD` UTC key. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/* ══════════════════════════ Pure core ══════════════════════════ */

/**
 * Project a day-by-day closing balance over the horizon.
 * @param {number} openingBalance combined bank balance "now"
 * @param {Array<{date:string, amount:number, kind:'inflow'|'outflow'}>} movements
 *        amount is a positive magnitude; `kind` decides the sign.
 * @param {{asOf:string, horizonDays:number}} opts
 * @returns {{openingBalance:number, days:Array}}
 *   each day: { date, inflow, outflow, net, closingBalance, inflowCount, outflowCount }
 */
function projectDaily(openingBalance, movements, { asOf, horizonDays }) {
  const start = asOf || today();
  const lastDay = addDays(start, horizonDays - 1);

  // Bucket movements by day; anything overdue (before asOf) collapses onto day 0.
  const buckets = new Map(); // key -> { inflow, outflow, inflowCount, outflowCount }
  const bucketFor = (key) => {
    if (!buckets.has(key)) buckets.set(key, { inflow: 0, outflow: 0, inflowCount: 0, outflowCount: 0 });
    return buckets.get(key);
  };

  for (const mv of movements) {
    let key = dayKey(mv.date);
    if (!key) continue;
    if (key < start) key = start; // overdue → project onto today
    if (key > lastDay) continue; // beyond horizon → ignore
    const amt = Number(mv.amount) || 0;
    if (amt === 0) continue;
    const b = bucketFor(key);
    if (mv.kind === 'outflow') {
      b.outflow += amt;
      b.outflowCount += 1;
    } else {
      b.inflow += amt;
      b.inflowCount += 1;
    }
  }

  const days = [];
  let running = Number(openingBalance) || 0;
  for (let i = 0; i < horizonDays; i += 1) {
    const key = addDays(start, i);
    const b = buckets.get(key) || { inflow: 0, outflow: 0, inflowCount: 0, outflowCount: 0 };
    const net = b.inflow - b.outflow;
    running += net;
    days.push({
      date: key,
      inflow: round2(b.inflow),
      outflow: round2(b.outflow),
      net: round2(net),
      closingBalance: round2(running),
      inflowCount: b.inflowCount,
      outflowCount: b.outflowCount,
    });
  }
  return { openingBalance: round2(Number(openingBalance) || 0), days };
}

/** Lowest projected balance across the horizon (opening balance included as day-0 floor). */
function lowestPoint(openingBalance, days) {
  let amount = Number(openingBalance) || 0;
  let date = days.length ? days[0].date : today();
  for (const d of days) {
    if (d.closingBalance < amount) {
      amount = d.closingBalance;
      date = d.date;
    }
  }
  return { amount: round2(amount), date };
}

/** safe | tight | over — from a floor amount and the config bands. */
function verdictFor(lowest, { threshold, tightBuffer }) {
  if (lowest < threshold) return 'over';
  if (lowest < threshold + tightBuffer) return 'tight';
  return 'safe';
}

/** Count of days whose closing balance is under the threshold. */
function daysBelowThreshold(days, threshold) {
  return days.reduce((n, d) => (d.closingBalance < threshold ? n + 1 : n), 0);
}

/** Roll a projection up into the summary fields the UI needs. */
function summarize(openingBalance, days, config) {
  const lowest = lowestPoint(openingBalance, days);
  return {
    openingBalance: round2(Number(openingBalance) || 0),
    lowest,
    verdict: verdictFor(lowest.amount, config),
    daysBelowThreshold: daysBelowThreshold(days, config.threshold),
    closingBalance: days.length ? days[days.length - 1].closingBalance : round2(Number(openingBalance) || 0),
    threshold: config.threshold,
    days,
  };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/* ══════════════════════════ DB layer ══════════════════════════ */

/** Resolve gate config from treasury_settings, falling back to DEFAULTS. */
async function loadConfig() {
  let rows = [];
  try {
    rows = await TreasurySetting.findAll({
      where: { key: Object.keys(DEFAULTS) },
    });
  } catch (_e) {
    rows = [];
  }
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const pick = (key) => {
    const v = map.get(key);
    if (v == null) return DEFAULTS[key];
    // stored as JSONB: accept {amount|days|value} or a raw number
    if (typeof v === 'number') return v;
    if (typeof v === 'object') return Number(v.amount ?? v.days ?? v.value ?? DEFAULTS[key]);
    return Number(v) || DEFAULTS[key];
  };
  return {
    threshold: pick('cashflow_gate_threshold'),
    tightBuffer: pick('cashflow_gate_tight_buffer'),
    horizonDays: pick('cashflow_horizon_days'),
  };
}

/** Combined + per-account bank balances (active accounts only). */
async function getBankSummary() {
  const accounts = await TreasuryBankAccount.findAll({
    where: { is_active: true },
    order: [['sort_order', 'ASC'], ['id', 'ASC']],
  });
  const list = accounts.map((a) => {
    const d = a.get({ plain: true });
    return {
      id: d.id,
      accountCode: d.account_code,
      bankName: d.bank_name,
      label: d.account_label,
      accountType: d.account_type,
      balance: round2(Number(d.current_balance) || 0),
      overdraftLimit: round2(Number(d.overdraft_limit) || 0),
    };
  });
  const totalBalance = round2(list.reduce((s, a) => s + a.balance, 0));
  return { accounts: list, totalBalance };
}

/**
 * Load the base set of projected movements (pending inflows + committed outflows),
 * plus the current combined bank balance (the opening balance).
 * @param {{asOf:string, horizonDays:number, excludeInwardIds?:number[], excludeOutwardIds?:number[]}} opts
 */
async function loadBaseMovements({ asOf, horizonDays, excludeInwardIds = [], excludeOutwardIds = [] }) {
  const start = asOf || today();
  const lastDay = addDays(start, horizonDays - 1);

  const { totalBalance } = await getBankSummary();

  const inwardWhere = {
    status: { [Op.in]: PENDING_INWARD },
    expected_date: { [Op.ne]: null, [Op.lte]: lastDay },
  };
  if (excludeInwardIds.length) inwardWhere.id = { [Op.notIn]: excludeInwardIds };

  const outwardWhere = {
    status: { [Op.in]: COMMITTED_OUTWARD },
  };
  if (excludeOutwardIds.length) outwardWhere.id = { [Op.notIn]: excludeOutwardIds };

  const [inwards, outwards] = await Promise.all([
    TreasuryInwardPayment.findAll({
      where: inwardWhere,
      attributes: ['id', 'expected_date', 'expected_amount', 'net_expected_amount', 'status'],
    }),
    TreasuryOutwardPayment.findAll({
      where: outwardWhere,
      attributes: ['id', 'due_date', 'scheduled_date', 'net_amount', 'gross_amount', 'status'],
    }),
  ]);

  const movements = [];
  for (const r of inwards) {
    const d = r.get({ plain: true });
    const amount = Number(d.net_expected_amount) || Number(d.expected_amount) || 0;
    if (amount > 0) movements.push({ date: dayKey(d.expected_date), amount, kind: 'inflow', id: d.id });
  }
  for (const r of outwards) {
    const d = r.get({ plain: true });
    const when = dayKey(d.scheduled_date) || dayKey(d.due_date);
    if (!when || when > lastDay) continue;
    const amount = Number(d.net_amount) || Number(d.gross_amount) || 0;
    if (amount > 0) movements.push({ date: when, amount, kind: 'outflow', id: d.id });
  }

  return { openingBalance: totalBalance, movements };
}

/* ══════════════════════════ Orchestrators ══════════════════════════ */

/**
 * Evaluate ONE cashflow scenario against the live book, optionally excluding
 * some rows and injecting synthetic movements (the "what-if" of a pending action).
 * @param {{
 *   asOf?:string, horizonDays?:number,
 *   excludeInwardIds?:number[], excludeOutwardIds?:number[],
 *   addInflows?:Array<{date:string, amount:number}>,
 *   addOutflows?:Array<{date:string, amount:number}>
 * }} opts
 * @returns {Promise<object>} summarize() result (verdict, lowest, days, ...)
 */
async function evaluateScenario(opts = {}) {
  const config = await loadConfig();
  const asOf = opts.asOf || today();
  const horizonDays = opts.horizonDays || config.horizonDays;

  const { openingBalance, movements } = await loadBaseMovements({
    asOf,
    horizonDays,
    excludeInwardIds: opts.excludeInwardIds || [],
    excludeOutwardIds: opts.excludeOutwardIds || [],
  });

  const extra = [
    ...(opts.addInflows || []).map((m) => ({ date: dayKey(m.date), amount: Number(m.amount) || 0, kind: 'inflow' })),
    ...(opts.addOutflows || []).map((m) => ({ date: dayKey(m.date), amount: Number(m.amount) || 0, kind: 'outflow' })),
  ];

  const { days } = projectDaily(openingBalance, [...movements, ...extra], { asOf, horizonDays });
  return { asOf, horizonDays, ...summarize(openingBalance, days, config) };
}

/**
 * Compute a BEFORE vs AFTER gate preview for an action. The caller describes the
 * action as: rows to exclude from the live book (the item being acted on) plus
 * the synthetic movements representing that item's state before and after.
 *
 * Examples:
 *  - New manual outflow ₹A on date D:
 *      { after: { addOutflows: [{date:D, amount:A}] } }        // before = book as-is
 *  - Reschedule inward id=I (amt A) from oldD → newD:
 *      { excludeInwardIds:[I], before:{addInflows:[{date:oldD,amount:A}]},
 *        after:{addInflows:[{date:newD,amount:A}]} }
 *  - Approve/execute existing outflow id=O (amt A) on date D:
 *      { excludeOutwardIds:[O], after:{addOutflows:[{date:D,amount:A}]} }  // shows this payment's impact
 *
 * @returns {Promise<{threshold:number, verdict:string, before:object, after:object,
 *   change:{lowest:number}}>}
 */
async function evaluateGate({ asOf, horizonDays, excludeInwardIds = [], excludeOutwardIds = [], before = {}, after = {} } = {}) {
  const scenarioBase = { asOf, horizonDays, excludeInwardIds, excludeOutwardIds };
  const beforeRes = await evaluateScenario({ ...scenarioBase, ...before });
  const afterRes = await evaluateScenario({ ...scenarioBase, ...after });
  return {
    threshold: afterRes.threshold,
    verdict: afterRes.verdict, // the gate decision is about the resulting (after) state
    before: beforeRes,
    after: afterRes,
    change: {
      lowest: round2(afterRes.lowest.amount - beforeRes.lowest.amount),
      daysBelowThreshold: afterRes.daysBelowThreshold - beforeRes.daysBelowThreshold,
    },
  };
}

module.exports = {
  // constants
  DEFAULTS,
  PENDING_INWARD,
  COMMITTED_OUTWARD,
  // pure helpers (exported for unit tests / reuse)
  dayKey,
  addDays,
  today,
  projectDaily,
  lowestPoint,
  verdictFor,
  daysBelowThreshold,
  summarize,
  // db layer
  loadConfig,
  getBankSummary,
  loadBaseMovements,
  // orchestrators
  evaluateScenario,
  evaluateGate,
};

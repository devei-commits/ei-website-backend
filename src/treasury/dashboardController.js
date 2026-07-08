/**
 * Treasury — Home Dashboard, Cashflow Forecast (View 1), Payment Schedule (View 5).
 *
 * Endpoints (under /api/v1/treasury):
 *   GET /dashboard                 8-tile KPI strip + 7-day snapshot
 *   GET /cashflow                  forecast series (daily|weekly|monthly) + filters + gate zones
 *   GET /cashflow/day/:date        drill-down: receipts + disbursements on a date
 *   GET /schedule                  calendar of scheduled outflows (per-day totals + colour)
 *
 * Everything projects on top of gate.getBankSummary() + the same movement rules as the
 * cashflow gate, so the dashboard and the gate can never disagree.
 */
const { Op } = require('sequelize');
const gate = require('./cashflowGate');
const { num, round2, plain, dayDiff } = require('./helpers');
const {
  TreasuryInwardPayment, TreasuryOutwardPayment, TreasuryAdvance, TreasuryApproval,
} = require('./models');

const PENDING_INWARD = gate.PENDING_INWARD; // expected|rescheduled|partial
const COMMITTED_OUTWARD = gate.COMMITTED_OUTWARD; // submitted..scheduled
const IN_APPROVAL = ['submitted', 'function_approved', 'treasury_approved', 'admin_approved'];

/* Map an outward source module to a forecast category. */
function outwardCategory(module) {
  if (module === 'procurement') return 'Procurement Payment';
  if (module === 'regulatory') return 'Regulatory Fee';
  if (module === 'hr') return 'Salary';
  return 'Other';
}
function inwardCategory(type) {
  return type === 'advance' ? 'Advance' : 'Invoice';
}

/* ═══════════════════════ Home Dashboard ═══════════════════════ */

async function getDashboard(req, res) {
  try {
    const todayKey = gate.today();
    const horizon = 30;
    const bank = await gate.getBankSummary();

    // One 30-day projection powers the net-cashflow tile + 7-day snapshot.
    const proj = await gate.evaluateScenario({ asOf: todayKey, horizonDays: horizon });

    const [inwards, outwards, advances, approvalRows] = await Promise.all([
      TreasuryInwardPayment.findAll({
        where: { status: { [Op.in]: PENDING_INWARD }, expected_date: { [Op.ne]: null } },
        attributes: ['id', 'expected_date', 'expected_amount', 'net_expected_amount', 'type', 'status'],
      }),
      TreasuryOutwardPayment.findAll({
        where: { status: { [Op.in]: [...IN_APPROVAL, 'scheduled', 'draft'] } },
        attributes: ['id', 'due_date', 'scheduled_date', 'net_amount', 'gross_amount', 'status'],
      }),
      TreasuryAdvance.findAll({
        where: { status: { [Op.in]: ['held', 'partially_adjusted'] } },
        attributes: ['client_id', 'balance_amount'],
      }),
      TreasuryOutwardPayment.findAll({
        where: { status: { [Op.in]: IN_APPROVAL } },
        include: [{ model: TreasuryApproval, as: 'approvals', attributes: ['status', 'sla_due_at'] }],
        attributes: ['id'],
      }),
    ]);

    const inwardNet = (r) => num(plain(r).net_expected_amount) || num(plain(r).expected_amount);
    const outNet = (r) => num(plain(r).net_amount) || num(plain(r).gross_amount);
    const in30 = (d) => d && String(d).slice(0, 10) <= gate.addDays(todayKey, horizon - 1);

    // Tile 2 — receivables
    const receivableOpen = round2(inwards.reduce((s, r) => s + inwardNet(r), 0));
    const overdueRows = inwards.filter((r) => String(plain(r).expected_date).slice(0, 10) < todayKey);
    const receivableOverdue = round2(overdueRows.reduce((s, r) => s + inwardNet(r), 0));

    // Tile 3 — payable due (next 30d)
    const payableRows = outwards.filter((r) => { const d = plain(r); const when = d.scheduled_date || d.due_date; return when && in30(when); });
    const payableDue = round2(payableRows.reduce((s, r) => s + outNet(r), 0));

    // Tile 5 — advances held
    const advancesHeld = round2(advances.reduce((s, a) => s + num(plain(a).balance_amount), 0));
    const advanceClients = new Set(advances.map((a) => plain(a).client_id).filter(Boolean)).size;

    // Tile 6 — approvals pending + SLA breached
    const nowMs = Date.now();
    let approvalsPending = 0;
    let slaBreached = 0;
    for (const p of approvalRows) {
      const step = (plain(p).approvals || []).find((a) => a.status === 'pending');
      if (step) { approvalsPending += 1; if (step.sla_due_at && new Date(step.sla_due_at).getTime() < nowMs) slaBreached += 1; }
    }

    // Tiles 7/8 — today
    const todayInflowRows = inwards.filter((r) => String(plain(r).expected_date).slice(0, 10) === todayKey);
    const todayOutRows = outwards.filter((r) => plain(r).scheduled_date && String(plain(r).scheduled_date).slice(0, 10) === todayKey);

    // Tile 4 — 30-day net
    const totalIn = round2(proj.days.reduce((s, d) => s + d.inflow, 0));
    const totalOut = round2(proj.days.reduce((s, d) => s + d.outflow, 0));

    const kpis = {
      bankBalance: { combined: bank.totalBalance, accounts: bank.accounts },
      receivableOpen: { total: receivableOpen, overdue: receivableOverdue },
      payableDue30d: { total: payableDue, count: payableRows.length },
      netCashflow30d: { net: round2(totalIn - totalOut), inflow: totalIn, outflow: totalOut, currentBalance: bank.totalBalance, projectedLowest: proj.lowest.amount, gateVerdict: proj.verdict },
      advancesHeld: { total: advancesHeld, clients: advanceClients },
      approvalsPending: { count: approvalsPending, slaBreached },
      todayInflow: { total: round2(todayInflowRows.reduce((s, r) => s + inwardNet(r), 0)), count: todayInflowRows.length },
      todayOutflow: { total: round2(todayOutRows.reduce((s, r) => s + outNet(r), 0)), count: todayOutRows.length },
    };

    // 7-day snapshot from the same projection.
    const snapshot = proj.days.slice(0, 7).map((d) => ({
      date: d.date,
      isToday: d.date === todayKey,
      inflow: d.inflow,
      inflowCount: d.inflowCount,
      outflow: d.outflow,
      outflowCount: d.outflowCount,
      net: d.net,
      closingBalance: d.closingBalance,
    }));

    res.json({ asOf: todayKey, threshold: proj.threshold, kpis, snapshot });
  } catch (err) {
    console.error('[treasury] getDashboard error', err);
    res.status(500).json({ error: 'Failed to load treasury dashboard' });
  }
}

/* ═══════════════════════ Cashflow Forecast (View 1) ═══════════════════════ */

/**
 * Detailed movement list honouring forecast filters (bank / category / module),
 * plus the opening balance for the projection.
 */
async function loadForecastMovements({ asOf, horizonDays, bankAccountId, category, module }) {
  const lastDay = gate.addDays(asOf, horizonDays - 1);
  const bank = await gate.getBankSummary();
  let openingBalance = bank.totalBalance;
  if (bankAccountId) {
    const acct = bank.accounts.find((a) => a.id === Number(bankAccountId));
    openingBalance = acct ? acct.balance : 0;
  }

  const inwardWhere = { status: { [Op.in]: PENDING_INWARD }, expected_date: { [Op.ne]: null, [Op.lte]: lastDay } };
  if (bankAccountId) inwardWhere.destination_bank_account_id = Number(bankAccountId);
  const outwardWhere = { status: { [Op.in]: COMMITTED_OUTWARD } };
  if (bankAccountId) outwardWhere.bank_account_id = Number(bankAccountId);
  if (module) outwardWhere.source_module = module;

  const [inwards, outwards] = await Promise.all([
    TreasuryInwardPayment.findAll({ where: inwardWhere }),
    TreasuryOutwardPayment.findAll({ where: outwardWhere }),
  ]);

  const items = [];
  for (const r of inwards) {
    const d = plain(r);
    const cat = inwardCategory(d.type);
    if (category && category !== cat) continue;
    const amount = num(d.net_expected_amount) || num(d.expected_amount);
    if (amount > 0) items.push({ date: gate.dayKey(d.expected_date), kind: 'inflow', category: cat, amount, id: d.id, code: d.inward_code, party: d.client_name, status: d.status });
  }
  for (const r of outwards) {
    const d = plain(r);
    const cat = outwardCategory(d.source_module);
    if (category && category !== cat) continue;
    const when = gate.dayKey(d.scheduled_date) || gate.dayKey(d.due_date);
    if (!when || when > lastDay) continue;
    const amount = num(d.net_amount) || num(d.gross_amount);
    if (amount > 0) items.push({ date: when, kind: 'outflow', category: cat, module: d.source_module, amount, id: d.id, code: d.outward_code, party: d.payee_name, status: d.status });
  }
  return { openingBalance, items };
}

async function getCashflowForecast(req, res) {
  try {
    const asOf = req.query.from ? gate.dayKey(req.query.from) : gate.today();
    const to = req.query.to ? gate.dayKey(req.query.to) : gate.addDays(asOf, 29);
    const horizonDays = Math.max(1, Math.min(dayDiff(to, asOf) + 1, 366));
    const granularity = ['daily', 'weekly', 'monthly'].includes(req.query.granularity) ? req.query.granularity : 'daily';
    const config = await gate.loadConfig();

    const { openingBalance, items } = await loadForecastMovements({
      asOf, horizonDays, bankAccountId: req.query.bankAccountId, category: req.query.category, module: req.query.module,
    });
    const { days } = gate.projectDaily(openingBalance, items, { asOf, horizonDays });

    // Bucket for weekly/monthly (closingBalance = last day's balance in the bucket).
    const buckets = bucketSeries(days, granularity);
    const belowZones = days.filter((d) => d.closingBalance < config.threshold).map((d) => d.date);

    res.json({
      asOf, to, granularity, threshold: config.threshold, openingBalance,
      series: buckets,
      belowThresholdDates: belowZones,
      totals: {
        inflow: round2(days.reduce((s, d) => s + d.inflow, 0)),
        outflow: round2(days.reduce((s, d) => s + d.outflow, 0)),
        net: round2(days.reduce((s, d) => s + d.net, 0)),
        lowest: gate.lowestPoint(openingBalance, days),
      },
    });
  } catch (err) {
    console.error('[treasury] getCashflowForecast error', err);
    res.status(500).json({ error: 'Failed to load cashflow forecast' });
  }
}

function bucketSeries(days, granularity) {
  if (granularity === 'daily') return days;
  const keyOf = (dateKey) => {
    const d = new Date(`${dateKey}T00:00:00Z`);
    if (granularity === 'monthly') return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    // weekly: ISO-ish week bucket anchored to the series start (7-day chunks)
    return null;
  };
  const out = [];
  if (granularity === 'weekly') {
    for (let i = 0; i < days.length; i += 7) {
      const chunk = days.slice(i, i + 7);
      out.push(aggBucket(chunk));
    }
    return out;
  }
  const groups = new Map();
  for (const d of days) { const k = keyOf(d.date); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); }
  for (const chunk of groups.values()) out.push(aggBucket(chunk));
  return out;
}
function aggBucket(chunk) {
  const last = chunk[chunk.length - 1];
  return {
    date: chunk[0].date,
    periodEnd: last.date,
    inflow: round2(chunk.reduce((s, d) => s + d.inflow, 0)),
    outflow: round2(chunk.reduce((s, d) => s + d.outflow, 0)),
    net: round2(chunk.reduce((s, d) => s + d.net, 0)),
    closingBalance: last.closingBalance,
    inflowCount: chunk.reduce((s, d) => s + d.inflowCount, 0),
    outflowCount: chunk.reduce((s, d) => s + d.outflowCount, 0),
  };
}

async function getCashflowDay(req, res) {
  try {
    const date = gate.dayKey(req.params.date);
    const { items } = await loadForecastMovements({ asOf: date, horizonDays: 1, bankAccountId: req.query.bankAccountId });
    const onDay = items.filter((it) => it.date === date);
    res.json({
      date,
      receipts: onDay.filter((i) => i.kind === 'inflow'),
      disbursements: onDay.filter((i) => i.kind === 'outflow'),
      totals: {
        inflow: round2(onDay.filter((i) => i.kind === 'inflow').reduce((s, i) => s + i.amount, 0)),
        outflow: round2(onDay.filter((i) => i.kind === 'outflow').reduce((s, i) => s + i.amount, 0)),
      },
    });
  } catch (err) {
    console.error('[treasury] getCashflowDay error', err);
    res.status(500).json({ error: 'Failed to load day detail' });
  }
}

/* ═══════════════════════ Payment Schedule calendar (View 5) ═══════════════════════ */

async function getSchedule(req, res) {
  try {
    const asOf = req.query.from ? gate.dayKey(req.query.from) : gate.today();
    const to = req.query.to ? gate.dayKey(req.query.to) : gate.addDays(asOf, 29);
    const horizonDays = Math.max(1, Math.min(dayDiff(to, asOf) + 1, 92));
    const config = await gate.loadConfig();

    const proj = await gate.evaluateScenario({ asOf, horizonDays });
    const balanceByDate = new Map(proj.days.map((d) => [d.date, d.closingBalance]));

    const outwards = await TreasuryOutwardPayment.findAll({
      where: {
        status: { [Op.in]: [...IN_APPROVAL, 'scheduled'] },
        scheduled_date: { [Op.ne]: null, [Op.gte]: asOf, [Op.lte]: to },
      },
      order: [['scheduled_date', 'ASC']],
    });

    const byDate = new Map();
    for (const r of outwards) {
      const d = plain(r);
      const key = gate.dayKey(d.scheduled_date);
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push({
        id: d.id, outwardCode: d.outward_code, payeeName: d.payee_name, sourceModule: d.source_module,
        netAmount: num(d.net_amount), status: d.status, gateVerdict: d.gate_verdict, dueDate: d.due_date,
      });
    }

    const colourFor = (balance) => {
      if (balance == null) return 'green';
      if (balance < config.threshold) return 'red';
      if (balance < config.threshold + config.tightBuffer) return 'amber';
      return 'green';
    };

    const cells = [];
    for (let i = 0; i < horizonDays; i += 1) {
      const key = gate.addDays(asOf, i);
      const payments = byDate.get(key) || [];
      const projectedBalance = balanceByDate.has(key) ? balanceByDate.get(key) : null;
      cells.push({
        date: key,
        total: round2(payments.reduce((s, p) => s + p.netAmount, 0)),
        count: payments.length,
        projectedBalance,
        colour: colourFor(projectedBalance),
        payments,
      });
    }
    res.json({ asOf, to, threshold: config.threshold, cells });
  } catch (err) {
    console.error('[treasury] getSchedule error', err);
    res.status(500).json({ error: 'Failed to load payment schedule' });
  }
}

module.exports = { getDashboard, getCashflowForecast, getCashflowDay, getSchedule };

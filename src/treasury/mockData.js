/**
 * Treasury mock-data core — shared by the CLI script (scripts/treasury-mock-data.js)
 * and the dev API endpoints (POST /treasury/dev/seed-mock | reset-mock).
 *
 * seedMock() wipes then fills a rich demo dataset. resetMock() wipes ALL treasury
 * transactional data + mock clients (tagged MOCKC-%; real clients untouched) and
 * resets bank balances to 0. Callers manage the DB connection lifecycle.
 */
const { Op } = require('sequelize');
const gate = require('./cashflowGate');
const {
  TreasuryBankAccount, TreasuryInwardPayment, TreasuryInwardInvoice, TreasuryInwardVariance,
  TreasuryRescheduleHistory, TreasuryAdvance, TreasuryTdsReceivable, TreasuryOutwardPayment,
  TreasuryApproval, TreasuryRecurringPayment, TreasuryGateOverride, TreasuryBankStatement, TreasuryAuditLog,
} = require('./models');
const { approvalChainFor } = require('./outwardController');

let VendorClient = null; let BdClientProfile = null; let BdEvent = null;
try { VendorClient = require('../vendorClient/models'); } catch (_e) { /* opt */ }
try { ({ BdClientProfile, BdEvent } = require('../bd/models')); } catch (_e) { /* opt */ }

const addDays = (n) => gate.addDays(gate.today(), n);
const nowIso = () => new Date().toISOString();

/* ───────────────────────── RESET ───────────────────────── */

async function resetMock() {
  await TreasuryInwardInvoice.destroy({ where: {}, force: true });
  await TreasuryInwardVariance.destroy({ where: {}, force: true });
  await TreasuryRescheduleHistory.destroy({ where: {}, force: true });
  await TreasuryTdsReceivable.destroy({ where: {}, force: true });
  await TreasuryAdvance.destroy({ where: {}, force: true });
  await TreasuryApproval.destroy({ where: {}, force: true });
  await TreasuryGateOverride.destroy({ where: {}, force: true });
  await TreasuryBankStatement.destroy({ where: {}, force: true });
  await TreasuryOutwardPayment.destroy({ where: {}, force: true });
  await TreasuryInwardPayment.destroy({ where: {}, force: true });
  await TreasuryRecurringPayment.destroy({ where: {}, force: true });
  await TreasuryAuditLog.destroy({ where: {}, force: true });

  let mockClients = 0;
  if (VendorClient) {
    const mock = await VendorClient.findAll({ where: { entity_code: { [Op.like]: 'MOCKC-%' } }, attributes: ['id'] });
    const ids = mock.map((m) => m.id);
    if (ids.length) {
      if (BdEvent) await BdEvent.destroy({ where: { client_id: ids }, force: true });
      if (BdClientProfile) await BdClientProfile.destroy({ where: { client_id: ids }, force: true });
      await VendorClient.destroy({ where: { id: ids }, force: true });
      mockClients = ids.length;
    }
  }
  await TreasuryBankAccount.update({ current_balance: 0 }, { where: {} });
  return { mockClientsRemoved: mockClients };
}

/* ───────────────────────── SEED ───────────────────────── */

const MOCK_CLIENTS = [
  { name: 'Phoenix Pharma', tier: 'platinum' },
  { name: 'Radiant Cosmetics', tier: 'gold' },
  { name: 'SkinKraft Labs', tier: 'gold' },
  { name: 'Aura Wellness', tier: 'silver' },
  { name: 'Metro Distributors', tier: 'bronze' },
  { name: 'Zenith Retail', tier: 'silver' },
];

const YEAR = new Date().getUTCFullYear();
let inSeq = 0; let outSeq = 0; let recSeq = 0;
const inCode = () => `IN-${YEAR}-${String(++inSeq).padStart(4, '0')}`;
const outCode = () => `OUT-${YEAR}-${String(++outSeq).padStart(4, '0')}`;
const recCode = () => `REC-${YEAR}-${String(++recSeq).padStart(4, '0')}`;

async function ensureAccounts() {
  const map = {};
  for (const a of await TreasuryBankAccount.findAll()) map[a.account_code] = a.id;
  await TreasuryBankAccount.update({ current_balance: 6_200_000 }, { where: { account_code: 'HDFC-5550' } });
  await TreasuryBankAccount.update({ current_balance: 1_800_000 }, { where: { account_code: 'SBI-1122' } });
  await TreasuryBankAccount.update({ current_balance: 420_000 }, { where: { account_code: 'ICICI-8801' } });
  await TreasuryBankAccount.update({ current_balance: 0 }, { where: { account_code: 'HDFC-5560' } });
  return map;
}

async function seedClients() {
  if (!VendorClient) return [];
  const out = [];
  for (const c of MOCK_CLIENTS) {
    const code = `MOCKC-${c.name.replace(/\s+/g, '-').toUpperCase()}`;
    const [row] = await VendorClient.findOrCreate({ where: { entity_code: code }, defaults: { entity_code: code, type: 'client', name: c.name, status: 'active' } });
    if (BdClientProfile) await BdClientProfile.findOrCreate({ where: { client_id: row.id }, defaults: { client_id: row.id, tier: c.tier, tier_source: 'manual' } });
    out.push({ id: row.id, name: c.name, tier: c.tier });
  }
  return out;
}

function approvalsForStatus(chain, status) {
  const doneThrough = { submitted: 0, function_approved: 1, treasury_approved: 2, admin_approved: 3, scheduled: chain.roles.length, paid: chain.roles.length, reconciled: chain.roles.length };
  const n = doneThrough[status] ?? 0;
  return chain.roles.map((role, i) => ({ level: i + 1, role_required: role, status: i < n ? 'approved' : 'pending', approver_name: i < n ? 'Demo Approver' : null, acted_at: i < n ? nowIso() : null, sla_due_at: addDays(2) }));
}

async function seedOutward(bankId) {
  const HDFC = bankId['HDFC-5550'];
  const rows = [
    { module: 'procurement', sub: 'PO Vendor Payment', payee: 'Radcom Packaging', amt: 650000, due: addDays(4), status: 'submitted' },
    { module: 'procurement', sub: 'Vendor Advance', payee: 'ChemSource Pvt Ltd', amt: 300000, due: addDays(6), status: 'function_approved' },
    { module: 'regulatory', sub: 'Filing Fee', payee: 'Registrar of Companies', amt: 45000, due: addDays(3), status: 'treasury_approved' },
    { module: 'hr', sub: 'Monthly Salary Disbursement', payee: 'Payroll (Jul)', amt: 2500000, due: addDays(2), status: 'scheduled', sched: addDays(2) },
    { module: 'statutory', sub: 'Monthly GST', payee: 'GST — Govt of India', amt: 380000, due: addDays(1), status: 'scheduled', sched: addDays(1) },
    { module: 'operating', sub: 'Factory Rent', payee: 'Prestige Estates', amt: 150000, due: addDays(-2), status: 'reconciled', utr: 'UTR8891', mode: 'neft' },
    { module: 'quality', sub: '3rd-Party Testing PO', payee: 'SGS Labs', amt: 60000, due: addDays(5), status: 'submitted' },
    { module: 'capex', sub: 'Equipment Purchase', payee: 'Bosch Packaging', amt: 4000000, due: addDays(9), status: 'submitted', capex: true },
    { module: 'warehouse', sub: 'Transport Invoice', payee: 'BlueDart Logistics', amt: 85000, due: addDays(7), status: 'draft' },
    { module: 'fulfillment', sub: 'Sales Agent Commission', payee: 'North Zone Agents', amt: 120000, due: addDays(8), status: 'submitted' },
    { module: 'manual', sub: 'Ad-hoc', payee: 'Petty Vendor', amt: 40000, due: addDays(3), status: 'on_hold' },
    { module: 'bd', sub: 'Client Hospitality', payee: 'Taj Hotels', amt: 25000, due: addDays(-1), status: 'reconciled', utr: 'UTR7742', mode: 'upi' },
  ];
  let overrideRef = null;
  for (const r of rows) {
    const chain = approvalChainFor(r.amt, !!r.capex);
    // eslint-disable-next-line no-await-in-loop
    const p = await TreasuryOutwardPayment.create({
      outward_code: outCode(), source_module: r.module, source_subtype: r.sub,
      payee_type: r.module === 'statutory' ? 'govt' : r.module === 'hr' ? 'employee' : 'vendor',
      payee_name: r.payee, purpose: r.sub, gross_amount: r.amt, tds_amount: 0, net_amount: r.amt, currency: 'INR',
      due_date: r.due, scheduled_date: r.sched || null, status: r.status, approval_tier: chain.tier,
      required_chain: { roles: chain.roles, tier: chain.tier, boardMinute: chain.boardMinute }, is_capex: !!r.capex,
      gate_verdict: r.capex ? 'tight' : 'safe', bank_account_id: HDFC, mode: r.mode || null, utr_reference: r.utr || null,
      paid_at: r.status === 'reconciled' ? nowIso() : null, reconciled_at: r.status === 'reconciled' ? nowIso() : null,
    });
    if (r.status !== 'draft') {
      // eslint-disable-next-line no-await-in-loop
      for (const a of approvalsForStatus(chain, r.status)) await TreasuryApproval.create({ outward_payment_id: p.id, ...a });
    }
    if (r.capex) overrideRef = p;
  }
  if (overrideRef) {
    await TreasuryGateOverride.create({ action_type: 'outward_approve', ref_type: 'outward_payment', ref_id: overrideRef.id, ref_code: overrideRef.outward_code, projected_lowest_before: 2_800_000, projected_lowest_after: 900_000, threshold: 1_000_000, amount: 4_000_000, reason: 'Board-approved capex — bridge via OD', approver_name: 'CFO (demo)' });
  }
}

async function seedInward(bankId, clients) {
  const HDFC = bankId['HDFC-5550']; const ICICI = bankId['ICICI-8801'];
  const byName = Object.fromEntries(clients.map((c) => [c.name, c]));
  const C = (n) => byName[n] || { id: null, name: n };
  const mk = async (o) => {
    const net = o.net ?? o.amt;
    const row = await TreasuryInwardPayment.create({
      inward_code: inCode(), type: o.type || 'invoice', client_id: o.client.id, client_name: o.client.name,
      expected_date: o.exp, original_expected_date: o.orig || o.exp, expected_amount: o.amt,
      invoice_amount: o.type === 'advance' ? 0 : (o.invAmt ?? o.amt), advance_amount: o.advAmt || 0,
      expected_tds_percent: o.tdsPct || 0, expected_tds_amount: o.amt - net, net_expected_amount: net, currency: 'INR',
      mode: o.mode || 'neft', destination_bank_account_id: o.type === 'advance' ? ICICI : HDFC, status: o.status,
      reschedule_count: o.rescheduleCount || 0, advance_against: o.advAgainst || null, actual_date: o.actualDate || null,
      actual_amount: o.actualAmt || 0, utr_reference: o.utr || null, receiving_bank_account_id: o.status === 'reconciled' ? HDFC : null,
      variance_amount: o.variance || 0, confirmed_at: o.status === 'reconciled' ? nowIso() : null, reconciled_at: o.status === 'reconciled' ? nowIso() : null, hold_reason: o.holdReason || null,
    });
    if (o.invNo) await TreasuryInwardInvoice.create({ inward_payment_id: row.id, invoice_no: o.invNo, amount_applied: o.invAmt ?? o.amt });
    if (o.type === 'advance' || o.advAmt) await TreasuryAdvance.create({ client_id: o.client.id, client_name: o.client.name, source_inward_id: row.id, bank_account_id: ICICI, amount: o.advAmt || o.amt, balance_amount: o.advAmt || o.amt, advance_against: o.advAgainst || 'Next SO', status: 'held' });
    if (o.tdsReceivable) await TreasuryTdsReceivable.create({ inward_payment_id: row.id, client_id: o.client.id, client_name: o.client.name, amount: o.tdsReceivable, tds_quarter: 'Q2 FY27', tds_section: '194Q', status: 'pending' });
    if (o.status === 'rescheduled') await TreasuryRescheduleHistory.create({ inward_payment_id: row.id, old_date: o.orig, new_date: o.exp, delay_days: 12, reason_category: 'Client request — temporary cashflow constraint', source: 'Email — client CFO', gate_verdict: 'tight', gate_lowest_before: 2_400_000, gate_lowest_after: 1_900_000 });
    return row;
  };
  await mk({ client: C('Phoenix Pharma'), type: 'invoice', amt: 1_200_000, net: 1_080_000, tdsPct: 10, exp: addDays(0), status: 'expected', invNo: 'INV-2607', invAmt: 1_200_000 });
  await mk({ client: C('Radiant Cosmetics'), type: 'invoice', amt: 800_000, exp: addDays(-5), status: 'expected', invNo: 'INV-2588' });
  await mk({ client: C('SkinKraft Labs'), type: 'invoice', amt: 1_500_000, exp: addDays(-12), status: 'expected', invNo: 'INV-2571' });
  await mk({ client: C('Aura Wellness'), type: 'invoice', amt: 450_000, exp: addDays(3), status: 'expected', invNo: 'INV-2620' });
  await mk({ client: C('Phoenix Pharma'), type: 'advance', amt: 500_000, advAmt: 500_000, exp: addDays(5), status: 'expected', advAgainst: 'Booking BK-0912' });
  await mk({ client: C('Metro Distributors'), type: 'mixed', amt: 500_000, invAmt: 300_000, advAmt: 200_000, exp: addDays(7), status: 'expected', invNo: 'INV-2631', advAgainst: 'Q3 order' });
  await mk({ client: C('Zenith Retail'), type: 'invoice', amt: 600_000, exp: addDays(14), orig: addDays(2), status: 'rescheduled', rescheduleCount: 1, invNo: 'INV-2599' });
  await mk({ client: C('Radiant Cosmetics'), type: 'invoice', amt: 250_000, exp: addDays(6), status: 'partial', invNo: 'INV-2588-R' });
  await mk({ client: C('SkinKraft Labs'), type: 'invoice', amt: 900_000, net: 810_000, tdsPct: 10, exp: addDays(-3), status: 'reconciled', actualDate: addDays(-2), actualAmt: 810_000, utr: 'UTR5521', variance: 90_000, tdsReceivable: 90_000, invNo: 'INV-2540' });
  await mk({ client: C('Aura Wellness'), type: 'invoice', amt: 350_000, exp: addDays(-6), status: 'reconciled', actualDate: addDays(-5), actualAmt: 350_000, utr: 'UTR5498', invNo: 'INV-2533' });
  await mk({ client: C('Metro Distributors'), type: 'invoice', amt: 180_000, exp: addDays(-1), status: 'on_hold', holdReason: 'Client dispute on quantity', invNo: 'INV-2618' });
  if (BdEvent) {
    for (const c of clients.slice(0, 3)) await BdEvent.create({ client_id: c.id, type: 'treasury', title: 'Treasury: receivable activity (demo)', body: 'Seeded demo event.', ref_type: 'TreasuryInward', actor_name: 'Treasury' });
  }
}

async function seedRecurring(bankId) {
  const HDFC = bankId['HDFC-5550'];
  const rows = [
    { desc: 'Office Rent — HQ', module: 'operating', payee: 'Prestige Estates', amt: 150000, cadence: 'monthly', auto: true },
    { desc: 'Factory Rent — Unit 2', module: 'operating', payee: 'Ascendas', amt: 220000, cadence: 'monthly', auto: true },
    { desc: 'PF Contribution', module: 'statutory', payee: 'EPFO', amt: 180000, cadence: 'monthly', auto: false },
    { desc: 'Software Subscriptions', module: 'operating', payee: 'SaaS Vendors', amt: 45000, cadence: 'monthly', auto: false },
    { desc: 'Annual Insurance Premium', module: 'operating', payee: 'ICICI Lombard', amt: 600000, cadence: 'annual', auto: false },
  ];
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await TreasuryRecurringPayment.create({ recurring_code: recCode(), description: r.desc, source_module: r.module, payee_name: r.payee, amount: r.amt, cadence: r.cadence, next_due_date: addDays(r.cadence === 'annual' ? 90 : 20), bank_account_id: HDFC, auto_create_state: 'submitted', auto_approve: r.auto, status: 'active' });
  }
}

async function seedMock() {
  await resetMock();
  inSeq = 0; outSeq = 0; recSeq = 0;
  const bankId = await ensureAccounts();
  const clients = await seedClients();
  await seedInward(bankId, clients);
  await seedOutward(bankId);
  await seedRecurring(bankId);
  return {
    inward: await TreasuryInwardPayment.count(),
    outward: await TreasuryOutwardPayment.count(),
    advances: await TreasuryAdvance.count(),
    recurring: await TreasuryRecurringPayment.count(),
    clients: clients.length,
  };
}

module.exports = { seedMock, resetMock };

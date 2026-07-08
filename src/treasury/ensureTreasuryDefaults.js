// ─────────────────────────────────────────────────────────────
// Idempotent baseline seed for Treasury: the 4 EI bank accounts and
// the cashflow-gate settings. Called once per boot (after db.sync).
// Each table is seeded only when the specific row is missing, so it is
// safe on every restart and never overwrites treasury-team edits.
// ─────────────────────────────────────────────────────────────
const { TreasuryBankAccount, TreasurySetting } = require('./models');
const { DEFAULTS } = require('./cashflowGate');

const BANK_ACCOUNTS = [
  {
    account_code: 'HDFC-5550',
    bank_name: 'HDFC Bank',
    account_label: 'HDFC Current · 5550',
    account_number: '5550',
    account_type: 'current',
    purpose: 'Primary operating — most receivables land here; most outflows draw from here',
    overdraft_limit: 0,
    sort_order: 1,
  },
  {
    account_code: 'SBI-1122',
    bank_name: 'State Bank of India',
    account_label: 'SBI Current · 1122',
    account_number: '1122',
    account_type: 'current',
    purpose: 'Backup operating + state government payments',
    overdraft_limit: 0,
    sort_order: 2,
  },
  {
    account_code: 'HDFC-5560',
    bank_name: 'HDFC Bank',
    account_label: 'HDFC OD · 5560',
    account_number: '5560',
    account_type: 'overdraft',
    purpose: 'Working-capital buffer — ₹50L overdraft limit',
    overdraft_limit: 5_000_000,
    sort_order: 3,
  },
  {
    account_code: 'ICICI-8801',
    bank_name: 'ICICI Bank',
    account_label: 'ICICI Current · 8801',
    account_number: '8801',
    account_type: 'escrow',
    purpose: 'Client advances (escrow-like)',
    overdraft_limit: 0,
    sort_order: 4,
  },
];

const SETTINGS = [
  {
    key: 'cashflow_gate_threshold',
    value: { amount: DEFAULTS.cashflow_gate_threshold },
    description: 'Minimum acceptable 30-day projected bank balance (₹). Below this ⇒ gate override required.',
  },
  {
    key: 'cashflow_gate_tight_buffer',
    value: { amount: DEFAULTS.cashflow_gate_tight_buffer },
    description: 'Balance within this buffer above the threshold is flagged "tight" (amber).',
  },
  {
    key: 'cashflow_horizon_days',
    value: { days: DEFAULTS.cashflow_horizon_days },
    description: 'Forward window (days) the cashflow gate projects over.',
  },
  {
    key: 'inward_writeoff_auto_limit',
    value: { amount: 500 },
    description: 'Receipt variance at or below this (₹) auto-approves as a write-off without CFO sign-off.',
  },
];

async function ensureTreasuryDefaults() {
  for (const acct of BANK_ACCOUNTS) {
    await TreasuryBankAccount.findOrCreate({
      where: { account_code: acct.account_code },
      defaults: acct,
    });
  }
  for (const s of SETTINGS) {
    await TreasurySetting.findOrCreate({
      where: { key: s.key },
      defaults: s,
    });
  }
}

module.exports = { ensureTreasuryDefaults, BANK_ACCOUNTS, SETTINGS };

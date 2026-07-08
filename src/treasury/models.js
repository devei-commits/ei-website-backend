/**
 * Treasury data model — working-capital command center.
 *
 * Tables (all prefixed `treasury_`):
 *   treasury_bank_accounts      EI's 4 bank accounts + live balance / OD limit
 *   treasury_settings           key/value config (gate threshold, SLA hours, ...)
 *   treasury_inward_payments    receivables (INVOICE / ADVANCE / MIXED) + confirm/reconcile
 *   treasury_inward_invoices    join: an inward payment ↔ one/many fulfillment_invoices
 *   treasury_inward_variances   variance allocation on confirm (TDS / bank charges / ...)
 *   treasury_reschedule_history reschedule audit + gate snapshot for an inward
 *   treasury_advances           client advance ledger (held until adjusted vs an invoice)
 *   treasury_tds_receivables    TDS deducted by clients, claimable per quarter
 *   treasury_outward_payments   payables from every source module + manual
 *   treasury_approvals          per-step approval chain for an outward payment
 *   treasury_recurring_payments standing orders that spawn outward payments on cadence
 *   treasury_gate_overrides     logged cashflow-gate overrides → monthly Cash-Risk report
 *   treasury_bank_statements    imported statement lines for UTR auto-match
 *   treasury_audit_log          generic treasury event log
 *
 * Schema is materialized by `db.sync({ alter: true })` (app.js) — no SQL migrations.
 * Money: DECIMAL(16,2). Dates: DATEONLY. Timestamps auto-managed by backendTimestamps hooks.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

const MONEY = { type: DataTypes.DECIMAL(16, 2), allowNull: true, defaultValue: 0 };
const AUDIT_COLS = {
  created_at: { type: DataTypes.DATE, allowNull: true },
  updated_at: { type: DataTypes.DATE, allowNull: true },
  deleted_at: { type: DataTypes.DATE, allowNull: true },
  lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
};
const baseOpts = (modelName, tableName) => ({
  sequelize: db,
  modelName,
  tableName,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

/* ─────────────────────────── Bank Accounts ─────────────────────────── */

class TreasuryBankAccount extends Model {}
TreasuryBankAccount.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    account_code: { type: DataTypes.STRING(40), allowNull: false, unique: true }, // e.g. HDFC-5550
    bank_name: { type: DataTypes.STRING(120), allowNull: false },
    account_label: { type: DataTypes.STRING(160), allowNull: true }, // "HDFC Current · 5550"
    account_number: { type: DataTypes.STRING(40), allowNull: true },
    // current | overdraft | escrow
    account_type: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'current' },
    purpose: { type: DataTypes.STRING(300), allowNull: true },
    current_balance: { ...MONEY }, // last known / imported balance
    overdraft_limit: { ...MONEY }, // ₹0 unless OD account
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sort_order: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
    ...AUDIT_COLS,
  },
  baseOpts('TreasuryBankAccount', 'treasury_bank_accounts')
);

/* ─────────────────────────── Settings (key/value) ─────────────────────────── */

class TreasurySetting extends Model {}
TreasurySetting.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    key: { type: DataTypes.STRING(120), allowNull: false, unique: true },
    value: { type: DataTypes.JSONB, allowNull: true }, // { amount: 1000000 } etc.
    description: { type: DataTypes.STRING(300), allowNull: true },
    ...AUDIT_COLS,
  },
  baseOpts('TreasurySetting', 'treasury_settings')
);

/* ─────────────────────────── Inward Payments (receivables) ─────────────────────────── */

class TreasuryInwardPayment extends Model {}
TreasuryInwardPayment.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    inward_code: { type: DataTypes.STRING(40), allowNull: false, unique: true }, // IN-2026-0098
    // invoice | advance | mixed
    type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'invoice' },
    client_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'vendor_clients', key: 'id' },
      onDelete: 'SET NULL',
    },
    client_name: { type: DataTypes.STRING(300), allowNull: true }, // snapshot
    bd_poc_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'users', key: 'userid' },
      onDelete: 'SET NULL',
    },

    // ── Expected ──
    expected_date: { type: DataTypes.DATEONLY, allowNull: true },
    original_expected_date: { type: DataTypes.DATEONLY, allowNull: true }, // preserved on reschedule
    expected_amount: { ...MONEY }, // gross expected
    invoice_amount: { ...MONEY }, // portion against invoice(s) (mixed)
    advance_amount: { ...MONEY }, // advance portion (advance/mixed)
    expected_tds_percent: { type: DataTypes.DECIMAL(5, 2), allowNull: true, defaultValue: 0 },
    expected_tds_amount: { ...MONEY },
    net_expected_amount: { ...MONEY }, // expected_amount - expected_tds_amount
    currency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'INR' },
    mode: { type: DataTypes.STRING(20), allowNull: true }, // neft|rtgs|imps|upi|cheque
    destination_bank_account_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'treasury_bank_accounts', key: 'id' },
      onDelete: 'SET NULL',
    },

    // ── Advance-specific ──
    advance_against: { type: DataTypes.STRING(300), allowNull: true }, // booking/project ref
    adjustable_on: { type: DataTypes.STRING(300), allowNull: true }, // "Next Sales Order invoice"

    // ── Commitment proof ──
    commitment_basis: { type: DataTypes.STRING(120), allowNull: true }, // email/whatsapp/verbal
    commitment_attachment_url: { type: DataTypes.STRING(1000), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },

    // ── Status ──
    // expected|confirmed|reconciled|rescheduled|partial|on_hold|write_off|cancelled
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'expected' },
    reschedule_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    parent_inward_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'treasury_inward_payments', key: 'id' },
      onDelete: 'SET NULL',
    }, // set on the PARTIAL remainder split off from a parent

    // ── Confirmed / actual ──
    actual_date: { type: DataTypes.DATEONLY, allowNull: true },
    actual_amount: { ...MONEY },
    actual_mode: { type: DataTypes.STRING(20), allowNull: true },
    utr_reference: { type: DataTypes.STRING(120), allowNull: true },
    receiving_bank_account_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'treasury_bank_accounts', key: 'id' },
      onDelete: 'SET NULL',
    },
    variance_amount: { ...MONEY }, // expected_amount - actual_amount (>0 = short)
    variance_days: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
    statement_matched: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    confirmed_at: { type: DataTypes.DATE, allowNull: true },
    confirmed_by_id: { type: DataTypes.INTEGER, allowNull: true },
    reconciled_at: { type: DataTypes.DATE, allowNull: true },

    // ── Hold / write-off / cancel ──
    hold_reason: { type: DataTypes.STRING(500), allowNull: true },
    write_off_amount: { ...MONEY },
    write_off_reason: { type: DataTypes.STRING(500), allowNull: true },
    write_off_approved_by_id: { type: DataTypes.INTEGER, allowNull: true },

    created_by_id: { type: DataTypes.INTEGER, allowNull: true },
    ...AUDIT_COLS,
  },
  baseOpts('TreasuryInwardPayment', 'treasury_inward_payments')
);

class TreasuryInwardInvoice extends Model {}
TreasuryInwardInvoice.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    inward_payment_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'treasury_inward_payments', key: 'id' },
      onDelete: 'CASCADE',
    },
    fulfillment_invoice_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'fulfillment_invoices', key: 'id' },
      onDelete: 'SET NULL',
    },
    invoice_no: { type: DataTypes.STRING(100), allowNull: true }, // snapshot
    amount_applied: { ...MONEY },
    ...AUDIT_COLS,
  },
  baseOpts('TreasuryInwardInvoice', 'treasury_inward_invoices')
);

class TreasuryInwardVariance extends Model {}
TreasuryInwardVariance.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    inward_payment_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'treasury_inward_payments', key: 'id' },
      onDelete: 'CASCADE',
    },
    // tds | bank_charges | short_payment_dispute | write_off | other
    reason: { type: DataTypes.STRING(40), allowNull: false },
    amount: { ...MONEY },
    note: { type: DataTypes.STRING(500), allowNull: true },
    // TDS-only enrichment
    tds_quarter: { type: DataTypes.STRING(20), allowNull: true }, // "Q1 FY27"
    tds_section: { type: DataTypes.STRING(20), allowNull: true }, // "194Q"
    form16a_url: { type: DataTypes.STRING(1000), allowNull: true },
    created_by_id: { type: DataTypes.INTEGER, allowNull: true },
    ...AUDIT_COLS,
  },
  baseOpts('TreasuryInwardVariance', 'treasury_inward_variances')
);

class TreasuryRescheduleHistory extends Model {}
TreasuryRescheduleHistory.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    inward_payment_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'treasury_inward_payments', key: 'id' },
      onDelete: 'CASCADE',
    },
    old_date: { type: DataTypes.DATEONLY, allowNull: true },
    new_date: { type: DataTypes.DATEONLY, allowNull: true },
    delay_days: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
    reason_category: { type: DataTypes.STRING(120), allowNull: true },
    source: { type: DataTypes.STRING(120), allowNull: true }, // email/whatsapp/phone
    notes: { type: DataTypes.TEXT, allowNull: true },
    attachment_url: { type: DataTypes.STRING(1000), allowNull: true },
    // gate snapshot at reschedule time
    gate_verdict: { type: DataTypes.STRING(10), allowNull: true }, // safe|tight|over
    gate_lowest_before: { ...MONEY },
    gate_lowest_after: { ...MONEY },
    override_reason: { type: DataTypes.STRING(500), allowNull: true },
    created_by_id: { type: DataTypes.INTEGER, allowNull: true },
    ...AUDIT_COLS,
  },
  baseOpts('TreasuryRescheduleHistory', 'treasury_reschedule_history')
);

/* ─────────────────────────── Advances ledger ─────────────────────────── */

class TreasuryAdvance extends Model {}
TreasuryAdvance.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    client_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'vendor_clients', key: 'id' },
      onDelete: 'SET NULL',
    },
    client_name: { type: DataTypes.STRING(300), allowNull: true },
    source_inward_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'treasury_inward_payments', key: 'id' },
      onDelete: 'SET NULL',
    },
    bank_account_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'treasury_bank_accounts', key: 'id' },
      onDelete: 'SET NULL',
    }, // ICICI escrow
    amount: { ...MONEY },
    balance_amount: { ...MONEY }, // unadjusted remainder
    advance_against: { type: DataTypes.STRING(300), allowNull: true },
    adjustable_on: { type: DataTypes.STRING(300), allowNull: true },
    // held | partially_adjusted | adjusted
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'held' },
    ...AUDIT_COLS,
  },
  baseOpts('TreasuryAdvance', 'treasury_advances')
);

/* ─────────────────────────── TDS receivables ─────────────────────────── */

class TreasuryTdsReceivable extends Model {}
TreasuryTdsReceivable.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    inward_payment_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'treasury_inward_payments', key: 'id' },
      onDelete: 'SET NULL',
    },
    client_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'vendor_clients', key: 'id' },
      onDelete: 'SET NULL',
    },
    client_name: { type: DataTypes.STRING(300), allowNull: true },
    amount: { ...MONEY },
    tds_quarter: { type: DataTypes.STRING(20), allowNull: true }, // "Q1 FY27"
    tds_section: { type: DataTypes.STRING(20), allowNull: true },
    form16a_url: { type: DataTypes.STRING(1000), allowNull: true },
    // pending | form_received | claimed
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'pending' },
    ...AUDIT_COLS,
  },
  baseOpts('TreasuryTdsReceivable', 'treasury_tds_receivables')
);

/* ─────────────────────────── Outward Payments (payables) ─────────────────────────── */

class TreasuryOutwardPayment extends Model {}
TreasuryOutwardPayment.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    outward_code: { type: DataTypes.STRING(40), allowNull: false, unique: true }, // OUT-2026-0001
    // procurement|regulatory|quality|hr|statutory|operating|warehouse|fulfillment|bd|production|capex|manual
    source_module: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'manual' },
    source_subtype: { type: DataTypes.STRING(120), allowNull: true }, // "PO Vendor Payment"
    // back-link to originating document in its source module
    source_ref_type: { type: DataTypes.STRING(60), allowNull: true }, // e.g. purchase_order
    source_ref_id: { type: DataTypes.INTEGER, allowNull: true },
    source_ref_label: { type: DataTypes.STRING(200), allowNull: true }, // "PO-2026-0187"

    // ── Payee ──
    payee_type: { type: DataTypes.STRING(20), allowNull: true }, // vendor|employee|govt|other
    payee_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'vendor_clients', key: 'id' },
      onDelete: 'SET NULL',
    },
    payee_name: { type: DataTypes.STRING(300), allowNull: true },
    purpose: { type: DataTypes.STRING(500), allowNull: true },

    // ── Amount ──
    gross_amount: { ...MONEY },
    tds_percent: { type: DataTypes.DECIMAL(5, 2), allowNull: true, defaultValue: 0 },
    tds_amount: { ...MONEY },
    net_amount: { ...MONEY }, // actual disbursed amount (gate uses this)
    currency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'INR' },
    due_date: { type: DataTypes.DATEONLY, allowNull: true },
    scheduled_date: { type: DataTypes.DATEONLY, allowNull: true }, // calendar slot

    // ── Status / approval ──
    // draft|submitted|function_approved|treasury_approved|admin_approved|scheduled|paid|reconciled|on_hold|rejected
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'draft' },
    approval_tier: { type: DataTypes.STRING(60), allowNull: true }, // computed band label
    required_chain: { type: DataTypes.JSONB, allowNull: true }, // ordered roles snapshot
    is_capex: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    auto_approved: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    // ── Gate ──
    gate_verdict: { type: DataTypes.STRING(10), allowNull: true }, // safe|tight|over

    // ── Execution ──
    bank_account_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'treasury_bank_accounts', key: 'id' },
      onDelete: 'SET NULL',
    },
    mode: { type: DataTypes.STRING(20), allowNull: true },
    utr_reference: { type: DataTypes.STRING(120), allowNull: true },
    paid_at: { type: DataTypes.DATE, allowNull: true },
    executed_by_id: { type: DataTypes.INTEGER, allowNull: true },
    reconciled_at: { type: DataTypes.DATE, allowNull: true },

    // ── Origin ──
    recurring_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'treasury_recurring_payments', key: 'id' },
      onDelete: 'SET NULL',
    },
    hold_reason: { type: DataTypes.STRING(500), allowNull: true },
    reject_reason: { type: DataTypes.STRING(500), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_by_id: { type: DataTypes.INTEGER, allowNull: true },
    ...AUDIT_COLS,
  },
  baseOpts('TreasuryOutwardPayment', 'treasury_outward_payments')
);

class TreasuryApproval extends Model {}
TreasuryApproval.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    outward_payment_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'treasury_outward_payments', key: 'id' },
      onDelete: 'CASCADE',
    },
    level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 }, // order in chain
    // function_head | treasury_officer | cfo | admin
    role_required: { type: DataTypes.STRING(30), allowNull: false },
    approver_id: { type: DataTypes.INTEGER, allowNull: true }, // filled on action
    approver_name: { type: DataTypes.STRING(200), allowNull: true },
    // pending | approved | rejected | skipped
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
    reason: { type: DataTypes.STRING(500), allowNull: true },
    gate_verdict_at_action: { type: DataTypes.STRING(10), allowNull: true },
    override_reason: { type: DataTypes.STRING(500), allowNull: true },
    sla_due_at: { type: DataTypes.DATE, allowNull: true },
    acted_at: { type: DataTypes.DATE, allowNull: true },
    ...AUDIT_COLS,
  },
  baseOpts('TreasuryApproval', 'treasury_approvals')
);

/* ─────────────────────────── Recurring payments ─────────────────────────── */

class TreasuryRecurringPayment extends Model {}
TreasuryRecurringPayment.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    recurring_code: { type: DataTypes.STRING(40), allowNull: false, unique: true }, // REC-0001
    description: { type: DataTypes.STRING(300), allowNull: false },
    source_module: { type: DataTypes.STRING(30), allowNull: true },
    source_subtype: { type: DataTypes.STRING(120), allowNull: true },
    payee_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'vendor_clients', key: 'id' },
      onDelete: 'SET NULL',
    },
    payee_name: { type: DataTypes.STRING(300), allowNull: true },
    amount: { ...MONEY },
    cadence: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'monthly' }, // monthly|quarterly|annual
    next_due_date: { type: DataTypes.DATEONLY, allowNull: true },
    last_generated_date: { type: DataTypes.DATEONLY, allowNull: true },
    bank_account_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'treasury_bank_accounts', key: 'id' },
      onDelete: 'SET NULL',
    },
    // draft | submitted  — state the auto-generated OUT entry is created in
    auto_create_state: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
    auto_approve: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // active | paused | cancelled
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
    created_by_id: { type: DataTypes.INTEGER, allowNull: true },
    ...AUDIT_COLS,
  },
  baseOpts('TreasuryRecurringPayment', 'treasury_recurring_payments')
);

/* ─────────────────────────── Gate overrides (Cash-Risk report) ─────────────────────────── */

class TreasuryGateOverride extends Model {}
TreasuryGateOverride.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    // outward_approve | outward_execute | inward_reschedule | schedule_move
    action_type: { type: DataTypes.STRING(30), allowNull: false },
    ref_type: { type: DataTypes.STRING(40), allowNull: true }, // outward_payment | inward_payment
    ref_id: { type: DataTypes.INTEGER, allowNull: true },
    ref_code: { type: DataTypes.STRING(40), allowNull: true }, // OUT-.. / IN-..
    projected_lowest_before: { ...MONEY },
    projected_lowest_after: { ...MONEY },
    threshold: { ...MONEY },
    amount: { ...MONEY },
    reason: { type: DataTypes.STRING(500), allowNull: false },
    approver_id: { type: DataTypes.INTEGER, allowNull: true },
    approver_name: { type: DataTypes.STRING(200), allowNull: true },
    ...AUDIT_COLS,
  },
  baseOpts('TreasuryGateOverride', 'treasury_gate_overrides')
);

/* ─────────────────────────── Bank statement lines (UTR match) ─────────────────────────── */

class TreasuryBankStatement extends Model {}
TreasuryBankStatement.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    bank_account_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'treasury_bank_accounts', key: 'id' },
      onDelete: 'SET NULL',
    },
    txn_date: { type: DataTypes.DATEONLY, allowNull: true },
    direction: { type: DataTypes.STRING(10), allowNull: true }, // credit | debit
    amount: { ...MONEY },
    utr_reference: { type: DataTypes.STRING(120), allowNull: true },
    narration: { type: DataTypes.STRING(500), allowNull: true },
    matched_inward_id: { type: DataTypes.INTEGER, allowNull: true },
    matched_outward_id: { type: DataTypes.INTEGER, allowNull: true },
    // unmatched | matched | ignored
    match_status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'unmatched' },
    raw: { type: DataTypes.JSONB, allowNull: true },
    ...AUDIT_COLS,
  },
  baseOpts('TreasuryBankStatement', 'treasury_bank_statements')
);

/* ─────────────────────────── Audit log ─────────────────────────── */

class TreasuryAuditLog extends Model {}
TreasuryAuditLog.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    entity_type: { type: DataTypes.STRING(40), allowNull: false }, // inward_payment | outward_payment | ...
    entity_id: { type: DataTypes.INTEGER, allowNull: true },
    entity_code: { type: DataTypes.STRING(40), allowNull: true },
    action: { type: DataTypes.STRING(60), allowNull: false }, // created | confirmed | rescheduled | approved | ...
    actor_id: { type: DataTypes.INTEGER, allowNull: true },
    actor_name: { type: DataTypes.STRING(200), allowNull: true },
    details: { type: DataTypes.JSONB, allowNull: true },
    ...AUDIT_COLS,
  },
  baseOpts('TreasuryAuditLog', 'treasury_audit_log')
);

/* ─────────────────────────── Associations ─────────────────────────── */

TreasuryInwardPayment.belongsTo(TreasuryBankAccount, { as: 'destinationBank', foreignKey: 'destination_bank_account_id' });
TreasuryInwardPayment.belongsTo(TreasuryBankAccount, { as: 'receivingBank', foreignKey: 'receiving_bank_account_id' });
TreasuryInwardPayment.hasMany(TreasuryInwardInvoice, { as: 'invoiceLinks', foreignKey: 'inward_payment_id' });
TreasuryInwardPayment.hasMany(TreasuryInwardVariance, { as: 'variances', foreignKey: 'inward_payment_id' });
TreasuryInwardPayment.hasMany(TreasuryRescheduleHistory, { as: 'reschedules', foreignKey: 'inward_payment_id' });
TreasuryInwardPayment.belongsTo(TreasuryInwardPayment, { as: 'parent', foreignKey: 'parent_inward_id' });

TreasuryInwardInvoice.belongsTo(TreasuryInwardPayment, { as: 'inward', foreignKey: 'inward_payment_id' });
TreasuryInwardVariance.belongsTo(TreasuryInwardPayment, { as: 'inward', foreignKey: 'inward_payment_id' });
TreasuryRescheduleHistory.belongsTo(TreasuryInwardPayment, { as: 'inward', foreignKey: 'inward_payment_id' });

TreasuryAdvance.belongsTo(TreasuryInwardPayment, { as: 'sourceInward', foreignKey: 'source_inward_id' });
TreasuryTdsReceivable.belongsTo(TreasuryInwardPayment, { as: 'inward', foreignKey: 'inward_payment_id' });

TreasuryOutwardPayment.belongsTo(TreasuryBankAccount, { as: 'bankAccount', foreignKey: 'bank_account_id' });
TreasuryOutwardPayment.hasMany(TreasuryApproval, { as: 'approvals', foreignKey: 'outward_payment_id' });
TreasuryOutwardPayment.belongsTo(TreasuryRecurringPayment, { as: 'recurring', foreignKey: 'recurring_id' });
TreasuryApproval.belongsTo(TreasuryOutwardPayment, { as: 'outward', foreignKey: 'outward_payment_id' });
TreasuryRecurringPayment.hasMany(TreasuryOutwardPayment, { as: 'generated', foreignKey: 'recurring_id' });

module.exports = {
  TreasuryBankAccount,
  TreasurySetting,
  TreasuryInwardPayment,
  TreasuryInwardInvoice,
  TreasuryInwardVariance,
  TreasuryRescheduleHistory,
  TreasuryAdvance,
  TreasuryTdsReceivable,
  TreasuryOutwardPayment,
  TreasuryApproval,
  TreasuryRecurringPayment,
  TreasuryGateOverride,
  TreasuryBankStatement,
  TreasuryAuditLog,
};

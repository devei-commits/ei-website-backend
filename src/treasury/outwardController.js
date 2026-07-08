/**
 * Treasury — Outward Payments (Payables) API.  Spec View 3 + Approvals Inbox (View 4).
 *
 * Endpoints (mounted under /api/v1/treasury):
 *   GET   /outward-payments                    list + summary (filters)
 *   GET   /outward-payments/:id                detail + approval chain + timeline
 *   POST  /outward-payments                    record (manual/source); optional submit+autoApprove
 *   POST  /outward-payments/:id/submit         draft → submitted (builds approval chain)
 *   POST  /outward-payments/:id/approve        approve next (or given) step — gate-checked
 *   POST  /outward-payments/:id/reject         reject at current step
 *   POST  /outward-payments/:id/hold           put on hold
 *   POST  /outward-payments/:id/schedule       set a calendar date (requires fully approved)
 *   POST  /outward-payments/:id/execute        pay: capture UTR — gate-checked
 *   POST  /outward-payments/:id/preview-gate   gate impact for this payment (no write)
 *   POST  /outward-payments/bulk-approve       approve many safe/approved rows
 *   GET   /approvals                           inbox: rows awaiting approval (optional ?role=)
 *
 * Approval chain by amount band (uses net_amount):
 *   < ₹10k                → [treasury_officer]
 *   ₹10k–₹50k             → [function_head, treasury_officer]
 *   ₹50k–₹2L              → [function_head, cfo]
 *   ₹2L–₹10L              → [function_head, cfo, admin]
 *   > ₹10L or any CAPEX   → [function_head, cfo, admin] + board minute logged offline
 * The cashflow gate overlays the whole matrix: an "over" verdict forces an override
 * (logged to treasury_gate_overrides → Cash-Risk report) at both approve and execute.
 */
const { Op } = require('sequelize');
const gate = require('./cashflowGate');
const {
  db, num, round2, plain, codeYear, nextSequentialCode, retryOnUniqueViolation,
  writeAudit, dayDiff,
} = require('./helpers');
const {
  createOutwardSchema, approveOutwardSchema, rejectOutwardSchema, holdOutwardSchema,
  scheduleOutwardSchema, executeOutwardSchema, bulkApproveSchema,
} = require('./schemas');
const {
  TreasuryOutwardPayment, TreasuryApproval, TreasuryGateOverride, TreasuryBankAccount,
} = require('./models');

const validationError = (res, error) =>
  res.status(400).json({ error: error.details ? error.details[0].message : String(error) });

const IN_APPROVAL = ['submitted', 'function_approved', 'treasury_approved', 'admin_approved'];

/* ─────────────────────────── Approval chain ─────────────────────────── */

/** Ordered role chain + tier label for an amount band (net amount / CAPEX). */
function approvalChainFor(amount, isCapex) {
  const a = num(amount);
  if (isCapex || a >= 1_000_000) return { roles: ['function_head', 'cfo', 'admin'], tier: '> ₹10L / CAPEX', boardMinute: true };
  if (a >= 200_000) return { roles: ['function_head', 'cfo', 'admin'], tier: '₹2L–₹10L', boardMinute: false };
  if (a >= 50_000) return { roles: ['function_head', 'cfo'], tier: '₹50k–₹2L', boardMinute: false };
  if (a >= 10_000) return { roles: ['function_head', 'treasury_officer'], tier: '₹10k–₹50k', boardMinute: false };
  return { roles: ['treasury_officer'], tier: '< ₹10k', boardMinute: false };
}

/** Canonical status from the set of approved roles (monotonic: function < treasury < admin). */
function statusFromApprovals(approvals) {
  const approved = approvals.filter((a) => plain(a).status === 'approved').map((a) => plain(a).role_required);
  if (approved.includes('admin')) return 'admin_approved';
  if (approved.some((r) => r === 'cfo' || r === 'treasury_officer')) return 'treasury_approved';
  if (approved.includes('function_head')) return 'function_approved';
  return 'submitted';
}
const allApproved = (approvals) => approvals.length > 0 && approvals.every((a) => plain(a).status === 'approved');

/* ─────────────────────────── Gate helper ─────────────────────────── */

/** Gate impact of THIS payment executing on its scheduled/due date (excludes itself from the base). */
async function computeOutwardGate(paymentPlain) {
  const date = gate.dayKey(paymentPlain.scheduled_date) || gate.dayKey(paymentPlain.due_date) || gate.today();
  const amount = num(paymentPlain.net_amount) || num(paymentPlain.gross_amount);
  return gate.evaluateGate({ excludeOutwardIds: [paymentPlain.id], after: { addOutflows: [{ date, amount }] } });
}

/* ─────────────────────────── Formatting ─────────────────────────── */

function formatApproval(a) {
  const d = plain(a);
  return {
    id: d.id, level: d.level, roleRequired: d.role_required, status: d.status,
    approverId: d.approver_id, approverName: d.approver_name, reason: d.reason,
    gateVerdictAtAction: d.gate_verdict_at_action, overrideReason: d.override_reason,
    slaDueAt: d.sla_due_at, actedAt: d.acted_at,
  };
}

function formatOutwardRow(row) {
  const d = plain(row);
  const approvals = (d.approvals || []).slice().sort((x, y) => plain(x).level - plain(y).level);
  const nextPending = approvals.find((a) => plain(a).status === 'pending');
  return {
    id: d.id,
    outwardCode: d.outward_code,
    sourceModule: d.source_module,
    sourceSubtype: d.source_subtype,
    sourceRef: d.source_ref_id || d.source_ref_label ? { type: d.source_ref_type, id: d.source_ref_id, label: d.source_ref_label } : null,
    payee: { type: d.payee_type, id: d.payee_id, name: d.payee_name },
    purpose: d.purpose,
    grossAmount: num(d.gross_amount),
    tdsPercent: num(d.tds_percent),
    tdsAmount: num(d.tds_amount),
    netAmount: num(d.net_amount),
    currency: d.currency,
    dueDate: d.due_date,
    scheduledDate: d.scheduled_date,
    status: d.status,
    approvalTier: d.approval_tier,
    requiredChain: d.required_chain || null,
    isCapex: !!d.is_capex,
    autoApproved: !!d.auto_approved,
    gateVerdict: d.gate_verdict,
    bankAccountId: d.bank_account_id,
    mode: d.mode,
    utrReference: d.utr_reference,
    paidAt: d.paid_at,
    reconciledAt: d.reconciled_at,
    recurringId: d.recurring_id,
    holdReason: d.hold_reason,
    rejectReason: d.reject_reason,
    notes: d.notes,
    approvals: approvals.map(formatApproval),
    nextApprovalRole: nextPending ? plain(nextPending).role_required : null,
    fullyApproved: allApproved(approvals),
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

/* ─────────────────────────── List + summary ─────────────────────────── */

async function listOutwardPayments(req, res) {
  try {
    const { sourceModule, sourceSubtype, status, payee, gateVerdict, dueFrom, dueTo } = req.query;
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const where = {};
    if (sourceModule) where.source_module = sourceModule;
    if (sourceSubtype) where.source_subtype = sourceSubtype;
    if (status && status !== 'all') where.status = status;
    if (gateVerdict) where.gate_verdict = gateVerdict;
    if (payee) where.payee_name = { [Op.iLike]: `%${payee}%` };
    if (dueFrom || dueTo) {
      where.due_date = {};
      if (dueFrom) where.due_date[Op.gte] = dueFrom;
      if (dueTo) where.due_date[Op.lte] = dueTo;
    }
    const rows = await TreasuryOutwardPayment.findAll({
      where,
      include: [{ model: TreasuryApproval, as: 'approvals' }],
      order: [['due_date', 'ASC'], ['id', 'ASC']],
      limit,
    });
    const data = rows.map(formatOutwardRow);
    const PENDING_STATES = new Set([...IN_APPROVAL, 'scheduled', 'draft']);
    const summary = {
      totalCount: data.length,
      payableDue: round2(data.filter((r) => PENDING_STATES.has(r.status)).reduce((s, r) => s + r.netAmount, 0)),
      awaitingApprovalCount: data.filter((r) => IN_APPROVAL.includes(r.status)).length,
      scheduledCount: data.filter((r) => r.status === 'scheduled').length,
      paidCount: data.filter((r) => r.status === 'paid' || r.status === 'reconciled').length,
      gateFlaggedCount: data.filter((r) => r.gateVerdict === 'over').length,
    };
    res.json({ data, summary });
  } catch (err) {
    console.error('[treasury] listOutwardPayments error', err);
    res.status(500).json({ error: 'Failed to load outward payments' });
  }
}

async function getOutwardPayment(req, res) {
  try {
    const row = await TreasuryOutwardPayment.findByPk(req.params.id, {
      include: [{ model: TreasuryApproval, as: 'approvals' }],
    });
    if (!row) return res.status(404).json({ error: 'Outward payment not found' });
    res.json(formatOutwardRow(row));
  } catch (err) {
    console.error('[treasury] getOutwardPayment error', err);
    res.status(500).json({ error: 'Failed to load outward payment' });
  }
}

/* ─────────────────────────── Create ─────────────────────────── */

async function createOutwardPayment(req, res) {
  const { error, value } = createOutwardSchema.validate(req.body, { stripUnknown: true });
  if (error) return validationError(res, error);
  try {
    const gross = round2(value.grossAmount);
    const tdsPct = round2(value.tdsPercent || 0);
    const tds = round2((gross * tdsPct) / 100);
    const net = round2(gross - tds);
    const chain = approvalChainFor(net, value.isCapex);
    const submitNow = value.submit || value.autoApprove;

    const created = await retryOnUniqueViolation(() =>
      db.transaction(async (transaction) => {
        const code = await nextSequentialCode(TreasuryOutwardPayment, 'outward_code', 'OUT', codeYear(), 4, transaction);
        const payment = await TreasuryOutwardPayment.create(
          {
            outward_code: code,
            source_module: value.sourceModule,
            source_subtype: value.sourceSubtype || null,
            source_ref_type: value.sourceRefType || null,
            source_ref_id: value.sourceRefId || null,
            source_ref_label: value.sourceRefLabel || null,
            payee_type: value.payeeType || null,
            payee_id: value.payeeId || null,
            payee_name: value.payeeName,
            purpose: value.purpose || null,
            gross_amount: gross,
            tds_percent: tdsPct,
            tds_amount: tds,
            net_amount: net,
            currency: value.currency || 'INR',
            due_date: gate.dayKey(value.dueDate),
            status: submitNow ? 'submitted' : 'draft',
            approval_tier: chain.tier,
            required_chain: { roles: chain.roles, tier: chain.tier, boardMinute: chain.boardMinute },
            is_capex: !!value.isCapex,
            auto_approved: !!value.autoApprove,
            bank_account_id: value.bankAccountId || null,
            notes: value.notes || null,
            created_by_id: req.user ? req.user.id : null,
          },
          { transaction }
        );

        if (submitNow) {
          await buildApprovalRows(payment.id, chain.roles, transaction);
          if (value.autoApprove) {
            await TreasuryApproval.update(
              { status: 'approved', approver_name: 'Auto (recurring)', acted_at: new Date().toISOString() },
              { where: { outward_payment_id: payment.id }, transaction }
            );
            await payment.update({ status: chain.roles.includes('admin') ? 'admin_approved' : 'treasury_approved' }, { transaction });
          }
        }
        await writeAudit({ entityType: 'outward_payment', entityId: payment.id, entityCode: code, action: submitNow ? 'submitted' : 'created', req, details: { net, tier: chain.tier, autoApprove: !!value.autoApprove }, transaction });
        return payment;
      })
    );

    const full = await TreasuryOutwardPayment.findByPk(created.id, { include: [{ model: TreasuryApproval, as: 'approvals' }] });
    res.status(201).json(formatOutwardRow(full));
  } catch (err) {
    console.error('[treasury] createOutwardPayment error', err);
    res.status(500).json({ error: 'Failed to create outward payment' });
  }
}

async function buildApprovalRows(paymentId, roles, transaction) {
  // 72h SLA on the first step, tighter downstream — approximate per spec.
  const now = Date.now();
  const slaHours = { function_head: 72, treasury_officer: 48, cfo: 48, admin: 48 };
  for (let i = 0; i < roles.length; i += 1) {
    await TreasuryApproval.create(
      {
        outward_payment_id: paymentId,
        level: i + 1,
        role_required: roles[i],
        status: 'pending',
        sla_due_at: new Date(now + (slaHours[roles[i]] || 48) * 3_600_000).toISOString(),
      },
      { transaction }
    );
  }
}

/* ─────────────────────────── Submit ─────────────────────────── */

async function submitOutwardPayment(req, res) {
  try {
    const payment = await TreasuryOutwardPayment.findByPk(req.params.id, { include: [{ model: TreasuryApproval, as: 'approvals' }] });
    if (!payment) return res.status(404).json({ error: 'Outward payment not found' });
    const cur = plain(payment);
    if (cur.status !== 'draft') return res.status(409).json({ error: `Only draft payments can be submitted (status "${cur.status}")` });
    const chain = approvalChainFor(num(cur.net_amount), cur.is_capex);
    await db.transaction(async (transaction) => {
      if (!cur.approvals || cur.approvals.length === 0) await buildApprovalRows(payment.id, chain.roles, transaction);
      await payment.update({ status: 'submitted', approval_tier: chain.tier, required_chain: { roles: chain.roles, tier: chain.tier, boardMinute: chain.boardMinute } }, { transaction });
      await writeAudit({ entityType: 'outward_payment', entityId: payment.id, entityCode: cur.outward_code, action: 'submitted', req, details: { tier: chain.tier }, transaction });
    });
    const full = await TreasuryOutwardPayment.findByPk(payment.id, { include: [{ model: TreasuryApproval, as: 'approvals' }] });
    res.json(formatOutwardRow(full));
  } catch (err) {
    console.error('[treasury] submitOutwardPayment error', err);
    res.status(500).json({ error: 'Failed to submit outward payment' });
  }
}

/* ─────────────────────────── Approve / Reject / Hold ─────────────────────────── */

async function approveOutwardPayment(req, res) {
  const { error, value } = approveOutwardSchema.validate(req.body, { stripUnknown: true });
  if (error) return validationError(res, error);
  try {
    const payment = await TreasuryOutwardPayment.findByPk(req.params.id, { include: [{ model: TreasuryApproval, as: 'approvals' }] });
    if (!payment) return res.status(404).json({ error: 'Outward payment not found' });
    const cur = plain(payment);
    if (!IN_APPROVAL.includes(cur.status)) return res.status(409).json({ error: `Cannot approve from status "${cur.status}"` });

    const approvals = (cur.approvals || []).slice().sort((a, b) => a.level - b.level);
    const step = value.level ? approvals.find((a) => a.level === value.level && a.status === 'pending') : approvals.find((a) => a.status === 'pending');
    if (!step) return res.status(409).json({ error: 'No pending approval step' });

    const gateResult = await computeOutwardGate(cur);
    if (gateResult.verdict === 'over' && !value.overrideReason) {
      return res.status(422).json({ error: 'Approving this payment would breach the cashflow gate. An override reason is required.', gate: gateResult });
    }

    await db.transaction(async (transaction) => {
      await TreasuryApproval.update(
        {
          status: 'approved',
          approver_id: req.user ? req.user.id : null,
          approver_name: req.user ? req.user.fullName : null,
          reason: value.note || null,
          gate_verdict_at_action: gateResult.verdict,
          override_reason: value.overrideReason || null,
          acted_at: new Date().toISOString(),
        },
        { where: { id: step.id }, transaction }
      );
      const updated = await TreasuryApproval.findAll({ where: { outward_payment_id: payment.id }, transaction });
      await payment.update({ status: statusFromApprovals(updated), gate_verdict: gateResult.verdict }, { transaction });
      if (value.overrideReason && gateResult.verdict === 'over') await logOverride('outward_approve', cur, gateResult, value.overrideReason, req, transaction);
      await writeAudit({ entityType: 'outward_payment', entityId: payment.id, entityCode: cur.outward_code, action: 'approved', req, details: { level: step.level, role: step.role_required, gate: gateResult.verdict, override: !!value.overrideReason }, transaction });
    });

    const full = await TreasuryOutwardPayment.findByPk(payment.id, { include: [{ model: TreasuryApproval, as: 'approvals' }] });
    res.json({ outward: formatOutwardRow(full), gate: gateResult });
  } catch (err) {
    console.error('[treasury] approveOutwardPayment error', err);
    res.status(500).json({ error: 'Failed to approve outward payment' });
  }
}

async function rejectOutwardPayment(req, res) {
  const { error, value } = rejectOutwardSchema.validate(req.body, { stripUnknown: true });
  if (error) return validationError(res, error);
  await outwardStatusChange(req, res, {
    guard: (s) => IN_APPROVAL.includes(s),
    apply: { status: 'rejected', reject_reason: value.reason },
    action: 'rejected',
    details: { reason: value.reason },
    stampCurrentStep: { status: 'rejected', reason: value.reason },
  });
}

async function holdOutwardPayment(req, res) {
  const { error, value } = holdOutwardSchema.validate(req.body, { stripUnknown: true });
  if (error) return validationError(res, error);
  await outwardStatusChange(req, res, {
    guard: (s) => IN_APPROVAL.includes(s) || s === 'draft' || s === 'scheduled',
    apply: { status: 'on_hold', hold_reason: value.reason },
    action: 'held',
    details: { reason: value.reason },
  });
}

async function outwardStatusChange(req, res, { guard, apply, action, details, stampCurrentStep }) {
  try {
    const payment = await TreasuryOutwardPayment.findByPk(req.params.id, { include: [{ model: TreasuryApproval, as: 'approvals' }] });
    if (!payment) return res.status(404).json({ error: 'Outward payment not found' });
    const cur = plain(payment);
    if (guard && !guard(cur.status)) return res.status(409).json({ error: `Action not allowed from status "${cur.status}"` });
    await db.transaction(async (transaction) => {
      await payment.update(apply, { transaction });
      if (stampCurrentStep) {
        const step = (cur.approvals || []).slice().sort((a, b) => a.level - b.level).find((a) => a.status === 'pending');
        if (step) {
          await TreasuryApproval.update(
            { ...stampCurrentStep, approver_id: req.user ? req.user.id : null, approver_name: req.user ? req.user.fullName : null, acted_at: new Date().toISOString() },
            { where: { id: step.id }, transaction }
          );
        }
      }
      await writeAudit({ entityType: 'outward_payment', entityId: payment.id, entityCode: cur.outward_code, action, req, details, transaction });
    });
    const full = await TreasuryOutwardPayment.findByPk(payment.id, { include: [{ model: TreasuryApproval, as: 'approvals' }] });
    res.json(formatOutwardRow(full));
  } catch (err) {
    console.error(`[treasury] ${action} error`, err);
    res.status(500).json({ error: `Failed to ${action} outward payment` });
  }
}

/* ─────────────────────────── Schedule ─────────────────────────── */

async function scheduleOutwardPayment(req, res) {
  const { error, value } = scheduleOutwardSchema.validate(req.body, { stripUnknown: true });
  if (error) return validationError(res, error);
  try {
    const payment = await TreasuryOutwardPayment.findByPk(req.params.id, { include: [{ model: TreasuryApproval, as: 'approvals' }] });
    if (!payment) return res.status(404).json({ error: 'Outward payment not found' });
    const cur = plain(payment);
    const ready = cur.auto_approved || allApproved(cur.approvals || []);
    if (!ready) return res.status(409).json({ error: 'Payment is not fully approved yet' });
    if (!['treasury_approved', 'admin_approved', 'function_approved', 'scheduled'].includes(cur.status)) {
      return res.status(409).json({ error: `Cannot schedule from status "${cur.status}"` });
    }
    const scheduledDate = gate.dayKey(value.scheduledDate);
    const gateResult = await computeOutwardGate({ ...cur, scheduled_date: scheduledDate });
    if (gateResult.verdict === 'over' && !value.overrideReason) {
      return res.status(422).json({ error: 'Scheduling on this date would breach the cashflow gate. An override reason is required.', gate: gateResult });
    }
    await db.transaction(async (transaction) => {
      await payment.update({ scheduled_date: scheduledDate, status: 'scheduled', gate_verdict: gateResult.verdict }, { transaction });
      if (value.overrideReason && gateResult.verdict === 'over') await logOverride('schedule_move', cur, gateResult, value.overrideReason, req, transaction);
      await writeAudit({ entityType: 'outward_payment', entityId: payment.id, entityCode: cur.outward_code, action: 'scheduled', req, details: { scheduledDate, gate: gateResult.verdict }, transaction });
    });
    const full = await TreasuryOutwardPayment.findByPk(payment.id, { include: [{ model: TreasuryApproval, as: 'approvals' }] });
    res.json({ outward: formatOutwardRow(full), gate: gateResult });
  } catch (err) {
    console.error('[treasury] scheduleOutwardPayment error', err);
    res.status(500).json({ error: 'Failed to schedule outward payment' });
  }
}

/* ─────────────────────────── Execute (pay) ─────────────────────────── */

async function executeOutwardPayment(req, res) {
  const { error, value } = executeOutwardSchema.validate(req.body, { stripUnknown: true });
  if (error) return validationError(res, error);
  try {
    const payment = await TreasuryOutwardPayment.findByPk(req.params.id, { include: [{ model: TreasuryApproval, as: 'approvals' }] });
    if (!payment) return res.status(404).json({ error: 'Outward payment not found' });
    const cur = plain(payment);
    const ready = cur.auto_approved || allApproved(cur.approvals || []);
    if (!ready) return res.status(409).json({ error: 'Payment is not fully approved yet' });
    if (!['scheduled', 'treasury_approved', 'admin_approved'].includes(cur.status)) {
      return res.status(409).json({ error: `Cannot execute from status "${cur.status}"` });
    }
    const gateResult = await computeOutwardGate(cur);
    if (gateResult.verdict === 'over' && !value.overrideReason) {
      return res.status(422).json({ error: 'Executing this payment would breach the cashflow gate. An override reason is required.', gate: gateResult });
    }
    const nowIso = new Date().toISOString();
    await db.transaction(async (transaction) => {
      await payment.update(
        {
          bank_account_id: value.bankAccountId,
          mode: value.mode,
          utr_reference: value.utrReference,
          paid_at: nowIso,
          reconciled_at: nowIso,
          executed_by_id: req.user ? req.user.id : null,
          status: 'reconciled', // PAID → RECONCILED in one action for v1
          gate_verdict: gateResult.verdict,
        },
        { transaction }
      );
      if (value.overrideReason && gateResult.verdict === 'over') await logOverride('outward_execute', cur, gateResult, value.overrideReason, req, transaction);
      await writeAudit({ entityType: 'outward_payment', entityId: payment.id, entityCode: cur.outward_code, action: 'executed', req, details: { utr: value.utrReference, bankAccountId: value.bankAccountId, gate: gateResult.verdict }, transaction });
      // Phase 7: push the receipt back to the originating document (e.g. stamp the PO's payment). Lazy require breaks the sourceLink↔outward cycle.
      // eslint-disable-next-line global-require
      const { applyReceiptToSource } = require('./sourceLink');
      await applyReceiptToSource({ ...cur, utr_reference: value.utrReference, mode: value.mode }, req, transaction);
    });
    const full = await TreasuryOutwardPayment.findByPk(payment.id, { include: [{ model: TreasuryApproval, as: 'approvals' }] });
    res.json({ outward: formatOutwardRow(full), gate: gateResult });
  } catch (err) {
    console.error('[treasury] executeOutwardPayment error', err);
    res.status(500).json({ error: 'Failed to execute outward payment' });
  }
}

/* ─────────────────────────── Preview gate (no write) ─────────────────────────── */

async function previewOutwardGate(req, res) {
  try {
    const payment = await TreasuryOutwardPayment.findByPk(req.params.id);
    if (!payment) return res.status(404).json({ error: 'Outward payment not found' });
    const result = await computeOutwardGate(plain(payment));
    res.json({ gate: result });
  } catch (err) {
    console.error('[treasury] previewOutwardGate error', err);
    res.status(500).json({ error: 'Failed to compute gate preview' });
  }
}

/* ─────────────────────────── Bulk approve ─────────────────────────── */

async function bulkApprove(req, res) {
  const { error, value } = bulkApproveSchema.validate(req.body, { stripUnknown: true });
  if (error) return validationError(res, error);
  const results = [];
  for (const id of value.ids) {
    // Reuse the single-approve path so gate + chain logic stays identical.
    // eslint-disable-next-line no-await-in-loop
    const out = await runSingleApprove(id, { overrideReason: value.overrideReason }, req);
    results.push({ id, ...out });
  }
  res.json({ results, approved: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
}

async function runSingleApprove(id, { overrideReason }, req) {
  try {
    const payment = await TreasuryOutwardPayment.findByPk(id, { include: [{ model: TreasuryApproval, as: 'approvals' }] });
    if (!payment) return { ok: false, error: 'not found' };
    const cur = plain(payment);
    if (!IN_APPROVAL.includes(cur.status)) return { ok: false, error: `status ${cur.status}` };
    const step = (cur.approvals || []).slice().sort((a, b) => a.level - b.level).find((a) => a.status === 'pending');
    if (!step) return { ok: false, error: 'no pending step' };
    const gateResult = await computeOutwardGate(cur);
    if (gateResult.verdict === 'over' && !overrideReason) return { ok: false, error: 'gate over — override required', gate: gateResult.verdict };
    await db.transaction(async (transaction) => {
      await TreasuryApproval.update(
        { status: 'approved', approver_id: req.user ? req.user.id : null, approver_name: req.user ? req.user.fullName : null, gate_verdict_at_action: gateResult.verdict, override_reason: overrideReason || null, acted_at: new Date().toISOString() },
        { where: { id: step.id }, transaction }
      );
      const updated = await TreasuryApproval.findAll({ where: { outward_payment_id: id }, transaction });
      await payment.update({ status: statusFromApprovals(updated), gate_verdict: gateResult.verdict }, { transaction });
      if (overrideReason && gateResult.verdict === 'over') await logOverride('outward_approve', cur, gateResult, overrideReason, req, transaction);
      await writeAudit({ entityType: 'outward_payment', entityId: id, entityCode: cur.outward_code, action: 'approved', req, details: { level: step.level, bulk: true }, transaction });
    });
    return { ok: true, status: statusFromApprovals(await TreasuryApproval.findAll({ where: { outward_payment_id: id } })) };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'error' };
  }
}

/* ─────────────────────────── Approvals Inbox (View 4) ─────────────────────────── */

async function approvalsInbox(req, res) {
  try {
    const roleFilter = req.query.role;
    const rows = await TreasuryOutwardPayment.findAll({
      where: { status: { [Op.in]: IN_APPROVAL } },
      include: [{ model: TreasuryApproval, as: 'approvals' }],
      order: [['due_date', 'ASC'], ['id', 'ASC']],
      limit: 1000,
    });
    let data = rows.map(formatOutwardRow).filter((r) => r.nextApprovalRole);
    if (roleFilter) data = data.filter((r) => r.nextApprovalRole === roleFilter);
    const nowMs = Date.now();
    const slaBreached = (r) => {
      const step = (r.approvals || []).find((a) => a.status === 'pending');
      return step && step.slaDueAt && new Date(step.slaDueAt).getTime() < nowMs;
    };
    const summary = {
      pendingCount: data.length,
      slaBreachedCount: data.filter(slaBreached).length,
      valuePending: round2(data.reduce((s, r) => s + r.netAmount, 0)),
      gateFlaggedCount: data.filter((r) => r.gateVerdict === 'over').length,
    };
    res.json({ data, summary });
  } catch (err) {
    console.error('[treasury] approvalsInbox error', err);
    res.status(500).json({ error: 'Failed to load approvals inbox' });
  }
}

/* ─────────────────────────── override logging ─────────────────────────── */

async function logOverride(actionType, cur, gateResult, reason, req, transaction) {
  await TreasuryGateOverride.create(
    {
      action_type: actionType,
      ref_type: 'outward_payment',
      ref_id: cur.id,
      ref_code: cur.outward_code,
      projected_lowest_before: gateResult.before.lowest.amount,
      projected_lowest_after: gateResult.after.lowest.amount,
      threshold: gateResult.threshold,
      amount: num(cur.net_amount) || num(cur.gross_amount),
      reason,
      approver_id: req.user ? req.user.id : null,
      approver_name: req.user ? req.user.fullName : null,
    },
    { transaction }
  );
}

module.exports = {
  approvalChainFor,
  buildApprovalRows,
  statusFromApprovals,
  listOutwardPayments,
  getOutwardPayment,
  createOutwardPayment,
  submitOutwardPayment,
  approveOutwardPayment,
  rejectOutwardPayment,
  holdOutwardPayment,
  scheduleOutwardPayment,
  executeOutwardPayment,
  previewOutwardGate,
  bulkApprove,
  approvalsInbox,
};

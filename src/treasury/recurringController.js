/**
 * Treasury — Recurring Payments (View 6).  Standing orders that spawn outward
 * payments on a cadence, then flow through the normal approval chain.
 *
 * Endpoints (under /api/v1/treasury):
 *   GET   /recurring                list
 *   POST  /recurring                create
 *   GET   /recurring/:id            detail
 *   PATCH /recurring/:id            update
 *   POST  /recurring/:id/pause      active → paused
 *   POST  /recurring/:id/resume     paused → active
 *   POST  /recurring/:id/cancel     → cancelled
 *   POST  /recurring/generate       generate all due entries (draft|submitted per config)
 */
const { Op } = require('sequelize');
const gate = require('./cashflowGate');
const {
  db, num, round2, plain, codeYear, nextSequentialCode, retryOnUniqueViolation, writeAudit, nextCadenceDate,
} = require('./helpers');
const {
  createRecurringSchema, updateRecurringSchema, generateRecurringSchema,
} = require('./schemas');
const { approvalChainFor } = require('./outwardController');
const {
  TreasuryRecurringPayment, TreasuryOutwardPayment, TreasuryApproval,
} = require('./models');

const validationError = (res, error) =>
  res.status(400).json({ error: error.details ? error.details[0].message : String(error) });

function formatRecurring(row) {
  const d = plain(row);
  return {
    id: d.id,
    recurringCode: d.recurring_code,
    description: d.description,
    sourceModule: d.source_module,
    sourceSubtype: d.source_subtype,
    payeeId: d.payee_id,
    payeeName: d.payee_name,
    amount: num(d.amount),
    cadence: d.cadence,
    nextDueDate: d.next_due_date,
    lastGeneratedDate: d.last_generated_date,
    bankAccountId: d.bank_account_id,
    autoCreateState: d.auto_create_state,
    autoApprove: !!d.auto_approve,
    status: d.status,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

const CREATE_MAP = {
  description: 'description', sourceModule: 'source_module', sourceSubtype: 'source_subtype',
  payeeId: 'payee_id', payeeName: 'payee_name', amount: 'amount', cadence: 'cadence',
  nextDueDate: 'next_due_date', bankAccountId: 'bank_account_id', autoCreateState: 'auto_create_state',
  autoApprove: 'auto_approve',
};

/* ─────────────────────────── CRUD ─────────────────────────── */

async function listRecurring(req, res) {
  try {
    const where = {};
    if (req.query.status) where.status = req.query.status;
    const rows = await TreasuryRecurringPayment.findAll({ where, order: [['next_due_date', 'ASC'], ['id', 'ASC']] });
    res.json({ data: rows.map(formatRecurring) });
  } catch (err) {
    console.error('[treasury] listRecurring error', err);
    res.status(500).json({ error: 'Failed to load recurring payments' });
  }
}

async function getRecurring(req, res) {
  try {
    const row = await TreasuryRecurringPayment.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Recurring payment not found' });
    res.json(formatRecurring(row));
  } catch (err) {
    console.error('[treasury] getRecurring error', err);
    res.status(500).json({ error: 'Failed to load recurring payment' });
  }
}

async function createRecurring(req, res) {
  const { error, value } = createRecurringSchema.validate(req.body, { stripUnknown: true });
  if (error) return validationError(res, error);
  try {
    const created = await retryOnUniqueViolation(() =>
      db.transaction(async (transaction) => {
        const code = await nextSequentialCode(TreasuryRecurringPayment, 'recurring_code', 'REC', codeYear(), 4, transaction);
        const row = await TreasuryRecurringPayment.create(
          {
            recurring_code: code,
            description: value.description,
            source_module: value.sourceModule,
            source_subtype: value.sourceSubtype || null,
            payee_id: value.payeeId || null,
            payee_name: value.payeeName || null,
            amount: round2(value.amount),
            cadence: value.cadence,
            next_due_date: gate.dayKey(value.nextDueDate),
            bank_account_id: value.bankAccountId || null,
            auto_create_state: value.autoCreateState,
            auto_approve: !!value.autoApprove,
            status: 'active',
            created_by_id: req.user ? req.user.id : null,
          },
          { transaction }
        );
        await writeAudit({ entityType: 'recurring_payment', entityId: row.id, entityCode: code, action: 'created', req, details: { amount: value.amount, cadence: value.cadence }, transaction });
        return row;
      })
    );
    res.status(201).json(formatRecurring(created));
  } catch (err) {
    console.error('[treasury] createRecurring error', err);
    res.status(500).json({ error: 'Failed to create recurring payment' });
  }
}

async function updateRecurring(req, res) {
  const { error, value } = updateRecurringSchema.validate(req.body, { stripUnknown: true });
  if (error) return validationError(res, error);
  try {
    const row = await TreasuryRecurringPayment.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Recurring payment not found' });
    const patch = {};
    for (const [k, col] of Object.entries(CREATE_MAP)) {
      if (value[k] !== undefined) patch[col] = k === 'nextDueDate' ? gate.dayKey(value[k]) : k === 'amount' ? round2(value[k]) : value[k];
    }
    if (value.isCapex !== undefined) { /* isCapex only affects generated OUT band; not stored on recurring */ }
    await db.transaction(async (transaction) => {
      await row.update(patch, { transaction });
      await writeAudit({ entityType: 'recurring_payment', entityId: row.id, entityCode: plain(row).recurring_code, action: 'updated', req, details: Object.keys(patch), transaction });
    });
    res.json(formatRecurring(await TreasuryRecurringPayment.findByPk(req.params.id)));
  } catch (err) {
    console.error('[treasury] updateRecurring error', err);
    res.status(500).json({ error: 'Failed to update recurring payment' });
  }
}

const setStatus = (target, action, guardFrom) => async (req, res) => {
  try {
    const row = await TreasuryRecurringPayment.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Recurring payment not found' });
    const cur = plain(row);
    if (guardFrom && !guardFrom.includes(cur.status)) return res.status(409).json({ error: `Cannot ${action} from status "${cur.status}"` });
    await db.transaction(async (transaction) => {
      await row.update({ status: target }, { transaction });
      await writeAudit({ entityType: 'recurring_payment', entityId: row.id, entityCode: cur.recurring_code, action, req, transaction });
    });
    res.json(formatRecurring(await TreasuryRecurringPayment.findByPk(req.params.id)));
  } catch (err) {
    console.error(`[treasury] ${action} recurring error`, err);
    res.status(500).json({ error: `Failed to ${action} recurring payment` });
  }
};
const pauseRecurring = setStatus('paused', 'paused', ['active']);
const resumeRecurring = setStatus('active', 'resumed', ['paused']);
const cancelRecurring = setStatus('cancelled', 'cancelled', ['active', 'paused']);

/* ─────────────────────────── Generator ─────────────────────────── */

async function generateDue(req, res) {
  const { error, value } = generateRecurringSchema.validate(req.body || {}, { stripUnknown: true });
  if (error) return validationError(res, error);
  try {
    const asOf = value.asOf ? gate.dayKey(value.asOf) : gate.today();
    const cutoff = gate.addDays(asOf, value.leadDays || 0);

    const due = await TreasuryRecurringPayment.findAll({
      where: { status: 'active', next_due_date: { [Op.ne]: null, [Op.lte]: cutoff } },
      order: [['next_due_date', 'ASC']],
    });

    const generated = [];
    for (const rec of due) {
      const d = plain(rec);
      // eslint-disable-next-line no-await-in-loop
      const outCode = await generateOneOutward(rec, d, req);
      // eslint-disable-next-line no-await-in-loop
      await db.transaction(async (transaction) => {
        await rec.update(
          { last_generated_date: d.next_due_date, next_due_date: nextCadenceDate(d.next_due_date, d.cadence) },
          { transaction }
        );
      });
      generated.push({ recurringId: d.id, recurringCode: d.recurring_code, outwardCode: outCode, dueDate: d.next_due_date });
    }
    res.json({ asOf, cutoff, generatedCount: generated.length, generated });
  } catch (err) {
    console.error('[treasury] generateDue error', err);
    res.status(500).json({ error: 'Failed to generate recurring payments' });
  }
}

async function generateOneOutward(rec, d, req) {
  const amount = round2(d.amount);
  const chain = approvalChainFor(amount, false);
  const submitNow = d.auto_create_state === 'submitted' || d.auto_approve;
  const nowIso = new Date().toISOString();

  return retryOnUniqueViolation(() =>
    db.transaction(async (transaction) => {
      const code = await nextSequentialCode(TreasuryOutwardPayment, 'outward_code', 'OUT', codeYear(), 4, transaction);
      const payment = await TreasuryOutwardPayment.create(
        {
          outward_code: code,
          source_module: d.source_module || 'operating',
          source_subtype: d.source_subtype || 'Recurring',
          source_ref_type: 'recurring_payment',
          source_ref_id: d.id,
          source_ref_label: d.recurring_code,
          payee_id: d.payee_id || null,
          payee_name: d.payee_name || d.description,
          purpose: d.description,
          gross_amount: amount,
          tds_percent: 0,
          tds_amount: 0,
          net_amount: amount,
          currency: 'INR',
          due_date: d.next_due_date,
          status: d.auto_approve ? (chain.roles.includes('admin') ? 'admin_approved' : 'treasury_approved') : (submitNow ? 'submitted' : 'draft'),
          approval_tier: chain.tier,
          required_chain: { roles: chain.roles, tier: chain.tier, boardMinute: chain.boardMinute },
          auto_approved: !!d.auto_approve,
          bank_account_id: d.bank_account_id || null,
          recurring_id: d.id,
          created_by_id: req.user ? req.user.id : null,
        },
        { transaction }
      );

      if (submitNow) {
        const slaHours = { function_head: 72, treasury_officer: 48, cfo: 48, admin: 48 };
        for (let i = 0; i < chain.roles.length; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await TreasuryApproval.create(
            {
              outward_payment_id: payment.id,
              level: i + 1,
              role_required: chain.roles[i],
              status: d.auto_approve ? 'approved' : 'pending',
              approver_name: d.auto_approve ? 'Auto (recurring)' : null,
              acted_at: d.auto_approve ? nowIso : null,
              sla_due_at: new Date(Date.now() + (slaHours[chain.roles[i]] || 48) * 3_600_000).toISOString(),
            },
            { transaction }
          );
        }
      }
      await writeAudit({ entityType: 'outward_payment', entityId: payment.id, entityCode: code, action: 'generated_from_recurring', req, details: { recurring: d.recurring_code, amount }, transaction });
      return code;
    })
  );
}

module.exports = {
  listRecurring,
  getRecurring,
  createRecurring,
  updateRecurring,
  pauseRecurring,
  resumeRecurring,
  cancelRecurring,
  generateDue,
};

/**
 * Treasury — Inward Payments (Receivables) API.  Spec Views 2 + popups 5A/5B/5C.
 *
 * Endpoints (mounted under /api/v1/treasury):
 *   GET    /inward-payments                       list + summary bar (filters)
 *   GET    /inward-payments/:id                   full detail + timeline
 *   POST   /inward-payments                       5A — record new EXPECTED inflow
 *   POST   /inward-payments/:id/confirm           5B — confirm receipt + variance/reconcile
 *   POST   /inward-payments/:id/reschedule        5C — reschedule (gate-checked)
 *   POST   /inward-payments/:id/hold              put on hold
 *   POST   /inward-payments/:id/write-off         CFO write-off
 *   POST   /inward-payments/:id/cancel            cancel
 *   POST   /inward-payments/preview               5A step-5 cashflow preview (no write)
 *   POST   /inward-payments/:id/preview-reschedule 5C gate preview (no write)
 *   GET    /inward-payments/reschedule-summary/:clientId  5C step-4 client history
 *   GET    /bank-accounts                          the 4 accounts + balances
 *   GET    /clients                                client search + open receivable
 *   GET    /clients/:id/open-invoices              invoice picker for 5A
 */
const { Op } = require('sequelize');
const gate = require('./cashflowGate');
const {
  db, num, round2, plain, codeYear, nextSequentialCode, retryOnUniqueViolation,
  writeAudit, fyQuarter, dayDiff,
} = require('./helpers');
const {
  createInwardSchema, confirmReceiptSchema, rescheduleSchema, holdSchema,
  writeOffSchema, cancelSchema, previewInwardSchema, previewRescheduleSchema,
} = require('./schemas');
const {
  TreasuryInwardPayment, TreasuryInwardInvoice, TreasuryInwardVariance,
  TreasuryRescheduleHistory, TreasuryAdvance, TreasuryTdsReceivable,
  TreasuryBankAccount, TreasuryGateOverride, TreasurySetting,
} = require('./models');
const { reflectInward } = require('./bdReflect'); // BD Customer Tracker reflect-back (best-effort)

const PENDING = gate.PENDING_INWARD; // ['expected','rescheduled','partial']

/* Optional cross-module models — treasury should not hard-fail if BD/Fulfillment shift. */
let BdClientProfile = null;
try { ({ BdClientProfile } = require('../bd/models')); } catch (_e) { /* optional */ }
let VendorClient = null;
try { VendorClient = require('../vendorClient/models'); } catch (_e) { /* optional */ }
let FulfillmentInvoice = null;
let FulfillmentOrder = null;
try {
  const f = require('../fulfillment/models');
  FulfillmentInvoice = f.FulfillmentInvoice;
  FulfillmentOrder = f.FulfillmentOrder;
} catch (_e) { /* optional */ }

const validationError = (res, error) =>
  res.status(400).json({ error: error.details ? error.details[0].message : String(error) });

/* ─────────────────────────── Tier lookup (batched) ─────────────────────────── */

async function tierMapFor(clientIds) {
  const map = new Map();
  if (!BdClientProfile || !clientIds.length) return map;
  try {
    const rows = await BdClientProfile.findAll({
      where: { client_id: { [Op.in]: clientIds } },
      attributes: ['client_id', 'tier'],
    });
    for (const r of rows) { const d = plain(r); map.set(d.client_id, d.tier || null); }
  } catch (_e) { /* ignore */ }
  return map;
}

/* ─────────────────────────── Formatting ─────────────────────────── */

function overdueInfo(d, todayKey) {
  const isPending = PENDING.includes(d.status);
  const exp = d.expected_date ? String(d.expected_date).slice(0, 10) : null;
  if (!isPending || !exp) return { isOverdue: false, overdueDays: 0, daysRemaining: null };
  const diff = dayDiff(exp, todayKey); // exp - today; negative ⇒ overdue
  if (diff < 0) return { isOverdue: true, overdueDays: -diff, daysRemaining: null };
  return { isOverdue: false, overdueDays: 0, daysRemaining: diff };
}

function formatInwardRow(row, { tier, todayKey } = {}) {
  const d = plain(row);
  const links = (d.invoiceLinks || []).map((l) => ({
    id: l.id,
    fulfillmentInvoiceId: l.fulfillment_invoice_id,
    invoiceNo: l.invoice_no,
    amountApplied: num(l.amount_applied),
  }));
  const od = overdueInfo(d, todayKey || gate.today());
  const confirmed = d.confirmed_at
    ? {
        actualDate: d.actual_date,
        actualAmount: num(d.actual_amount),
        actualMode: d.actual_mode,
        utrReference: d.utr_reference,
        receivingBankAccountId: d.receiving_bank_account_id,
        varianceAmount: num(d.variance_amount),
        varianceDays: d.variance_days,
        statementMatched: !!d.statement_matched,
        reconciledAt: d.reconciled_at,
      }
    : null;
  return {
    id: d.id,
    inwardCode: d.inward_code,
    type: d.type,
    status: d.status,
    client: { id: d.client_id, name: d.client_name, tier: tier ?? null },
    bdPocId: d.bd_poc_id,
    invoiceLinks: links,
    expectedDate: d.expected_date,
    originalExpectedDate: d.original_expected_date,
    expectedAmount: num(d.expected_amount),
    invoiceAmount: num(d.invoice_amount),
    advanceAmount: num(d.advance_amount),
    expectedTdsPercent: num(d.expected_tds_percent),
    expectedTdsAmount: num(d.expected_tds_amount),
    netExpectedAmount: num(d.net_expected_amount),
    currency: d.currency,
    mode: d.mode,
    destinationBankAccountId: d.destination_bank_account_id,
    advanceAgainst: d.advance_against,
    adjustableOn: d.adjustable_on,
    commitmentBasis: d.commitment_basis,
    commitmentAttachmentUrl: d.commitment_attachment_url,
    notes: d.notes,
    rescheduleCount: d.reschedule_count,
    parentInwardId: d.parent_inward_id,
    ...od,
    confirmed,
    holdReason: d.hold_reason,
    writeOffAmount: num(d.write_off_amount),
    writeOffReason: d.write_off_reason,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

/* ─────────────────────────── List + summary ─────────────────────────── */

async function listInwardPayments(req, res) {
  try {
    const { status, type, clientId, mode, search, dateField, dateFrom, dateTo } = req.query;
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const todayKey = gate.today();
    const where = {};

    if (status && status !== 'all') {
      if (status === 'overdue') {
        where.status = { [Op.in]: PENDING };
        where.expected_date = { [Op.ne]: null, [Op.lt]: todayKey };
      } else {
        where.status = status;
      }
    }
    if (type) where.type = type;
    if (clientId) where.client_id = Number(clientId);
    if (mode) where.mode = mode;
    if (search) {
      const like = { [Op.iLike]: `%${search}%` };
      where[Op.or] = [{ inward_code: like }, { client_name: like }, { utr_reference: like }];
    }
    const col = dateField === 'confirmed' ? 'actual_date' : 'expected_date';
    if (dateFrom || dateTo) {
      where[col] = {};
      if (dateFrom) where[col][Op.gte] = dateFrom;
      if (dateTo) where[col][Op.lte] = dateTo;
    }

    const rows = await TreasuryInwardPayment.findAll({
      where,
      include: [{ model: TreasuryInwardInvoice, as: 'invoiceLinks' }],
      order: [['expected_date', 'ASC'], ['id', 'ASC']],
      limit,
    });

    const clientIds = [...new Set(rows.map((r) => plain(r).client_id).filter(Boolean))];
    const tiers = await tierMapFor(clientIds);

    const data = rows.map((r) => formatInwardRow(r, { tier: tiers.get(plain(r).client_id), todayKey }));

    // Summary bar over the filtered set.
    const summary = {
      totalCount: data.length,
      openReceivable: round2(data.filter((r) => PENDING.includes(r.status)).reduce((s, r) => s + r.netExpectedAmount, 0)),
      overdueCount: data.filter((r) => r.isOverdue).length,
      overdueAmount: round2(data.filter((r) => r.isOverdue).reduce((s, r) => s + r.netExpectedAmount, 0)),
      advancesCount: data.filter((r) => r.type === 'advance' && PENDING.includes(r.status)).length,
      advancesAmount: round2(data.filter((r) => r.type === 'advance' && PENDING.includes(r.status)).reduce((s, r) => s + r.advanceAmount, 0)),
      partialCount: data.filter((r) => r.status === 'partial').length,
    };

    res.json({ data, summary });
  } catch (err) {
    console.error('[treasury] listInwardPayments error', err);
    res.status(500).json({ error: 'Failed to load inward payments' });
  }
}

async function getInwardPayment(req, res) {
  try {
    const row = await TreasuryInwardPayment.findByPk(req.params.id, {
      include: [
        { model: TreasuryInwardInvoice, as: 'invoiceLinks' },
        { model: TreasuryInwardVariance, as: 'variances' },
        { model: TreasuryRescheduleHistory, as: 'reschedules' },
      ],
    });
    if (!row) return res.status(404).json({ error: 'Inward payment not found' });
    const d = plain(row);
    const tiers = await tierMapFor([d.client_id].filter(Boolean));
    const base = formatInwardRow(row, { tier: tiers.get(d.client_id) });

    base.variances = (d.variances || []).map((v) => ({
      id: v.id, reason: v.reason, amount: num(v.amount), note: v.note,
      tdsQuarter: v.tds_quarter, tdsSection: v.tds_section, form16aUrl: v.form16a_url, createdAt: v.created_at,
    }));
    base.reschedules = (d.reschedules || [])
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map((r) => ({
        id: r.id, oldDate: r.old_date, newDate: r.new_date, delayDays: r.delay_days,
        reasonCategory: r.reason_category, source: r.source, notes: r.notes,
        gateVerdict: r.gate_verdict, gateLowestBefore: num(r.gate_lowest_before),
        gateLowestAfter: num(r.gate_lowest_after), overrideReason: r.override_reason, createdAt: r.created_at,
      }));
    // Timeline (chronological status events, derived).
    base.timeline = buildTimeline(base);
    res.json(base);
  } catch (err) {
    console.error('[treasury] getInwardPayment error', err);
    res.status(500).json({ error: 'Failed to load inward payment' });
  }
}

function buildTimeline(row) {
  const events = [{ label: 'Created (Expected)', at: row.createdAt, kind: 'created' }];
  for (const r of row.reschedules || []) {
    events.push({ label: `Rescheduled ${r.oldDate} → ${r.newDate} (${r.delayDays >= 0 ? '+' : ''}${r.delayDays}d)`, at: r.createdAt, kind: 'rescheduled' });
  }
  if (row.confirmed) {
    events.push({ label: `Confirmed in bank ₹${row.confirmed.actualAmount}`, at: row.confirmed.reconciledAt || row.updatedAt, kind: 'confirmed' });
    if (row.status === 'reconciled') events.push({ label: 'Reconciled', at: row.confirmed.reconciledAt, kind: 'reconciled' });
  }
  if (row.status === 'on_hold') events.push({ label: `On hold: ${row.holdReason || ''}`, at: row.updatedAt, kind: 'on_hold' });
  if (row.status === 'write_off') events.push({ label: `Write-off ₹${row.writeOffAmount}: ${row.writeOffReason || ''}`, at: row.updatedAt, kind: 'write_off' });
  if (row.status === 'cancelled') events.push({ label: 'Cancelled', at: row.updatedAt, kind: 'cancelled' });
  return events;
}

/* ─────────────────────────── 5A: Record New ─────────────────────────── */

async function createInwardPayment(req, res) {
  const { error, value } = createInwardSchema.validate(req.body, { stripUnknown: true });
  if (error) return validationError(res, error);

  try {
    const expectedAmount = round2(value.expectedAmount);
    const tdsPct = round2(value.expectedTdsPercent || 0);
    const tdsAmount = round2((expectedAmount * tdsPct) / 100);
    const netExpected = round2(expectedAmount - tdsAmount);
    const invoiceApplied = round2((value.invoiceLinks || []).reduce((s, l) => s + num(l.amountApplied), 0));
    const invoiceAmount = value.type === 'advance' ? 0 : (invoiceApplied || (value.type === 'invoice' ? expectedAmount : 0));
    const advanceAmount = value.type === 'invoice' ? 0 : round2(value.advanceAmount || 0);
    const clientName = await resolveClientName(value.clientId);
    const expDate = gate.dayKey(value.expectedDate);

    const result = await retryOnUniqueViolation(() =>
      db.transaction(async (transaction) => {
        const code = await nextSequentialCode(TreasuryInwardPayment, 'inward_code', 'IN', codeYear(), 4, transaction);
        const inward = await TreasuryInwardPayment.create(
          {
            inward_code: code,
            type: value.type,
            client_id: value.clientId,
            client_name: clientName,
            bd_poc_id: value.bdPocId || null,
            expected_date: expDate,
            original_expected_date: expDate,
            expected_amount: expectedAmount,
            invoice_amount: invoiceAmount,
            advance_amount: advanceAmount,
            expected_tds_percent: tdsPct,
            expected_tds_amount: tdsAmount,
            net_expected_amount: netExpected,
            currency: value.currency || 'INR',
            mode: value.mode || null,
            destination_bank_account_id: value.destinationBankAccountId || null,
            advance_against: value.advanceAgainst || null,
            adjustable_on: value.adjustableOn || null,
            commitment_basis: value.commitmentBasis || null,
            commitment_attachment_url: value.commitmentAttachmentUrl || null,
            notes: value.notes || null,
            status: 'expected',
            created_by_id: req.user ? req.user.id : null,
          },
          { transaction }
        );

        for (const link of value.invoiceLinks || []) {
          await TreasuryInwardInvoice.create(
            {
              inward_payment_id: inward.id,
              fulfillment_invoice_id: link.fulfillmentInvoiceId || null,
              invoice_no: link.invoiceNo || null,
              amount_applied: round2(link.amountApplied),
            },
            { transaction }
          );
        }

        if (advanceAmount > 0) {
          const escrow = await escrowAccountId(transaction);
          await TreasuryAdvance.create(
            {
              client_id: value.clientId,
              client_name: clientName,
              source_inward_id: inward.id,
              bank_account_id: value.destinationBankAccountId || escrow,
              amount: advanceAmount,
              balance_amount: advanceAmount,
              advance_against: value.advanceAgainst || null,
              adjustable_on: value.adjustableOn || null,
              status: 'held',
            },
            { transaction }
          );
        }

        await writeAudit({ entityType: 'inward_payment', entityId: inward.id, entityCode: code, action: 'created', req, details: { type: value.type, expectedAmount, netExpected }, transaction });
        return inward;
      })
    );

    const full = await TreasuryInwardPayment.findByPk(result.id, { include: [{ model: TreasuryInwardInvoice, as: 'invoiceLinks' }] });
    await reflectInward('created', plain(full), req);
    res.status(201).json(formatInwardRow(full));
  } catch (err) {
    console.error('[treasury] createInwardPayment error', err);
    res.status(500).json({ error: 'Failed to create inward payment' });
  }
}

/* ─────────────────────────── 5B: Confirm Receipt ─────────────────────────── */

async function confirmReceipt(req, res) {
  const { error, value } = confirmReceiptSchema.validate(req.body, { stripUnknown: true });
  if (error) return validationError(res, error);

  try {
    const inward = await TreasuryInwardPayment.findByPk(req.params.id);
    if (!inward) return res.status(404).json({ error: 'Inward payment not found' });
    const cur = plain(inward);
    if (!PENDING.includes(cur.status)) {
      return res.status(409).json({ error: `Cannot confirm an inward in status "${cur.status}"` });
    }

    const expectedGross = round2(cur.expected_amount);
    const actual = round2(value.actualAmount);
    const variance = round2(expectedGross - actual); // >0 short
    const providedVariances = (value.variances || []).map((v) => ({ ...v, amount: round2(v.amount) }));
    const sumProvided = round2(providedVariances.reduce((s, v) => s + v.amount, 0));
    const autoLimit = await settingAmount('inward_writeoff_auto_limit', 500);

    const variancesToPersist = [...providedVariances];
    let unexplained = round2(variance - sumProvided);

    // Auto write-off tiny unexplained shortfalls (≤ ₹autoLimit) without CFO sign-off.
    if (variance > 0 && unexplained > 0 && unexplained <= autoLimit) {
      variancesToPersist.push({ reason: 'write_off', amount: unexplained, note: `Auto write-off (≤ ₹${autoLimit})` });
      unexplained = 0;
    }
    if (variance <= 0) unexplained = 0; // received equal/more — nothing to explain

    const remainderNeedsSplit = variance > 0 && round2(unexplained) > 0.5;
    if (remainderNeedsSplit && !value.allowPartial) {
      return res.status(422).json({
        error: 'Variance not fully accounted. Allocate the shortfall, or set allowPartial to split the remainder.',
        variance,
        explained: round2(sumProvided),
        unexplained: round2(unexplained),
      });
    }

    const actualDate = gate.dayKey(value.actualDate);
    const nowIso = new Date().toISOString();

    const out = await retryOnUniqueViolation(() =>
      db.transaction(async (transaction) => {
        // Persist variance rows + TDS receivables.
        for (const v of variancesToPersist) {
          await TreasuryInwardVariance.create(
            {
              inward_payment_id: inward.id,
              reason: v.reason,
              amount: round2(v.amount),
              note: v.note || null,
              tds_quarter: v.tdsQuarter || (v.reason === 'tds' ? fyQuarter(actualDate).code : null),
              tds_section: v.tdsSection || null,
              form16a_url: v.form16aUrl || null,
              created_by_id: req.user ? req.user.id : null,
            },
            { transaction }
          );
          if (v.reason === 'tds' && round2(v.amount) > 0) {
            await TreasuryTdsReceivable.create(
              {
                inward_payment_id: inward.id,
                client_id: cur.client_id,
                client_name: cur.client_name,
                amount: round2(v.amount),
                tds_quarter: v.tdsQuarter || fyQuarter(actualDate).code,
                tds_section: v.tdsSection || null,
                form16a_url: v.form16aUrl || null,
                status: v.form16aUrl ? 'form_received' : 'pending',
              },
              { transaction }
            );
          }
        }

        // Update the confirmed row (matched portion reconciled).
        await inward.update(
          {
            actual_date: actualDate,
            actual_amount: actual,
            actual_mode: value.actualMode || cur.mode,
            utr_reference: value.utrReference || null,
            receiving_bank_account_id: value.receivingBankAccountId || cur.destination_bank_account_id,
            statement_matched: !!value.statementMatched,
            variance_amount: variance,
            variance_days: dayDiff(actualDate, cur.expected_date),
            confirmed_at: nowIso,
            confirmed_by_id: req.user ? req.user.id : null,
            reconciled_at: nowIso,
            status: 'reconciled',
          },
          { transaction }
        );

        // Split off a PARTIAL remainder for the still-unaccounted shortfall.
        let child = null;
        if (remainderNeedsSplit) {
          const remainder = round2(unexplained);
          const childDate = gate.addDays(gate.today(), 7);
          const code = await nextSequentialCode(TreasuryInwardPayment, 'inward_code', 'IN', codeYear(), 4, transaction);
          child = await TreasuryInwardPayment.create(
            {
              inward_code: code,
              type: cur.type,
              client_id: cur.client_id,
              client_name: cur.client_name,
              bd_poc_id: cur.bd_poc_id,
              expected_date: childDate,
              original_expected_date: childDate,
              expected_amount: remainder,
              invoice_amount: cur.type === 'advance' ? 0 : remainder,
              advance_amount: cur.type === 'advance' ? remainder : 0,
              net_expected_amount: remainder,
              currency: cur.currency,
              mode: cur.mode,
              destination_bank_account_id: cur.destination_bank_account_id,
              status: 'partial',
              parent_inward_id: inward.id,
              notes: `Remainder split from ${cur.inward_code} (short by ₹${remainder})`,
              created_by_id: req.user ? req.user.id : null,
            },
            { transaction }
          );
          await writeAudit({ entityType: 'inward_payment', entityId: child.id, entityCode: code, action: 'partial_created', req, details: { parent: cur.inward_code, remainder }, transaction });
        }

        // Close linked invoices when the money is fully received (no remainder).
        if (!remainderNeedsSplit && (cur.type === 'invoice' || cur.type === 'mixed')) {
          await closeLinkedInvoices(inward.id, transaction);
        }

        await writeAudit({
          entityType: 'inward_payment', entityId: inward.id, entityCode: cur.inward_code, action: 'confirmed', req,
          details: { actual, variance, explained: round2(sumProvided), partialRemainder: remainderNeedsSplit ? round2(unexplained) : 0 }, transaction,
        });
        return child;
      })
    );

    const full = await TreasuryInwardPayment.findByPk(inward.id, {
      include: [
        { model: TreasuryInwardInvoice, as: 'invoiceLinks' },
        { model: TreasuryInwardVariance, as: 'variances' },
      ],
    });
    await reflectInward('confirmed', plain(full), req, { actualAmount: actual });
    res.json({
      inward: formatInwardRow(full),
      partial: out ? formatInwardRow(out) : null,
      reconciliation: {
        expectedAmount: expectedGross,
        actualAmount: actual,
        varianceAmount: variance,
        explained: round2(variancesToPersist.reduce((s, v) => s + round2(v.amount), 0)),
        partialRemainder: remainderNeedsSplit ? round2(unexplained) : 0,
        fullyReconciled: !remainderNeedsSplit,
      },
    });
  } catch (err) {
    console.error('[treasury] confirmReceipt error', err);
    res.status(500).json({ error: 'Failed to confirm receipt' });
  }
}

async function closeLinkedInvoices(inwardId, transaction) {
  if (!FulfillmentInvoice) return;
  try {
    const links = await TreasuryInwardInvoice.findAll({ where: { inward_payment_id: inwardId }, transaction });
    const ids = links.map((l) => plain(l).fulfillment_invoice_id).filter(Boolean);
    if (ids.length) {
      await FulfillmentInvoice.update({ status: 'closed' }, { where: { id: { [Op.in]: ids } }, transaction });
    }
  } catch (e) {
    console.warn('[treasury] closeLinkedInvoices failed:', e && e.message ? e.message : e);
  }
}

/* ─────────────────────────── 5C: Reschedule (gate-checked) ─────────────────────────── */

async function rescheduleReceipt(req, res) {
  const { error, value } = rescheduleSchema.validate(req.body, { stripUnknown: true });
  if (error) return validationError(res, error);

  try {
    const inward = await TreasuryInwardPayment.findByPk(req.params.id);
    if (!inward) return res.status(404).json({ error: 'Inward payment not found' });
    const cur = plain(inward);
    if (!['expected', 'rescheduled', 'partial'].includes(cur.status)) {
      return res.status(409).json({ error: `Cannot reschedule an inward in status "${cur.status}"` });
    }

    const oldDate = String(cur.expected_date).slice(0, 10);
    const newDate = gate.dayKey(value.newDate);
    const amount = num(cur.net_expected_amount) || num(cur.expected_amount);

    const gateResult = await gate.evaluateGate({
      excludeInwardIds: [inward.id],
      before: { addInflows: [{ date: oldDate, amount }] },
      after: { addInflows: [{ date: newDate, amount }] },
    });

    if (gateResult.verdict === 'over' && !value.overrideReason) {
      return res.status(422).json({
        error: 'Reschedule would drop the 30-day projected balance below the gate threshold. An override reason is required.',
        gate: gateResult,
      });
    }

    await db.transaction(async (transaction) => {
      await TreasuryRescheduleHistory.create(
        {
          inward_payment_id: inward.id,
          old_date: oldDate,
          new_date: newDate,
          delay_days: dayDiff(newDate, oldDate),
          reason_category: value.reasonCategory || null,
          source: value.source || null,
          notes: value.notes || null,
          attachment_url: value.attachmentUrl || null,
          gate_verdict: gateResult.verdict,
          gate_lowest_before: gateResult.before.lowest.amount,
          gate_lowest_after: gateResult.after.lowest.amount,
          override_reason: value.overrideReason || null,
          created_by_id: req.user ? req.user.id : null,
        },
        { transaction }
      );
      await inward.update(
        { expected_date: newDate, status: 'rescheduled', reschedule_count: num(cur.reschedule_count) + 1 },
        { transaction }
      );
      if (value.overrideReason && gateResult.verdict === 'over') {
        await TreasuryGateOverride.create(
          {
            action_type: 'inward_reschedule',
            ref_type: 'inward_payment',
            ref_id: inward.id,
            ref_code: cur.inward_code,
            projected_lowest_before: gateResult.before.lowest.amount,
            projected_lowest_after: gateResult.after.lowest.amount,
            threshold: gateResult.threshold,
            amount,
            reason: value.overrideReason,
            approver_id: req.user ? req.user.id : null,
            approver_name: req.user ? req.user.fullName : null,
          },
          { transaction }
        );
      }
      await writeAudit({
        entityType: 'inward_payment', entityId: inward.id, entityCode: cur.inward_code, action: 'rescheduled', req,
        details: { oldDate, newDate, delayDays: dayDiff(newDate, oldDate), gateVerdict: gateResult.verdict, override: !!value.overrideReason }, transaction,
      });
    });

    const full = await TreasuryInwardPayment.findByPk(inward.id, { include: [{ model: TreasuryInwardInvoice, as: 'invoiceLinks' }] });
    await reflectInward('rescheduled', plain(full), req, { newDate });
    res.json({ inward: formatInwardRow(full), gate: gateResult });
  } catch (err) {
    console.error('[treasury] rescheduleReceipt error', err);
    res.status(500).json({ error: 'Failed to reschedule inward payment' });
  }
}

/* ─────────────────────────── Hold / Write-off / Cancel ─────────────────────────── */

async function holdReceipt(req, res) {
  const { error, value } = holdSchema.validate(req.body, { stripUnknown: true });
  if (error) return validationError(res, error);
  await simpleStatusChange(req, res, {
    guard: (s) => PENDING.includes(s),
    apply: { status: 'on_hold', hold_reason: value.reason },
    action: 'held',
    details: { reason: value.reason },
  });
}

async function writeOffReceipt(req, res) {
  const { error, value } = writeOffSchema.validate(req.body, { stripUnknown: true });
  if (error) return validationError(res, error);
  await simpleStatusChange(req, res, {
    guard: (s) => PENDING.includes(s) || s === 'on_hold',
    applyFrom: (cur) => ({
      status: 'write_off',
      write_off_amount: value.amount != null ? round2(value.amount) : num(cur.net_expected_amount) || num(cur.expected_amount),
      write_off_reason: value.reason,
      write_off_approved_by_id: req.user ? req.user.id : null,
    }),
    action: 'write_off',
    details: { amount: value.amount, reason: value.reason },
  });
}

async function cancelReceipt(req, res) {
  const { error, value } = cancelSchema.validate(req.body, { stripUnknown: true });
  if (error) return validationError(res, error);
  await simpleStatusChange(req, res, {
    guard: (s) => PENDING.includes(s) || s === 'on_hold',
    apply: { status: 'cancelled', notes: value.reason || null },
    action: 'cancelled',
    details: { reason: value.reason },
  });
}

async function simpleStatusChange(req, res, { guard, apply, applyFrom, action, details }) {
  try {
    const inward = await TreasuryInwardPayment.findByPk(req.params.id);
    if (!inward) return res.status(404).json({ error: 'Inward payment not found' });
    const cur = plain(inward);
    if (guard && !guard(cur.status)) {
      return res.status(409).json({ error: `Action not allowed from status "${cur.status}"` });
    }
    const patch = applyFrom ? applyFrom(cur) : apply;
    await db.transaction(async (transaction) => {
      await inward.update(patch, { transaction });
      await writeAudit({ entityType: 'inward_payment', entityId: inward.id, entityCode: cur.inward_code, action, req, details, transaction });
    });
    const full = await TreasuryInwardPayment.findByPk(inward.id, { include: [{ model: TreasuryInwardInvoice, as: 'invoiceLinks' }] });
    res.json(formatInwardRow(full));
  } catch (err) {
    console.error(`[treasury] ${action} error`, err);
    res.status(500).json({ error: `Failed to ${action} inward payment` });
  }
}

/* ─────────────────────────── Gate previews (no writes) ─────────────────────────── */

async function previewNewInward(req, res) {
  const { error, value } = previewInwardSchema.validate(req.body, { stripUnknown: true });
  if (error) return validationError(res, error);
  try {
    const date = gate.dayKey(value.expectedDate);
    const result = await gate.evaluateGate({ after: { addInflows: [{ date, amount: round2(value.amount) }] } });
    res.json(result);
  } catch (err) {
    console.error('[treasury] previewNewInward error', err);
    res.status(500).json({ error: 'Failed to compute cashflow preview' });
  }
}

async function previewReschedule(req, res) {
  const { error, value } = previewRescheduleSchema.validate(req.body, { stripUnknown: true });
  if (error) return validationError(res, error);
  try {
    const inward = await TreasuryInwardPayment.findByPk(req.params.id);
    if (!inward) return res.status(404).json({ error: 'Inward payment not found' });
    const cur = plain(inward);
    const oldDate = String(cur.expected_date).slice(0, 10);
    const newDate = gate.dayKey(value.newDate);
    const amount = num(cur.net_expected_amount) || num(cur.expected_amount);
    const result = await gate.evaluateGate({
      excludeInwardIds: [inward.id],
      before: { addInflows: [{ date: oldDate, amount }] },
      after: { addInflows: [{ date: newDate, amount }] },
    });
    res.json({ oldDate, newDate, delayDays: dayDiff(newDate, oldDate), amount, gate: result });
  } catch (err) {
    console.error('[treasury] previewReschedule error', err);
    res.status(500).json({ error: 'Failed to compute reschedule preview' });
  }
}

/* ─────────────────────────── 5C step-4: client reschedule summary ─────────────────────────── */

async function clientRescheduleSummary(req, res) {
  try {
    const clientId = Number(req.params.clientId);
    const year = new Date().getUTCFullYear();
    const rows = await TreasuryRescheduleHistory.findAll({
      include: [{ model: TreasuryInwardPayment, as: 'inward', attributes: ['client_id'], where: { client_id: clientId } }],
      order: [['created_at', 'DESC']],
    });
    const ytd = rows.filter((r) => new Date(plain(r).created_at).getUTCFullYear() === year);
    const delays = ytd.map((r) => num(plain(r).delay_days));
    const avgDelay = delays.length ? Math.round(delays.reduce((s, d) => s + d, 0) / delays.length) : 0;
    const mostRecent = rows.length ? plain(rows[0]) : null;
    res.json({
      clientId,
      ytdCount: ytd.length,
      avgDelayDays: avgDelay,
      mostRecent: mostRecent ? { date: mostRecent.created_at, newDate: mostRecent.new_date, delayDays: num(mostRecent.delay_days) } : null,
      relationshipReviewFlag: ytd.length >= 3,
    });
  } catch (err) {
    console.error('[treasury] clientRescheduleSummary error', err);
    res.status(500).json({ error: 'Failed to load reschedule summary' });
  }
}

/* ─────────────────────────── Supporting reads ─────────────────────────── */

async function listBankAccounts(req, res) {
  try {
    const summary = await gate.getBankSummary();
    res.json(summary);
  } catch (err) {
    console.error('[treasury] listBankAccounts error', err);
    res.status(500).json({ error: 'Failed to load bank accounts' });
  }
}

async function listClients(req, res) {
  try {
    if (!VendorClient) return res.json({ data: [] });
    const search = req.query.search;
    const where = { type: 'client' };
    if (search) where.name = { [Op.iLike]: `%${search}%` };
    const clients = await VendorClient.findAll({ where, limit: 50, order: [['name', 'ASC']] });
    const ids = clients.map((c) => plain(c).id);

    // Open receivable per client = Σ net expected of pending inward.
    const inward = await TreasuryInwardPayment.findAll({
      where: { client_id: { [Op.in]: ids.length ? ids : [-1] }, status: { [Op.in]: PENDING } },
      attributes: ['client_id', 'net_expected_amount', 'expected_amount'],
    });
    const openByClient = new Map();
    for (const r of inward) {
      const d = plain(r);
      openByClient.set(d.client_id, round2((openByClient.get(d.client_id) || 0) + (num(d.net_expected_amount) || num(d.expected_amount))));
    }
    const tiers = await tierMapFor(ids);
    res.json({
      data: clients.map((c) => {
        const d = plain(c);
        return { id: d.id, name: d.name, code: d.entity_code, tier: tiers.get(d.id) || null, openReceivable: openByClient.get(d.id) || 0 };
      }),
    });
  } catch (err) {
    console.error('[treasury] listClients error', err);
    res.status(500).json({ error: 'Failed to load clients' });
  }
}

async function listClientOpenInvoices(req, res) {
  try {
    if (!FulfillmentInvoice || !FulfillmentOrder) return res.json({ data: [] });
    const clientId = Number(req.params.id);
    const orders = await FulfillmentOrder.findAll({ where: { vendor_client_id: clientId }, attributes: ['id'] });
    const orderIds = orders.map((o) => plain(o).id);
    if (!orderIds.length) return res.json({ data: [] });

    const invoices = await FulfillmentInvoice.findAll({
      where: { fulfillment_order_id: { [Op.in]: orderIds }, status: { [Op.notIn]: ['closed', 'cancelled'] } },
      order: [['invoice_date', 'ASC']],
    });

    // Subtract amounts already applied by reconciled inward links.
    const invoiceIds = invoices.map((i) => plain(i).id);
    const applied = new Map();
    if (invoiceIds.length) {
      const links = await TreasuryInwardInvoice.findAll({
        where: { fulfillment_invoice_id: { [Op.in]: invoiceIds } },
        include: [{ model: TreasuryInwardPayment, as: 'inward', attributes: ['status'], where: { status: 'reconciled' }, required: true }],
      });
      for (const l of links) {
        const d = plain(l);
        applied.set(d.fulfillment_invoice_id, round2((applied.get(d.fulfillment_invoice_id) || 0) + num(d.amount_applied)));
      }
    }
    const todayKey = gate.today();
    res.json({
      data: invoices.map((inv) => {
        const d = plain(inv);
        const total = num(d.total_value);
        const outstanding = round2(total - (applied.get(d.id) || 0));
        const overdueDays = d.due_date ? Math.max(0, -dayDiff(String(d.due_date).slice(0, 10), todayKey)) : 0;
        return {
          id: d.id, invoiceNo: d.invoice_no, invoiceDate: d.invoice_date, dueDate: d.due_date,
          totalValue: total, outstanding, overdueDays, status: d.status,
        };
      }).filter((inv) => inv.outstanding > 0),
    });
  } catch (err) {
    console.error('[treasury] listClientOpenInvoices error', err);
    res.status(500).json({ error: 'Failed to load open invoices' });
  }
}

/* ─────────────────────────── small utils ─────────────────────────── */

async function resolveClientName(clientId) {
  if (!VendorClient || !clientId) return null;
  try {
    const c = await VendorClient.findByPk(clientId, { attributes: ['name'] });
    return c ? plain(c).name : null;
  } catch (_e) { return null; }
}

async function escrowAccountId(transaction) {
  try {
    const acct = await TreasuryBankAccount.findOne({ where: { account_type: 'escrow' }, transaction });
    return acct ? plain(acct).id : null;
  } catch (_e) { return null; }
}

async function settingAmount(key, fallback) {
  try {
    const row = await TreasurySetting.findOne({ where: { key } });
    if (!row) return fallback;
    const v = plain(row).value;
    if (v == null) return fallback;
    if (typeof v === 'number') return v;
    return Number(v.amount ?? v.value ?? fallback) || fallback;
  } catch (_e) { return fallback; }
}

module.exports = {
  listInwardPayments,
  getInwardPayment,
  createInwardPayment,
  confirmReceipt,
  rescheduleReceipt,
  holdReceipt,
  writeOffReceipt,
  cancelReceipt,
  previewNewInward,
  previewReschedule,
  clientRescheduleSummary,
  listBankAccounts,
  listClients,
  listClientOpenInvoices,
};

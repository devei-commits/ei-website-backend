/**
 * Treasury — cross-module wiring (Phase 7).
 *
 *  Inbound : other modules push a payable into Treasury (source_ref_type/id link).
 *  Outbound: when Treasury executes a payment, the receipt flows back to the
 *            originating document (e.g. a PO's payment fields get stamped).
 *
 * Kept idempotent by (source_ref_type, source_ref_id, source_subtype) so repeated
 * syncs never create duplicate outward payments.
 */
const { Op } = require('sequelize');
const {
  db, num, round2, plain, codeYear, nextSequentialCode, retryOnUniqueViolation, writeAudit, dayDiff,
} = require('./helpers');
const gate = require('./cashflowGate');
const { approvalChainFor, buildApprovalRows } = require('./outwardController');
const { TreasuryOutwardPayment, TreasuryApproval } = require('./models');

let PurchaseOrder = null;
let PoTracking = null;
try { PurchaseOrder = require('../purchaseOrders/models'); } catch (_e) { /* optional */ }
try { PoTracking = require('../poTracking/models'); } catch (_e) { /* optional */ }

/* Grand total from PO line items (mirrors treasury/controller.js). */
function poGrandTotal(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((s, l) => {
    const qty = Number(l?.quantity ?? l?.qty ?? 0) || 0;
    const rate = Number(l?.rate ?? l?.unitPrice ?? l?.price ?? 0) || 0;
    return s + qty * rate;
  }, 0);
}

/**
 * Create an outward payment from a source document. Idempotent: if a non-terminal
 * outward already exists for the same (refType, refId, subtype) it is returned as-is.
 * @returns {Promise<{payment: object, created: boolean}>}
 */
async function createOutwardFromSource(fields, req) {
  const {
    sourceModule, sourceSubtype, sourceRefType, sourceRefId, sourceRefLabel,
    payeeType, payeeId, payeeName, purpose, amount, tdsPercent = 0, dueDate,
    bankAccountId, isCapex = false, autoSubmit = true,
  } = fields;

  // Idempotency guard.
  if (sourceRefType && sourceRefId != null) {
    const existing = await TreasuryOutwardPayment.findOne({
      where: {
        source_ref_type: sourceRefType,
        source_ref_id: sourceRefId,
        ...(sourceSubtype ? { source_subtype: sourceSubtype } : {}),
        status: { [Op.notIn]: ['rejected', 'reconciled', 'paid'] },
      },
    });
    if (existing) return { payment: existing, created: false };
  }

  const gross = round2(amount);
  const tds = round2((gross * num(tdsPercent)) / 100);
  const net = round2(gross - tds);
  const chain = approvalChainFor(net, isCapex);

  const payment = await retryOnUniqueViolation(() =>
    db.transaction(async (transaction) => {
      const code = await nextSequentialCode(TreasuryOutwardPayment, 'outward_code', 'OUT', codeYear(), 4, transaction);
      const created = await TreasuryOutwardPayment.create(
        {
          outward_code: code,
          source_module: sourceModule || 'manual',
          source_subtype: sourceSubtype || null,
          source_ref_type: sourceRefType || null,
          source_ref_id: sourceRefId ?? null,
          source_ref_label: sourceRefLabel || null,
          payee_type: payeeType || 'vendor',
          payee_id: payeeId || null,
          payee_name: payeeName || 'Unknown payee',
          purpose: purpose || null,
          gross_amount: gross,
          tds_percent: num(tdsPercent),
          tds_amount: tds,
          net_amount: net,
          currency: 'INR',
          due_date: dueDate ? gate.dayKey(dueDate) : gate.today(),
          status: autoSubmit ? 'submitted' : 'draft',
          approval_tier: chain.tier,
          required_chain: { roles: chain.roles, tier: chain.tier, boardMinute: chain.boardMinute },
          is_capex: !!isCapex,
          bank_account_id: bankAccountId || null,
          created_by_id: req && req.user ? req.user.id : null,
        },
        { transaction }
      );
      if (autoSubmit) await buildApprovalRows(created.id, chain.roles, transaction);
      await writeAudit({ entityType: 'outward_payment', entityId: created.id, entityCode: code, action: 'pushed_from_source', req, details: { sourceModule, sourceRefType, sourceRefId, net }, transaction });
      return created;
    })
  );
  return { payment, created: true };
}

/**
 * Push a Treasury payment receipt back to its originating document.
 * Runs inside the execute transaction. Best-effort per source type.
 */
async function applyReceiptToSource(outwardPlain, req, transaction) {
  const type = outwardPlain.source_ref_type;
  const refId = outwardPlain.source_ref_id;
  if (!type || refId == null) return;

  try {
    if (type === 'purchase_order' && PoTracking) {
      // Stamp the PO's payment tracking so Procurement shows it as paid.
      const [row, created] = await PoTracking.findOrCreate({
        where: { purchase_order_id: refId },
        defaults: { purchase_order_id: refId },
        transaction,
      });
      await row.update(
        {
          payment_transaction_no: outwardPlain.utr_reference || row.payment_transaction_no,
          payment_transaction_date: gate.today(),
          payment_mode: outwardPlain.mode || row.payment_mode,
        },
        { transaction }
      );
      await writeAudit({ entityType: 'outward_payment', entityId: outwardPlain.id, entityCode: outwardPlain.outward_code, action: 'receipt_to_source', req, details: { source: 'purchase_order', purchaseOrderId: refId, trackingCreated: created }, transaction });
    } else {
      // Extensible: regulatory / hr / statutory / warehouse receipts log-only for now.
      await writeAudit({ entityType: 'outward_payment', entityId: outwardPlain.id, entityCode: outwardPlain.outward_code, action: 'receipt_to_source', req, details: { source: type, refId, note: 'logged (no handler)' }, transaction });
    }
  } catch (e) {
    console.warn('[treasury] applyReceiptToSource failed:', e && e.message ? e.message : e);
  }
}

/**
 * Pull-based sync: scan po_tracking for GRN-complete, unpaid POs and create a
 * matching outward payment for each that doesn't already have one.
 */
async function syncProcurementPayables(req) {
  if (!PoTracking || !PurchaseOrder) return { created: [], scanned: 0 };
  const tracking = await PoTracking.findAll({
    where: {
      grn_complete_at: { [Op.ne]: null },
      payment_transaction_no: { [Op.is]: null },
    },
  });
  const created = [];
  for (const t of tracking) {
    const d = plain(t);
    // eslint-disable-next-line no-await-in-loop
    const po = await PurchaseOrder.findByPk(d.purchase_order_id, { attributes: ['id', 'order_id', 'vendor_name', 'items', 'payment_terms'] });
    if (!po) continue;
    const p = plain(po);
    const amount = round2(poGrandTotal(p.items));
    if (amount <= 0) continue;
    // Due date: GRN complete + a small term window (best-effort).
    const dueDate = gate.addDays(gate.dayKey(d.grn_complete_at) || gate.today(), 7);
    // eslint-disable-next-line no-await-in-loop
    const { payment, created: wasCreated } = await createOutwardFromSource({
      sourceModule: 'procurement',
      sourceSubtype: 'PO Vendor Payment',
      sourceRefType: 'purchase_order',
      sourceRefId: p.id,
      sourceRefLabel: p.order_id || `PO-${p.id}`,
      payeeType: 'vendor',
      payeeName: p.vendor_name || 'Vendor',
      purpose: `Payment for ${p.order_id || `PO-${p.id}`} (goods received)`,
      amount,
      dueDate,
      autoSubmit: true,
    }, req);
    if (wasCreated) created.push({ purchaseOrderId: p.id, poNumber: p.order_id, outwardCode: plain(payment).outward_code, amount });
  }
  return { created, scanned: tracking.length };
}

/* ── HTTP handlers ── */

async function pushFromSourceHandler(req, res) {
  try {
    const b = req.body || {};
    if (!b.payeeName || !(Number(b.amount) > 0)) return res.status(400).json({ error: 'payeeName and a positive amount are required' });
    const { payment, created } = await createOutwardFromSource(b, req);
    res.status(created ? 201 : 200).json({ created, outwardCode: plain(payment).outward_code, id: plain(payment).id });
  } catch (err) {
    console.error('[treasury] pushFromSourceHandler error', err);
    res.status(500).json({ error: 'Failed to push outward payment from source' });
  }
}

async function syncProcurementHandler(req, res) {
  try {
    const result = await syncProcurementPayables(req);
    res.json({ scanned: result.scanned, createdCount: result.created.length, created: result.created });
  } catch (err) {
    console.error('[treasury] syncProcurementHandler error', err);
    res.status(500).json({ error: 'Failed to sync procurement payables' });
  }
}

module.exports = {
  poGrandTotal,
  createOutwardFromSource,
  applyReceiptToSource,
  syncProcurementPayables,
  pushFromSourceHandler,
  syncProcurementHandler,
};

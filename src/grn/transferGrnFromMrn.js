/**
 * Bridge: when a warehouse transfer (MRN, source='MTR') is completed, emit an inbound GRN
 * with receipt_source='transfer' so the received goods run through the same GRN receipt
 * wizard (Confirm Receipt → … → Complete) as PO receipts.
 *
 * Idempotent — one GRN per MRN, keyed on goods_received_notes.mrn_id.
 */

const db = require('../../db');
const GoodsReceivedNote = require('./models');

let mrnIdColumnEnsured = false;
async function ensureGrnMrnIdColumn() {
  if (mrnIdColumnEnsured) return;
  mrnIdColumnEnsured = true;
  try {
    if (db.getDialect && db.getDialect() === 'postgres') {
      await db.query('ALTER TABLE goods_received_notes ADD COLUMN IF NOT EXISTS mrn_id INTEGER');
    }
  } catch (e) {
    console.warn('[grn] ensure mrn_id column skipped:', e && e.message ? e.message : e);
  }
}

function pad4(n) {
  return String(n).padStart(4, '0');
}

function inferGrnType(lineItems) {
  const list = Array.isArray(lineItems) ? lineItems : [];
  const anyRm = list.some((l) => l.raw_material_id != null);
  const anyPm = list.some((l) => l.pack_material_id != null);
  if (anyRm && !anyPm) return 'RM';
  if (anyPm && !anyRm) return 'PM';
  return anyRm ? 'RM' : anyPm ? 'PM' : null;
}

/** Map MRN line items into the GRN line-item shape (transferred qty seeds poQty/shippedQty). */
function transferGrnLineItems(mrnLineItems) {
  return (Array.isArray(mrnLineItems) ? mrnLineItems : []).map((l) => {
    const qty = Number(l.quantity ?? l.qty) || 0;
    const li = {
      item: l.item || '',
      itemCode: l.itemCode || l.code || '',
      poQty: qty,
      shippedQty: qty,
      rcvdQty: 0,
      invoiceQty: 0,
    };
    if (l.raw_material_id != null) li.raw_material_id = l.raw_material_id;
    if (l.pack_material_id != null) li.pack_material_id = l.pack_material_id;
    if (l.unit) li.unit = l.unit;
    return li;
  });
}

/**
 * Create the inbound transfer GRN for a just-completed MRN. Returns the GRN row (new or the
 * pre-existing one for this MRN), or null when the input isn't a completable transfer.
 * @param {Record<string, unknown>} mrnPlain plain MRN row (post-completion)
 */
async function createTransferGrnFromMrn(mrnPlain) {
  if (!mrnPlain || mrnPlain.id == null) return null;
  await ensureGrnMrnIdColumn();
  const mrnId = Number(mrnPlain.id);

  // Idempotency — one transfer GRN per MRN.
  const [existing] = await db.query(
    'SELECT id FROM goods_received_notes WHERE mrn_id = :mrnId AND deleted_at IS NULL LIMIT 1',
    { replacements: { mrnId } },
  );
  if (existing && existing[0] && existing[0].id) {
    return GoodsReceivedNote.findByPk(existing[0].id);
  }

  const lineItems = transferGrnLineItems(mrnPlain.line_items);
  const mrnNo = mrnPlain.mrn_no != null ? String(mrnPlain.mrn_no).trim() : '';

  const grn = await GoodsReceivedNote.create({
    grn_no: 'GRN-PENDING',
    mrn_id: mrnId,
    receipt_source: 'transfer',
    // Quality routing treats poNo as the BMR ref for transfer-source GRNs.
    po_no: (mrnPlain.bmr_no && String(mrnPlain.bmr_no).trim()) || mrnNo || null,
    vendor: mrnNo ? `Transfer ${mrnNo}` : 'Internal Transfer',
    type: inferGrnType(lineItems),
    items: lineItems.length,
    // Starts in transit — the destination receives it via the GRN's own Confirm (arrival) action,
    // then runs the standard receipt wizard. No separate acceptance step outside the GRN table.
    stage: 'in_transit',
    status: 'In Transit',
    line_items: lineItems,
    no_of_boxes: mrnPlain.no_of_boxes != null ? Number(mrnPlain.no_of_boxes) : null,
    units_per_box: mrnPlain.units_per_box != null ? Number(mrnPlain.units_per_box) : null,
    location_zone: mrnPlain.mu_receive_zone || null,
    location_prefix: mrnPlain.mu_receive_rack || mrnPlain.location_prefix || null,
    grn_batch_mfg: mrnPlain.grn_batch_mfg || null,
    expiry: mrnPlain.expiry || null,
    mfg_batch: mrnPlain.mfg_batch || null,
    workflow_steps: [],
    source_documents: mrnNo ? { to_ref: { ref: mrnNo } } : null,
  });

  grn.grn_no = `GRN-TR-${new Date().getFullYear()}-${pad4(grn.id)}`;
  await grn.save();
  return grn;
}

module.exports = { createTransferGrnFromMrn, ensureGrnMrnIdColumn };

/**
 * 3-way match engine (Flowchart Sub-flow I): PO ↔ GRN ↔ Invoice.
 *
 * Pure functions — no DB. Given the PO's ordered lines, the aggregated GRN
 * received/billed quantities per item, and the accepted invoice amount, produce
 * a per-line + overall reconciliation with a pass / variance verdict.
 *
 * Classic rule: billed ≤ received ≤ ordered. Anything outside tolerance flags.
 */

// Tolerances (overridable by caller).
const QTY_TOLERANCE = 0.001; // absolute qty epsilon
const AMOUNT_TOLERANCE_PCT = 2; // ±2% on payable amount

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normCode(v) {
  return String(v ?? '').trim().toLowerCase();
}

/** Extract ordered lines from a PO items JSON array. */
function orderedLinesFromPoItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((raw, idx) => {
    const ln = raw || {};
    const code = String(ln.itemCode ?? ln.code ?? ln.sku ?? '').trim();
    const name = String(ln.itemName ?? ln.name ?? ln.item ?? (code || `Line ${idx + 1}`));
    const qty = num(ln.quantity ?? ln.qty ?? ln.reqQty);
    const rate = num(ln.rate ?? ln.pricePerUnit ?? ln.unitPrice ?? ln.price);
    const taxPct = num(ln.tax ?? ln.gstPercent ?? ln.taxPercent);
    return { code, name, orderedQty: qty, rate, taxPct, unit: String(ln.unit ?? '') };
  });
}

/**
 * Aggregate received + billed qty per item code across all GRNs for a PO.
 * grnRows: array of GRN plain rows, each with line_items[] {itemCode, rcvdQty, invoiceQty, unitPrice}.
 */
function aggregateGrnByItem(grnRows) {
  const map = new Map();
  for (const grn of grnRows || []) {
    const lines = Array.isArray(grn.line_items) ? grn.line_items : [];
    for (const raw of lines) {
      const ln = raw || {};
      const key = normCode(ln.itemCode ?? ln.code);
      if (!key) continue;
      const prev = map.get(key) || { receivedQty: 0, billedQty: 0, rate: 0 };
      prev.receivedQty += num(ln.rcvdQty ?? ln.receivedQty ?? ln.poQty);
      prev.billedQty += num(ln.invoiceQty ?? ln.billedQty);
      const r = num(ln.unitPrice ?? ln.rate);
      if (r > 0) prev.rate = r;
      map.set(key, prev);
    }
  }
  return map;
}

function lineVerdict(orderedQty, receivedQty, billedQty, qtyTol) {
  // billed ≤ received ≤ ordered (within tolerance)
  if (receivedQty - orderedQty > qtyTol) return 'over_received';
  if (billedQty - receivedQty > qtyTol) return 'over_billed';
  if (orderedQty - receivedQty > qtyTol) return 'short_received';
  return 'matched';
}

/**
 * Compute the full 3-way match.
 * @param {object} args
 *   poItems: PO items JSON array
 *   grnRows: array of GRN plain rows (line_items[])
 *   invoiceAmount: accepted vendor invoice amount (GST-inclusive), or null
 *   opts: { qtyTolerance, amountTolerancePct }
 */
function computeThreeWayMatch({ poItems, grnRows, invoiceAmount, opts } = {}) {
  const qtyTol = opts && Number.isFinite(opts.qtyTolerance) ? opts.qtyTolerance : QTY_TOLERANCE;
  const amtTolPct = opts && Number.isFinite(opts.amountTolerancePct) ? opts.amountTolerancePct : AMOUNT_TOLERANCE_PCT;

  const ordered = orderedLinesFromPoItems(poItems);
  const grnByItem = aggregateGrnByItem(grnRows);
  const seen = new Set();

  const lines = ordered.map((o) => {
    const key = normCode(o.code);
    seen.add(key);
    const g = grnByItem.get(key) || { receivedQty: 0, billedQty: 0, rate: 0 };
    const rate = o.rate > 0 ? o.rate : g.rate;
    const receivedQty = g.receivedQty;
    // If a vendor bill didn't carry per-line billed qty, treat received as billed.
    const billedQty = g.billedQty > 0 ? g.billedQty : receivedQty;
    const verdict = lineVerdict(o.orderedQty, receivedQty, billedQty, qtyTol);
    const withTax = (q) => q * rate * (1 + o.taxPct / 100);
    return {
      code: o.code,
      name: o.name,
      unit: o.unit,
      rate,
      taxPct: o.taxPct,
      orderedQty: o.orderedQty,
      receivedQty,
      billedQty,
      orderedValue: Math.round(withTax(o.orderedQty) * 100) / 100,
      receivedValue: Math.round(withTax(receivedQty) * 100) / 100,
      verdict,
      matched: verdict === 'matched',
    };
  });

  // GRN lines with no matching PO line (unexpected receipts).
  for (const [key, g] of grnByItem.entries()) {
    if (seen.has(key)) continue;
    lines.push({
      code: key, name: key, unit: '', rate: g.rate, taxPct: 0,
      orderedQty: 0, receivedQty: g.receivedQty, billedQty: g.billedQty || g.receivedQty,
      orderedValue: 0, receivedValue: Math.round(g.receivedQty * g.rate * 100) / 100,
      verdict: 'unexpected', matched: false,
    });
  }

  const poTotal = Math.round(lines.reduce((s, l) => s + l.orderedValue, 0) * 100) / 100;
  // Payable = value of what was actually received (GST-inclusive).
  const receivedPayable = Math.round(lines.reduce((s, l) => s + l.receivedValue, 0) * 100) / 100;
  const invoice = invoiceAmount != null && Number.isFinite(Number(invoiceAmount)) ? Number(invoiceAmount) : null;

  const qtyLinesOk = lines.every((l) => l.matched);
  let amountOk = true;
  let amountVariancePct = 0;
  if (invoice != null && receivedPayable > 0) {
    amountVariancePct = Math.round(((invoice - receivedPayable) / receivedPayable) * 10000) / 100;
    amountOk = Math.abs(amountVariancePct) <= amtTolPct;
  }

  const hasInvoice = invoice != null;
  let verdict;
  if (!hasInvoice) verdict = 'awaiting_invoice';
  else if (qtyLinesOk && amountOk) verdict = 'pass';
  else verdict = 'variance';

  return {
    lines,
    totals: {
      poTotal,
      receivedPayable,
      invoiceAmount: invoice,
      amountVariancePct,
      amountOk,
      qtyLinesOk,
    },
    verdict, // awaiting_invoice | pass | variance
  };
}

module.exports = {
  QTY_TOLERANCE,
  AMOUNT_TOLERANCE_PCT,
  orderedLinesFromPoItems,
  aggregateGrnByItem,
  computeThreeWayMatch,
};

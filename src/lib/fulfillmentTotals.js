/**
 * Pure: SO value = sum(orderedQty * unitPrice); RM qtyReserved = qtyPerUnit * plannedQty; PM qtyReserved = qty_per_unit * plannedQty.
 */
function computeSoValue(items) {
  const arr = Array.isArray(items) ? items : [];
  return arr.reduce((sum, item) => sum + (item.orderedQty || 0) * (item.unitPrice || 0), 0);
}

function computeRmQtyReserved(bomLine, plannedQty) {
  const qtyPerUnit = bomLine.quantity != null ? Number(bomLine.quantity) : (bomLine.pct_w_w != null ? Number(bomLine.pct_w_w) / 100 : 0);
  return qtyPerUnit * (Number(plannedQty) || 0);
}

function computePmQtyReserved(bomLine, plannedQty) {
  const qtyPerUnit = bomLine.qty_per_unit != null ? Number(bomLine.qty_per_unit) : (bomLine.quantity != null ? Number(bomLine.quantity) : 1);
  return qtyPerUnit * (Number(plannedQty) || 0);
}

module.exports = { computeSoValue, computeRmQtyReserved, computePmQtyReserved };

/**
 * Pure: per-line totalValue = qty * pricePerUnit; order total = sum of line totalValue.
 */
function computeItemTotalValue(qty, pricePerUnit) {
  const q = Number(qty) || 0;
  const p = Number(pricePerUnit) || 0;
  return q * p;
}

function computeOrderTotalValue(items) {
  const arr = Array.isArray(items) ? items : [];
  return arr.reduce((sum, it) => sum + (Number(it.totalValue) || 0), 0);
}

module.exports = { computeItemTotalValue, computeOrderTotalValue };

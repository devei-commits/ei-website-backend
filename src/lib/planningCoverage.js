/**
 * Pure: planning items-involved math.
 * RM qty = (sizeKg * pct)/100; kgPerUnit = totalKg/orderQty; unitsForBatch = sizeKg/kgPerUnit; PM qty = unitsForBatch * qtyPerUnit.
 * coverage = min(100, round(sih/totalRequired*100)); surplusShortage = sih - totalRequired.
 */
function computeRmQtyForBatch(sizeKg, pct) {
  const kg = Number(sizeKg) || 0;
  const p = Math.max(0, Number(pct) || 0);
  return (kg * p) / 100;
}

function computeKgPerUnit(totalKg, orderQty) {
  const kg = Number(totalKg) || 0;
  const u = parseInt(String(orderQty || '0').replace(/\D/g, ''), 10) || 0;
  return u > 0 && kg > 0 ? kg / u : 1;
}

function computeUnitsForBatch(sizeKg, kgPerUnit) {
  const kg = Number(sizeKg) || 0;
  const kpu = Number(kgPerUnit) || 0;
  return kpu > 0 ? kg / kpu : 0;
}

function computePmQtyForBatch(unitsForBatch, qtyPerUnit) {
  const u = Number(unitsForBatch) || 0;
  const q = qtyPerUnit != null && !Number.isNaN(Number(qtyPerUnit)) ? Number(qtyPerUnit) : 1;
  return u * q;
}

function computeCoverage(sih, totalRequired) {
  const s = Number(sih) || 0;
  const t = Number(totalRequired) || 0;
  return t > 0 ? Math.min(100, Math.round((s / t) * 100)) : 100;
}

function computeSurplusShortage(sih, totalRequired) {
  const s = Number(sih) || 0;
  const t = Number(totalRequired) || 0;
  return s - t;
}

module.exports = {
  computeRmQtyForBatch,
  computeKgPerUnit,
  computeUnitsForBatch,
  computePmQtyForBatch,
  computeCoverage,
  computeSurplusShortage,
};

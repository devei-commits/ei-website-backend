/**
 * Pure: rack utilisation totalSlots = levels * slots_total; utilisationPct = (storedCount / totalSlots) * 100.
 */
function toNum(x) {
  if (x == null) return 0;
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

function computeTotalSlots(levels, slotsTotal) {
  const l = toNum(levels) || 4;
  const s = toNum(slotsTotal) || 16;
  return l * s;
}

function computeRackUtilisationPct(levels, slotsTotal, storedCount) {
  const totalSlots = computeTotalSlots(levels, slotsTotal);
  const count = toNum(storedCount) || 0;
  return totalSlots > 0 ? Math.round((count / totalSlots) * 100) : 0;
}

module.exports = { computeTotalSlots, computeRackUtilisationPct };

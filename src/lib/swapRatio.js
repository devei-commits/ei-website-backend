/**
 * Pure math for universal swap ratio: new_pct = pct * swapRatio, remainder = pct * (1 - swapRatio).
 * Rounded to 2 decimals. swapRatio clamped to [0, 2].
 */
function applySwapRatioToPct(pct, swapRatio) {
  const p = Number(pct) || 0;
  const r = Math.max(0, Math.min(2, Number(swapRatio) ?? 1));
  return {
    newPct: Math.round(p * r * 100) / 100,
    remainderPct: Math.round(p * (1 - r) * 100) / 100,
  };
}

module.exports = { applySwapRatioToPct };

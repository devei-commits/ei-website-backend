/**
 * Mirrors EI-Admin `validateStagedPercents` for staged JSON stored in `payment_terms`.
 * - Sum must not exceed 100%.
 * - If any stage is non-zero, the three percents must sum to exactly 100%.
 * - 0 + 0 + 0 is allowed (e.g. "as per contract" / unset).
 * Non-JSON `payment_terms` (legacy text) is not validated here.
 */

function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/**
 * @param {string | null | undefined} raw
 * @returns {string | null} Error message, or null if OK / not applicable
 */
function validateStagedPaymentTermsJson(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  if (!s.startsWith('{')) return null;

  let o;
  try {
    o = JSON.parse(s);
  } catch {
    return 'payment_terms must be valid JSON when using staged percentages';
  }

  const a = clampPct(o.advance_pct ?? o.advancePct);
  const b = clampPct(o.pre_shipment_pct ?? o.preShipmentPct);
  const c = clampPct(o.post_shipment_pct ?? o.postShipmentPct);
  const t = a + b + c;

  if (t > 100.0001) {
    return `Advance + pre-shipment + post-shipment must total at most 100% (currently ${t.toFixed(1)}%).`;
  }
  if (a === 0 && b === 0 && c === 0) return null;
  if (Math.abs(t - 100) > 0.01) {
    return `Advance + pre-shipment + post-shipment must total exactly 100% (currently ${t.toFixed(1)}%).`;
  }
  return null;
}

module.exports = { validateStagedPaymentTermsJson, clampPct };

/**
 * Next internal master code: digits only (e.g. 00001), one global sequence per table.
 * Legacy alphanumeric codes are ignored when computing the max.
 */

/** Gap after the highest used numeric suffix — room for manual correction SKUs. */
const INTERNAL_MASTER_CODE_CORRECTION_MARGIN = 300;

function maxPureNumericCode(values) {
  let max = 0;
  for (const raw of values) {
    const s = String(raw ?? '').trim();
    if (!/^\d+$/.test(s)) continue;
    const n = parseInt(s, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * Next numeric suffix after the highest existing value in a series.
 * @param {number} maxExisting highest parsed suffix (0 when series is empty)
 * @returns {number}
 */
function nextNumericSuffixAfterMax(maxExisting) {
  const max = Number.isFinite(maxExisting) && maxExisting >= 0 ? maxExisting : 0;
  return max + 1 + INTERNAL_MASTER_CODE_CORRECTION_MARGIN;
}

/**
 * @param {string[]} values - existing code strings from DB
 * @param {number} [padLength=5]
 * @returns {string}
 */
function nextNumericCode(values, padLength = 5) {
  const next = nextNumericSuffixAfterMax(maxPureNumericCode(values));
  return String(next).padStart(padLength, '0');
}

module.exports = {
  INTERNAL_MASTER_CODE_CORRECTION_MARGIN,
  maxPureNumericCode,
  nextNumericSuffixAfterMax,
  nextNumericCode,
};

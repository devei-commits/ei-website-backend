/**
 * Next internal master code: digits only (e.g. 00001), one global sequence per table.
 * Legacy alphanumeric codes are ignored when computing the max.
 */

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
 * @param {string[]} values - existing code strings from DB
 * @param {number} [padLength=5]
 * @returns {string}
 */
function nextNumericCode(values, padLength = 5) {
  const next = maxPureNumericCode(values) + 1;
  return String(next).padStart(padLength, '0');
}

module.exports = { maxPureNumericCode, nextNumericCode };

/**
 * Merge human-readable rack/zone lists on warehouse_inventory (multiple storage locations per SKU).
 * Join uses middle-dot ( · ) for display; also accepts legacy comma/semicolon/pipe-separated values.
 */

function parseLocationTokens(existingStr) {
  if (existingStr == null) return [];
  const s = String(existingStr).trim();
  if (!s) return [];
  return s
    .split(/\s*\u00B7\s*|;\s*|,\s*|\|\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Append a rack or zone if not already listed (case-insensitive dedupe). */
function mergeLocationTokens(existingStr, newToken) {
  const t = String(newToken || '').trim();
  if (!t) {
    const ex = existingStr != null ? String(existingStr).trim() : '';
    return ex || null;
  }
  const tokens = [];
  const seen = new Set();
  const add = (v) => {
    const k = v.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      tokens.push(v);
    }
  };
  parseLocationTokens(existingStr).forEach(add);
  if (!seen.has(t.toLowerCase())) add(t);
  return tokens.length ? tokens.join(' · ') : t;
}

module.exports = { parseLocationTokens, mergeLocationTokens };

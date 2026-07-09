/**
 * Pure merge logic for quality spec rule rows — no DB access.
 * More-specific rows override less-specific rows sharing the same parameter name:
 * sub-sub-category > sub-category > category ("common").
 */

function normalizeSubCategory(raw) {
  return String(raw ?? '').trim();
}

function paramKey(row) {
  return String(row?.parameter ?? '').trim().toLowerCase();
}

/** Layers `overrideRows` on top of `baseRows`, dropping base rows whose parameter is redefined. */
function layerQualitySpecRuleRows(baseRows, overrideRows) {
  const base = Array.isArray(baseRows) ? baseRows : [];
  const override = Array.isArray(overrideRows) ? overrideRows : [];
  const overrideParams = new Set(override.map(paramKey).filter(Boolean));
  const keptBase = base.filter((row) => !overrideParams.has(paramKey(row)));
  return [...keptBase, ...override];
}

/** commonRows -> subRows -> (optional) subSubRows, each overriding the last by parameter name. */
function mergeQualitySpecRuleRows(commonRows, subRows, subSubRows) {
  const merged = layerQualitySpecRuleRows(commonRows, subRows);
  return subSubRows == null ? merged : layerQualitySpecRuleRows(merged, subSubRows);
}

module.exports = { normalizeSubCategory, mergeQualitySpecRuleRows, layerQualitySpecRuleRows };

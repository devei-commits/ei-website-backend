/**
 * Pure merge logic for quality spec rule rows — no DB access.
 * More-specific rows override less-specific rows sharing the same parameter name:
 * item > sub-sub-category > sub-category > category ("common").
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

/**
 * commonRows -> subRows -> (optional) subSubRows -> (optional) itemRows, each overriding the last
 * by parameter name. An item rule is the last word: it is written against one specific item, so it
 * beats every category-ladder rule that reaches that item.
 */
function mergeQualitySpecRuleRows(commonRows, subRows, subSubRows, itemRows) {
  let merged = layerQualitySpecRuleRows(commonRows, subRows);
  if (subSubRows != null) merged = layerQualitySpecRuleRows(merged, subSubRows);
  if (itemRows != null) merged = layerQualitySpecRuleRows(merged, itemRows);
  return merged;
}

module.exports = { normalizeSubCategory, mergeQualitySpecRuleRows, layerQualitySpecRuleRows };

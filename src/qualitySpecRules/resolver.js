/**
 * Pure merge logic for quality spec rule rows — no DB access.
 * Sub-category rows override category-level ("common") rows sharing the same parameter name.
 */

function normalizeSubCategory(raw) {
  return String(raw ?? '').trim();
}

function paramKey(row) {
  return String(row?.parameter ?? '').trim().toLowerCase();
}

function mergeQualitySpecRuleRows(commonRows, subRows) {
  const common = Array.isArray(commonRows) ? commonRows : [];
  const sub = Array.isArray(subRows) ? subRows : [];
  const subParams = new Set(sub.map(paramKey).filter(Boolean));
  const keptCommon = common.filter((row) => !subParams.has(paramKey(row)));
  return [...keptCommon, ...sub];
}

module.exports = { normalizeSubCategory, mergeQualitySpecRuleRows };

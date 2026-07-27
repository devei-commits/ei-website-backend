/**
 * Pure merge logic for technical spec rule rows (custom field defs) — no DB access.
 * More-specific rows override less-specific rows sharing the same field label:
 * sub-sub-category > sub-category > category ("common").
 */

function normalizeSubCategory(raw) {
  return String(raw ?? '').trim();
}

function fieldKey(row) {
  return String(row?.label ?? '').trim().toLowerCase();
}

/** Layers `overrideRows` on top of `baseRows`, dropping base rows whose label is redefined. */
function layerTechnicalSpecRuleRows(baseRows, overrideRows) {
  const base = Array.isArray(baseRows) ? baseRows : [];
  const override = Array.isArray(overrideRows) ? overrideRows : [];
  const overrideLabels = new Set(override.map(fieldKey).filter(Boolean));
  const keptBase = base.filter((row) => !overrideLabels.has(fieldKey(row)));
  return [...keptBase, ...override];
}

/** commonRows -> subRows -> (optional) subSubRows, each overriding the last by field label. */
function mergeTechnicalSpecRuleRows(commonRows, subRows, subSubRows) {
  const merged = layerTechnicalSpecRuleRows(commonRows, subRows);
  return subSubRows == null ? merged : layerTechnicalSpecRuleRows(merged, subSubRows);
}

module.exports = { normalizeSubCategory, mergeTechnicalSpecRuleRows, layerTechnicalSpecRuleRows };

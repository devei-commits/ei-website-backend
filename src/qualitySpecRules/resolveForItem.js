const QualitySpecRule = require('./models');

/**
 * Live-resolves the category-level ("common") and sub-category-level rule rows for one item's
 * context. Kept separate (not merged) so callers can reproduce the frontend's two-table display
 * (common table always shown, sub-category table shown only when a sub-category is set) —
 * see src/qualitySpecRules/resolver.js for the merged-view variant used by the /resolve endpoint.
 */
async function resolveEntityQualitySpecs(entityType, category, subCategory) {
  const cat = String(category || '').trim();
  if (!cat) return { commonRows: [], subRows: [] };
  const sub = String(subCategory || '').trim();

  const [commonRule, subRule] = await Promise.all([
    QualitySpecRule.findOne({ where: { entity_type: entityType, category: cat, sub_category: '' } }),
    sub
      ? QualitySpecRule.findOne({ where: { entity_type: entityType, category: cat, sub_category: sub } })
      : Promise.resolve(null),
  ]);

  return {
    commonRows: commonRule && Array.isArray(commonRule.rows) ? commonRule.rows : [],
    subRows: subRule && Array.isArray(subRule.rows) ? subRule.rows : [],
  };
}

/**
 * Same as resolveEntityQualitySpecs, but for PR sections where the sub-category-level rule
 * may live under a DIFFERENT category than the resolved one (see resolvePrSubSpecPath's legacy
 * path aliasing, e.g. "Skin Care::Cleansers" → "Cleansing::Facewash") — the category-level
 * ("common") rule always uses the un-aliased `category`, only the sub-category lookup uses
 * `subSpecPath` (if given).
 */
async function resolvePrEntityQualitySpecs(entityType, category, subCategory, subSpecPath) {
  const cat = String(category || '').trim();
  if (!cat) return { commonRows: [], subRows: [] };
  const aliasCat = subSpecPath && subSpecPath.category ? subSpecPath.category : cat;
  const aliasSub = subSpecPath && subSpecPath.subCategory ? subSpecPath.subCategory : String(subCategory || '').trim();

  const [commonRule, subRule] = await Promise.all([
    QualitySpecRule.findOne({ where: { entity_type: entityType, category: cat, sub_category: '' } }),
    aliasSub
      ? QualitySpecRule.findOne({ where: { entity_type: entityType, category: aliasCat, sub_category: aliasSub } })
      : Promise.resolve(null),
  ]);

  return {
    commonRows: commonRule && Array.isArray(commonRule.rows) ? commonRule.rows : [],
    subRows: subRule && Array.isArray(subRule.rows) ? subRule.rows : [],
  };
}

module.exports = { resolveEntityQualitySpecs, resolvePrEntityQualitySpecs };

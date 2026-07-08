const QualitySpecRule = require('./models');
const { layerQualitySpecRuleRows } = require('./resolver');

/**
 * Live-resolves the category-level ("common") and sub-category-level rule rows for one item's
 * context. Kept separate (not merged) so callers can reproduce the frontend's two-table display
 * (common table always shown, sub-category table shown only when a sub-category is set) —
 * see src/qualitySpecRules/resolver.js for the merged-view variant used by the /resolve endpoint.
 *
 * When `subSubCategory` is given (RM/PM only — a 3rd scoping level below sub-category), its rule
 * rows are layered on top of the sub-category rule's rows (by parameter name) before returning,
 * so callers that only know about {commonRows, subRows} keep working unchanged.
 */
async function resolveEntityQualitySpecs(entityType, category, subCategory, subSubCategory) {
  const cat = String(category || '').trim();
  if (!cat) return { commonRows: [], subRows: [] };
  const sub = String(subCategory || '').trim();
  const subSub = String(subSubCategory || '').trim();

  const [commonRule, subRule, subSubRule] = await Promise.all([
    QualitySpecRule.findOne({ where: { entity_type: entityType, category: cat, sub_category: '', sub_sub_category: '' } }),
    sub
      ? QualitySpecRule.findOne({ where: { entity_type: entityType, category: cat, sub_category: sub, sub_sub_category: '' } })
      : Promise.resolve(null),
    sub && subSub
      ? QualitySpecRule.findOne({ where: { entity_type: entityType, category: cat, sub_category: sub, sub_sub_category: subSub } })
      : Promise.resolve(null),
  ]);

  const subRows = subRule && Array.isArray(subRule.rows) ? subRule.rows : [];
  const subSubRows = subSubRule && Array.isArray(subSubRule.rows) ? subSubRule.rows : [];

  return {
    commonRows: commonRule && Array.isArray(commonRule.rows) ? commonRule.rows : [],
    subRows: subSubRows.length ? layerQualitySpecRuleRows(subRows, subSubRows) : subRows,
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
    QualitySpecRule.findOne({ where: { entity_type: entityType, category: cat, sub_category: '', sub_sub_category: '' } }),
    aliasSub
      ? QualitySpecRule.findOne({
          where: { entity_type: entityType, category: aliasCat, sub_category: aliasSub, sub_sub_category: '' },
        })
      : Promise.resolve(null),
  ]);

  return {
    commonRows: commonRule && Array.isArray(commonRule.rows) ? commonRule.rows : [],
    subRows: subRule && Array.isArray(subRule.rows) ? subRule.rows : [],
  };
}

module.exports = { resolveEntityQualitySpecs, resolvePrEntityQualitySpecs };

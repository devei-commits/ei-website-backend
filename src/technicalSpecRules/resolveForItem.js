const TechnicalSpecRule = require('./models');
const { mergeTechnicalSpecRuleRows } = require('./resolver');

/**
 * Live-resolves the category-level ("common"), sub-category-level and (optional) sub-sub-category
 * level TECHNICAL-spec rule rows for one item's context and returns them MERGED into a single
 * field-def array (more-specific scope overrides less-specific by field label). Mirrors the
 * DB-load shape used by resolveTechnicalSpecRules in ./controller.js and the structure of
 * qualitySpecRules/resolveForItem.js.
 *
 * When `subSubCategory` is given (RM/PM only — a 3rd scoping level below sub-category), its rule
 * rows are layered on top of the sub-category rows before returning.
 *
 * Returns a plain array of MasterCustomFieldDef-shaped objects (the merged TECH field defs).
 */
async function resolveEntityTechnicalSpecs(entityType, category, subCategory, subSubCategory) {
  const cat = String(category || '').trim();
  if (!cat) return [];
  const sub = String(subCategory || '').trim();
  const subSub = String(subSubCategory || '').trim();

  const [commonRule, subRule, subSubRule] = await Promise.all([
    TechnicalSpecRule.findOne({ where: { entity_type: entityType, category: cat, sub_category: '', sub_sub_category: '' } }),
    sub
      ? TechnicalSpecRule.findOne({ where: { entity_type: entityType, category: cat, sub_category: sub, sub_sub_category: '' } })
      : Promise.resolve(null),
    sub && subSub
      ? TechnicalSpecRule.findOne({ where: { entity_type: entityType, category: cat, sub_category: sub, sub_sub_category: subSub } })
      : Promise.resolve(null),
  ]);

  const commonRows = commonRule && Array.isArray(commonRule.rows) ? commonRule.rows : [];
  const subRows = subRule && Array.isArray(subRule.rows) ? subRule.rows : [];
  const subSubRows = subSubRule && Array.isArray(subSubRule.rows) ? subSubRule.rows : [];

  return mergeTechnicalSpecRuleRows(commonRows, subRows, subSub ? subSubRows : null);
}

module.exports = { resolveEntityTechnicalSpecs };

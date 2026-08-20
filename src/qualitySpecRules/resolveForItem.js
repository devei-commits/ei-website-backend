const QualitySpecRule = require('./models');
const { layerQualitySpecRuleRows } = require('./resolver');

/**
 * Rows of the rule written against exactly this item code, or [] when none exists.
 * Item rules are looked up by (entity_type, item_code) alone — the category ladder is irrelevant
 * once a rule names the item, and an item's category can change after the rule was written.
 */
async function findItemRule(entityType, itemCode) {
  const code = String(itemCode || '').trim();
  if (!code) return [];
  const rule = await QualitySpecRule.findOne({
    where: { entity_type: entityType, item_code: code },
  });
  return rule && Array.isArray(rule.rows) ? rule.rows : [];
}

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
/**
 * Rows of the category ladder for one scope triple, most-specific last.
 * Returns [] when no category is given — an item with no category has no ladder.
 */
async function ladderRows(entityType, category, subCategory, subSubCategory) {
  const cat = String(category || '').trim();
  if (!cat) return [];
  const sub = String(subCategory || '').trim();
  const subSub = String(subSubCategory || '').trim();
  const [commonRule, subRule, subSubRule] = await Promise.all([
    QualitySpecRule.findOne({ where: { entity_type: entityType, category: cat, sub_category: '', sub_sub_category: '', item_code: '' } }),
    sub
      ? QualitySpecRule.findOne({ where: { entity_type: entityType, category: cat, sub_category: sub, sub_sub_category: '', item_code: '' } })
      : Promise.resolve(null),
    sub && subSub
      ? QualitySpecRule.findOne({ where: { entity_type: entityType, category: cat, sub_category: sub, sub_sub_category: subSub, item_code: '' } })
      : Promise.resolve(null),
  ]);
  let rows = commonRule && Array.isArray(commonRule.rows) ? commonRule.rows : [];
  if (subRule && Array.isArray(subRule.rows)) rows = layerQualitySpecRuleRows(rows, subRule.rows);
  if (subSubRule && Array.isArray(subSubRule.rows)) rows = layerQualitySpecRuleRows(rows, subSubRule.rows);
  return rows;
}

async function resolveEntityQualitySpecs(entityType, category, subCategory, subSubCategory, itemCode, masterScope) {
  const cat = String(category || '').trim();
  const item = String(itemCode || '').trim();
  // An item rule stands on its own: it is written against this exact item, so it still applies when
  // the item has no category (uncategorised masters would otherwise resolve to nothing).
  if (!cat) {
    // No legacy category — an item with no functional category still has a masters-taxonomy scope,
    // which is exactly the 944-item RM case. Fall back to that ladder, then the item rule.
    const masterOnly = masterScope
      ? await ladderRows(entityType, masterScope.category, masterScope.subCategory, masterScope.subSubCategory)
      : [];
    const itemOnly = item ? await findItemRule(entityType, item) : [];
    const merged = itemOnly.length ? layerQualitySpecRuleRows(masterOnly, itemOnly) : masterOnly;
    return { commonRows: [], subRows: merged, itemRows: itemOnly };
  }
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
  const itemRows = item ? await findItemRule(entityType, item) : [];
  // Rules may be written in the MASTERS' vocabulary ('RAW MATERIALS' → 'SURFACTANTS' → 'ANIONIC')
  // as well as the legacy functional one ('Surfactant'). Both ladders are resolved and layered, so
  // neither vocabulary is orphaned; the master ladder is applied last because it is the one the
  // rules screen now authors against.
  const masterRows = masterScope
    ? await ladderRows(entityType, masterScope.category, masterScope.subCategory, masterScope.subSubCategory)
    : [];

  // Item rows are folded into subRows for the same reason subSubRows are: callers that only know
  // about {commonRows, subRows} keep rendering the two-table display unchanged, and still get the
  // item's overrides. `itemRows` is returned alongside for callers that want to show provenance.
  let effectiveSub = subSubRows.length ? layerQualitySpecRuleRows(subRows, subSubRows) : subRows;
  if (masterRows.length) effectiveSub = layerQualitySpecRuleRows(effectiveSub, masterRows);
  if (itemRows.length) effectiveSub = layerQualitySpecRuleRows(effectiveSub, itemRows);

  return {
    commonRows: commonRule && Array.isArray(commonRule.rows) ? commonRule.rows : [],
    subRows: effectiveSub,
    itemRows,
  };
}

/**
 * Same as resolveEntityQualitySpecs, but for PR sections where the sub-category-level rule
 * may live under a DIFFERENT category than the resolved one (see resolvePrSubSpecPath's legacy
 * path aliasing, e.g. "Skin Care::Cleansers" → "Cleansing::Facewash") — the category-level
 * ("common") rule always uses the un-aliased `category`, only the sub-category lookup uses
 * `subSpecPath` (if given).
 */
async function resolvePrEntityQualitySpecs(entityType, category, subCategory, subSpecPath, itemCode) {
  const cat = String(category || '').trim();
  const item = String(itemCode || '').trim();
  if (!cat) {
    const only = item ? await findItemRule(entityType, item) : [];
    return { commonRows: [], subRows: only, itemRows: only };
  }
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

  const baseSubRows = subRule && Array.isArray(subRule.rows) ? subRule.rows : [];
  const itemRows = item ? await findItemRule(entityType, item) : [];

  return {
    commonRows: commonRule && Array.isArray(commonRule.rows) ? commonRule.rows : [],
    subRows: itemRows.length ? layerQualitySpecRuleRows(baseSubRows, itemRows) : baseSubRows,
    itemRows,
  };
}

module.exports = { resolveEntityQualitySpecs, resolvePrEntityQualitySpecs, findItemRule, ladderRows };

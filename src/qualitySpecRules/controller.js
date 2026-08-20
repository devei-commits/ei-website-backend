const QualitySpecRule = require('./models');
const { normalizeSubCategory, mergeQualitySpecRuleRows } = require('./resolver');

// PR quality specs are split into 3 independent sections (bulk clearance, final/FG-ready
// clearance, dispatch specs) — each is its own rule namespace, matching how the frontend
// never merges them (separate hydrate/clone functions per section).
const VALID_ENTITY_TYPES = new Set(['RM', 'PM', 'PR_BULK_CLEARANCE', 'PR_FINAL_CLEARANCE', 'PR_DISPATCH_SPECS']);

function normalizeEntityType(raw) {
  return String(raw ?? '').trim().toUpperCase();
}

function normalizeCategory(raw) {
  return String(raw ?? '').trim();
}

function formatQualitySpecRule(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return {
    id: d.id,
    entityType: d.entity_type,
    category: d.category,
    subCategory: d.sub_category || '',
    subSubCategory: d.sub_sub_category || '',
    itemCode: d.item_code || '',
    /** Which rung of the ladder this rule sits on — drives the scope badge on the rules screen. */
    scope: d.item_code ? 'item' : d.sub_sub_category ? 'sub_sub_category' : d.sub_category ? 'sub_category' : 'category',
    rows: Array.isArray(d.rows) ? d.rows : [],
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

/**
 * GET /api/v1/quality-spec-rules?entityType=RM[&category=Surfactant][&subCategory=Anionic][&subSubCategory=UVA]
 * Lists rule rows for a rule-management screen. Passing subCategory/subSubCategory narrows to
 * that exact scope (used by the item-form "Add Custom Quality Spec" modal to find/merge into the
 * existing rule at a scope before upserting it).
 */
async function listQualitySpecRules(req, res) {
  try {
    const entityType = normalizeEntityType(req.query.entityType ?? req.query.entity_type);
    if (!VALID_ENTITY_TYPES.has(entityType)) {
      return res.status(400).json({ error: 'entityType must be one of RM, PM, PR' });
    }
    const where = { entity_type: entityType };
    const category = normalizeCategory(req.query.category);
    if (category) where.category = category;
    if (req.query.subCategory != null || req.query.sub_category != null) {
      where.sub_category = normalizeSubCategory(req.query.subCategory ?? req.query.sub_category);
    }
    if (req.query.subSubCategory != null || req.query.sub_sub_category != null) {
      where.sub_sub_category = normalizeSubCategory(req.query.subSubCategory ?? req.query.sub_sub_category);
    }
    // itemCode is a scope of its own, so it is filterable independently of the category ladder:
    // `?itemCode=1001150` finds that item's rule wherever its category currently points.
    if (req.query.itemCode != null || req.query.item_code != null) {
      where.item_code = normalizeSubCategory(req.query.itemCode ?? req.query.item_code);
    }
    const rows = await QualitySpecRule.findAll({
      where,
      order: [['category', 'ASC'], ['sub_category', 'ASC'], ['sub_sub_category', 'ASC'], ['item_code', 'ASC']],
    });
    res.json(rows.map(formatQualitySpecRule));
  } catch (err) {
    console.error('listQualitySpecRules error', err);
    res.status(500).json({ error: err.message || 'Failed to list quality spec rules' });
  }
}

/**
 * GET /api/v1/quality-spec-rules/resolve?entityType=RM&category=Surfactant&subCategory=Anionic[&subSubCategory=UVA]
 * Returns the merged rule rows an unlocked item in this category/sub-category/sub-sub-category
 * should show.
 */
async function resolveQualitySpecRules(req, res) {
  try {
    const entityType = normalizeEntityType(req.query.entityType ?? req.query.entity_type);
    if (!VALID_ENTITY_TYPES.has(entityType)) {
      return res.status(400).json({ error: 'entityType must be one of RM, PM, PR' });
    }
    const itemCode = normalizeSubCategory(req.query.itemCode ?? req.query.item_code);
    const category = normalizeCategory(req.query.category);
    if (!category && !itemCode) {
      return res.status(400).json({ error: 'category is required (or itemCode for an item-level rule)' });
    }
    const subCategory = normalizeSubCategory(req.query.subCategory ?? req.query.sub_category);
    const subSubCategory = normalizeSubCategory(req.query.subSubCategory ?? req.query.sub_sub_category);

    const [commonRule, subRule, subSubRule, itemRule] = await Promise.all([
      category
        ? QualitySpecRule.findOne({
            where: { entity_type: entityType, category, sub_category: '', sub_sub_category: '' },
          })
        : null,
      category && subCategory
        ? QualitySpecRule.findOne({
            where: { entity_type: entityType, category, sub_category: subCategory, sub_sub_category: '' },
          })
        : null,
      category && subCategory && subSubCategory
        ? QualitySpecRule.findOne({
            where: { entity_type: entityType, category, sub_category: subCategory, sub_sub_category: subSubCategory },
          })
        : null,
      itemCode
        ? QualitySpecRule.findOne({ where: { entity_type: entityType, item_code: itemCode } })
        : null,
    ]);

    const commonRows = commonRule ? formatQualitySpecRule(commonRule).rows : [];
    const subRows = subRule ? formatQualitySpecRule(subRule).rows : [];
    const subSubRows = subSubRule ? formatQualitySpecRule(subSubRule).rows : [];
    const itemRows = itemRule ? formatQualitySpecRule(itemRule).rows : [];

    res.json({
      entityType,
      category,
      subCategory,
      subSubCategory,
      itemCode,
      commonRows,
      subRows,
      subSubRows,
      itemRows,
      rows: mergeQualitySpecRuleRows(commonRows, subRows, subSubRows, itemRows),
    });
  } catch (err) {
    console.error('resolveQualitySpecRules error', err);
    res.status(500).json({ error: err.message || 'Failed to resolve quality spec rules' });
  }
}

/**
 * PUT /api/v1/quality-spec-rules — upsert a rule.
 * Keyed by (entityType, itemCode) for an item rule, else (entityType, category, subCategory, subSubCategory).
 * Body: { entityType, category?, subCategory?, subSubCategory?, itemCode?, rows: [...] }
 */
async function upsertQualitySpecRule(req, res) {
  try {
    const b = req.body || {};
    const entityType = normalizeEntityType(b.entityType ?? b.entity_type);
    if (!VALID_ENTITY_TYPES.has(entityType)) {
      return res.status(400).json({ error: 'entityType must be one of RM, PM, PR' });
    }
    const itemCode = normalizeSubCategory(b.itemCode ?? b.item_code);
    const category = normalizeCategory(b.category);
    // An item rule is keyed by the item, so it does not need a category. Requiring one would break
    // the moment the item is recategorised, leaving an orphaned rule that no longer resolves.
    if (!category && !itemCode) {
      return res.status(400).json({ error: 'category is required (or itemCode for an item-level rule)' });
    }
    const subCategory = normalizeSubCategory(b.subCategory ?? b.sub_category);
    const subSubCategory = normalizeSubCategory(b.subSubCategory ?? b.sub_sub_category);
    if (subSubCategory && !subCategory) {
      return res.status(400).json({ error: 'subCategory is required when subSubCategory is set' });
    }
    const rows = Array.isArray(b.rows) ? b.rows : [];

    // Item rules are identified by (entityType, itemCode) alone — matching how they are resolved —
    // so re-saving after the item moves category updates the same rule instead of orphaning it.
    const where = itemCode
      ? { entity_type: entityType, item_code: itemCode }
      : { entity_type: entityType, category, sub_category: subCategory, sub_sub_category: subSubCategory, item_code: '' };

    const [row] = await QualitySpecRule.findOrCreate({
      where,
      defaults: { rows, category: category || '', sub_category: subCategory, sub_sub_category: subSubCategory },
    });
    // Keep the category columns current for item rules so the rules screen can still group them.
    await row.update(
      itemCode ? { rows, category: category || row.category || '', sub_category: subCategory, sub_sub_category: subSubCategory } : { rows },
    );
    res.json(formatQualitySpecRule(row));
  } catch (err) {
    console.error('upsertQualitySpecRule error', err);
    res.status(500).json({ error: err.message || 'Failed to save quality spec rule' });
  }
}

/** DELETE /api/v1/quality-spec-rules/:id */
async function deleteQualitySpecRule(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await QualitySpecRule.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Quality spec rule not found' });
    await row.destroy();
    res.json({ ok: true });
  } catch (err) {
    console.error('deleteQualitySpecRule error', err);
    res.status(500).json({ error: err.message || 'Failed to delete quality spec rule' });
  }
}

/**
 * GET /api/v1/quality-spec-rules/pm-scopes — the category / sub-category scopes that PACK MATERIALS
 * actually resolve to, with how many items sit in each.
 *
 * The rules screen previously offered only the static schema vocabulary, so a scope the master
 * displays but the schema never defined ("Labels", "Self-Adhesive Labels" — legacy imported values)
 * could not be picked, and a rule written for it would not have matched anyway. Deriving the option
 * list from the items themselves guarantees every offered scope reaches at least one item, and that
 * everything a user sees on a master is offered here.
 */
async function listPmRuleScopes(req, res) {
  try {
    const entityType = normalizeEntityType(req.query.entityType ?? req.query.entity_type) || 'PM';
    const isRm = entityType === 'RM';
    const Model = isRm ? require('../rawMaterials/models') : require('../packMaterials/models');
    // Resolve in the MASTERS' vocabulary — the same one the rules screen now offers. Using the
    // legacy functional resolver here made the two disagree: the dropdown listed "RAW MATERIALS"
    // while the count claimed 944 items had no category, because almost nothing resolves to a
    // legacy category.
    const resolve = isRm
      ? (plain) => {
          const { resolveRmMasterScopeFromRow } = require('./rmCategoryResolve');
          return resolveRmMasterScopeFromRow({
            category: plain.category,
            group: plain.group,
            form_data: plain.form_data,
          });
        }
      : (plain) => {
          const { resolvePmMasterScopeFromRow } = require('./pmCategoryResolve');
          return resolvePmMasterScopeFromRow(plain);
        };
    const attributes = isRm
      ? ['code', 'category', 'group', 'form_data']
      : ['code', 'group', 'material', 'form_data'];
    const rows = await Model.findAll({ attributes });
    const byScope = new Map();
    // Items that resolve to no category at all cannot be reached by ANY category rule — only an
    // item-scoped rule reaches them. Counted separately so the UI can say so instead of hiding it.
    let uncategorised = 0;
    for (const row of rows) {
      const plain = row.get ? row.get({ plain: true }) : row;
      const { category, subCategory } = resolve(plain);
      if (!category) { uncategorised += 1; continue; }
      const key = `${category}\u0000${subCategory || ''}`;
      const hit = byScope.get(key) || { category, subCategory: subCategory || '', itemCount: 0 };
      hit.itemCount += 1;
      byScope.set(key, hit);
    }
    const scopes = [...byScope.values()].sort(
      (a, b) => a.category.localeCompare(b.category) || a.subCategory.localeCompare(b.subCategory),
    );
    res.json({ scopes, uncategorisedItemCount: uncategorised, totalItemCount: rows.length });
  } catch (err) {
    console.error('listPmRuleScopes error', err);
    res.status(500).json({ error: err.message || 'Failed to list PM rule scopes' });
  }
}

module.exports = {
  listPmRuleScopes,
  listQualitySpecRules,
  resolveQualitySpecRules,
  upsertQualitySpecRule,
  deleteQualitySpecRule,
};

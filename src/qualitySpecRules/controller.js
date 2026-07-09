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
    const rows = await QualitySpecRule.findAll({
      where,
      order: [['category', 'ASC'], ['sub_category', 'ASC'], ['sub_sub_category', 'ASC']],
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
    const category = normalizeCategory(req.query.category);
    if (!category) {
      return res.status(400).json({ error: 'category is required' });
    }
    const subCategory = normalizeSubCategory(req.query.subCategory ?? req.query.sub_category);
    const subSubCategory = normalizeSubCategory(req.query.subSubCategory ?? req.query.sub_sub_category);

    const [commonRule, subRule, subSubRule] = await Promise.all([
      QualitySpecRule.findOne({
        where: { entity_type: entityType, category, sub_category: '', sub_sub_category: '' },
      }),
      subCategory
        ? QualitySpecRule.findOne({
            where: { entity_type: entityType, category, sub_category: subCategory, sub_sub_category: '' },
          })
        : null,
      subCategory && subSubCategory
        ? QualitySpecRule.findOne({
            where: { entity_type: entityType, category, sub_category: subCategory, sub_sub_category: subSubCategory },
          })
        : null,
    ]);

    const commonRows = commonRule ? formatQualitySpecRule(commonRule).rows : [];
    const subRows = subRule ? formatQualitySpecRule(subRule).rows : [];
    const subSubRows = subSubRule ? formatQualitySpecRule(subSubRule).rows : [];

    res.json({
      entityType,
      category,
      subCategory,
      subSubCategory,
      commonRows,
      subRows,
      subSubRows,
      rows: mergeQualitySpecRuleRows(commonRows, subRows, subSubRows),
    });
  } catch (err) {
    console.error('resolveQualitySpecRules error', err);
    res.status(500).json({ error: err.message || 'Failed to resolve quality spec rules' });
  }
}

/**
 * PUT /api/v1/quality-spec-rules — upsert a rule by (entityType, category, subCategory, subSubCategory).
 * Body: { entityType, category, subCategory?, subSubCategory?, rows: [...] }
 */
async function upsertQualitySpecRule(req, res) {
  try {
    const b = req.body || {};
    const entityType = normalizeEntityType(b.entityType ?? b.entity_type);
    if (!VALID_ENTITY_TYPES.has(entityType)) {
      return res.status(400).json({ error: 'entityType must be one of RM, PM, PR' });
    }
    const category = normalizeCategory(b.category);
    if (!category) {
      return res.status(400).json({ error: 'category is required' });
    }
    const subCategory = normalizeSubCategory(b.subCategory ?? b.sub_category);
    const subSubCategory = normalizeSubCategory(b.subSubCategory ?? b.sub_sub_category);
    if (subSubCategory && !subCategory) {
      return res.status(400).json({ error: 'subCategory is required when subSubCategory is set' });
    }
    const rows = Array.isArray(b.rows) ? b.rows : [];

    const [row] = await QualitySpecRule.findOrCreate({
      where: { entity_type: entityType, category, sub_category: subCategory, sub_sub_category: subSubCategory },
      defaults: { rows },
    });
    await row.update({ rows });
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

module.exports = {
  listQualitySpecRules,
  resolveQualitySpecRules,
  upsertQualitySpecRule,
  deleteQualitySpecRule,
};

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
    rows: Array.isArray(d.rows) ? d.rows : [],
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

/**
 * GET /api/v1/quality-spec-rules?entityType=RM[&category=Surfactant]
 * Lists rule rows for a rule-management screen.
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
    const rows = await QualitySpecRule.findAll({
      where,
      order: [['category', 'ASC'], ['sub_category', 'ASC']],
    });
    res.json(rows.map(formatQualitySpecRule));
  } catch (err) {
    console.error('listQualitySpecRules error', err);
    res.status(500).json({ error: err.message || 'Failed to list quality spec rules' });
  }
}

/**
 * GET /api/v1/quality-spec-rules/resolve?entityType=RM&category=Surfactant&subCategory=Anionic
 * Returns the merged rule rows an unlocked item in this category/sub-category should show.
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

    const commonRule = await QualitySpecRule.findOne({
      where: { entity_type: entityType, category, sub_category: '' },
    });
    const subRule = subCategory
      ? await QualitySpecRule.findOne({
          where: { entity_type: entityType, category, sub_category: subCategory },
        })
      : null;

    const commonRows = commonRule ? formatQualitySpecRule(commonRule).rows : [];
    const subRows = subRule ? formatQualitySpecRule(subRule).rows : [];

    res.json({
      entityType,
      category,
      subCategory,
      commonRows,
      subRows,
      rows: mergeQualitySpecRuleRows(commonRows, subRows),
    });
  } catch (err) {
    console.error('resolveQualitySpecRules error', err);
    res.status(500).json({ error: err.message || 'Failed to resolve quality spec rules' });
  }
}

/**
 * PUT /api/v1/quality-spec-rules — upsert a rule by (entityType, category, subCategory).
 * Body: { entityType, category, subCategory?, rows: [...] }
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
    const rows = Array.isArray(b.rows) ? b.rows : [];

    const [row] = await QualitySpecRule.findOrCreate({
      where: { entity_type: entityType, category, sub_category: subCategory },
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

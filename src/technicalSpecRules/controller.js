const TechnicalSpecRule = require('./models');
const { normalizeSubCategory, mergeTechnicalSpecRuleRows } = require('./resolver');

// Technical specs (TECH custom fields) are per material/product — RM, PM, PR. Unlike quality
// specs, PR is a single namespace here (no bulk/final/dispatch split): a product's technical
// spec is the same regardless of clearance stage.
const VALID_ENTITY_TYPES = new Set(['RM', 'PM', 'PR']);
const VALID_FIELD_TYPES = new Set([
  'text', 'textarea', 'number', 'date', 'select', 'boolean', 'pass-fail', 'attachment',
]);

function normalizeEntityType(raw) {
  return String(raw ?? '').trim().toUpperCase();
}

function normalizeCategory(raw) {
  return String(raw ?? '').trim();
}

/** Coerce an incoming row into a clean MasterCustomFieldDef, dropping malformed entries. */
function normalizeFieldRow(row, index) {
  if (!row || typeof row !== 'object') return null;
  const label = String(row.label ?? '').trim().replace(/\s+/g, ' ');
  if (!label) return null;
  const type = VALID_FIELD_TYPES.has(row.type) ? row.type : 'text';
  const out = {
    id: String(row.id ?? '').trim() || `cf-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
    label,
    type,
  };
  if (row.required === true) out.required = true;
  if (typeof row.unit === 'string' && row.unit.trim()) out.unit = row.unit.trim();
  if (Array.isArray(row.options)) {
    const opts = row.options.map((o) => String(o ?? '').trim()).filter(Boolean);
    if (opts.length) out.options = opts;
  }
  return out;
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  const seen = new Set();
  rows.forEach((row, i) => {
    const clean = normalizeFieldRow(row, i);
    if (!clean) return;
    const key = clean.label.toLowerCase();
    if (seen.has(key)) return; // dedupe by label within a single rule
    seen.add(key);
    out.push(clean);
  });
  return out;
}

function formatTechnicalSpecRule(row) {
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
 * GET /api/v1/technical-spec-rules?entityType=RM[&category=Surfactant][&subCategory=Anionic][&subSubCategory=UVA]
 * Lists rule rows for the rule-management dashboard. subCategory/subSubCategory narrow to that exact scope.
 */
async function listTechnicalSpecRules(req, res) {
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
    const rows = await TechnicalSpecRule.findAll({
      where,
      order: [['category', 'ASC'], ['sub_category', 'ASC'], ['sub_sub_category', 'ASC']],
    });
    res.json(rows.map(formatTechnicalSpecRule));
  } catch (err) {
    console.error('listTechnicalSpecRules error', err);
    res.status(500).json({ error: err.message || 'Failed to list technical spec rules' });
  }
}

/**
 * GET /api/v1/technical-spec-rules/resolve?entityType=RM&category=Surfactant&subCategory=Anionic[&subSubCategory=UVA]
 * Returns the merged custom-field defs an unlocked item in this category should show.
 */
async function resolveTechnicalSpecRules(req, res) {
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
      TechnicalSpecRule.findOne({
        where: { entity_type: entityType, category, sub_category: '', sub_sub_category: '' },
      }),
      subCategory
        ? TechnicalSpecRule.findOne({
            where: { entity_type: entityType, category, sub_category: subCategory, sub_sub_category: '' },
          })
        : null,
      subCategory && subSubCategory
        ? TechnicalSpecRule.findOne({
            where: { entity_type: entityType, category, sub_category: subCategory, sub_sub_category: subSubCategory },
          })
        : null,
    ]);

    const commonRows = commonRule ? formatTechnicalSpecRule(commonRule).rows : [];
    const subRows = subRule ? formatTechnicalSpecRule(subRule).rows : [];
    const subSubRows = subSubRule ? formatTechnicalSpecRule(subSubRule).rows : [];

    res.json({
      entityType,
      category,
      subCategory,
      subSubCategory,
      commonRows,
      subRows,
      subSubRows,
      rows: mergeTechnicalSpecRuleRows(commonRows, subRows, subSubRows),
    });
  } catch (err) {
    console.error('resolveTechnicalSpecRules error', err);
    res.status(500).json({ error: err.message || 'Failed to resolve technical spec rules' });
  }
}

/**
 * PUT /api/v1/technical-spec-rules — upsert a rule by (entityType, category, subCategory, subSubCategory).
 * Body: { entityType, category, subCategory?, subSubCategory?, rows: [MasterCustomFieldDef...] }
 */
async function upsertTechnicalSpecRule(req, res) {
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
    const rows = normalizeRows(b.rows);

    const [row] = await TechnicalSpecRule.findOrCreate({
      where: { entity_type: entityType, category, sub_category: subCategory, sub_sub_category: subSubCategory },
      defaults: { rows },
    });
    await row.update({ rows });
    res.json(formatTechnicalSpecRule(row));
  } catch (err) {
    console.error('upsertTechnicalSpecRule error', err);
    res.status(500).json({ error: err.message || 'Failed to save technical spec rule' });
  }
}

/** DELETE /api/v1/technical-spec-rules/:id */
async function deleteTechnicalSpecRule(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await TechnicalSpecRule.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Technical spec rule not found' });
    await row.destroy();
    res.json({ ok: true });
  } catch (err) {
    console.error('deleteTechnicalSpecRule error', err);
    res.status(500).json({ error: err.message || 'Failed to delete technical spec rule' });
  }
}

module.exports = {
  listTechnicalSpecRules,
  resolveTechnicalSpecRules,
  upsertTechnicalSpecRule,
  deleteTechnicalSpecRule,
};

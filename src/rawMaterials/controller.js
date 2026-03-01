const RawMaterial = require('./models');
const { Op } = require('sequelize');

/** List-view only (no form_data). */
function formatRawMaterial(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return {
    id: String(d.id),
    code: d.code,
    name: d.name,
    inci: d.inci,
    category: d.category,
    rm_type: d.rm_type,
    uom: d.uom,
    price_per_kg: d.price_per_kg != null ? Number(d.price_per_kg) : null,
    gst: d.gst != null ? Number(d.gst) : null,
    shelf: d.shelf,
    status: d.status,
    products: Array.isArray(d.products) ? d.products : [],
    group: d.group,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

/** Full row for edit (includes form_data). */
function formatRawMaterialFull(row) {
  const base = formatRawMaterial(row);
  if (!base) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return { ...base, form_data: d.form_data ?? null };
}

/**
 * GET /api/v1/raw-materials — list all raw materials, optional ?search= for filter.
 * Search matches code, name, inci, category (case-insensitive).
 */
async function listRawMaterials(req, res) {
  try {
    const search = req.query.search != null ? String(req.query.search).trim() : '';
    const where = {};

    if (search.length > 0) {
      const like = { [Op.iLike]: `%${search}%` };
      where[Op.or] = [
        { code: like },
        { name: like },
        { inci: like },
        { category: like },
        { rm_type: like },
      ];
    }

    const rows = await RawMaterial.findAll({
      where,
      order: [['code', 'ASC']],
    });
    const list = rows.map(formatRawMaterial);
    res.json(list);
  } catch (err) {
    console.error('listRawMaterials error', err);
    res.status(500).json({ error: 'Failed to list raw materials' });
  }
}

/**
 * GET /api/v1/raw-materials/:id — get one by id. Returns list-view + form_data for edit.
 */
async function getRawMaterialById(req, res) {
  try {
    const id = req.params.id;
    const row = await RawMaterial.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Raw material not found' });
    res.json(formatRawMaterialFull(row));
  } catch (err) {
    console.error('getRawMaterialById error', err);
    res.status(500).json({ error: 'Failed to get raw material' });
  }
}

/** Extract list-view fields + form_data from frontend form payload. */
function payloadToListFields(b) {
  const fd = b.form_data || b;
  const listFields = {
    code: fd.rmSku ?? fd.code ?? '',
    name: fd.inciName ?? fd.tradeCommercialName ?? fd.name ?? '',
    inci: fd.inciName ?? fd.inci ?? '',
    category: fd.rmCategory ?? fd.category ?? null,
    rm_type: fd.rmType ?? fd.rm_type ?? null,
    uom: fd.primaryUom ?? fd.uom ?? null,
    price_per_kg: fd.price_per_kg ?? (fd.pricePerKg != null ? Number(fd.pricePerKg) : null),
    gst: fd.gst != null ? Number(fd.gst) : null,
    shelf: fd.shelfLife ?? fd.retestPeriod ?? fd.shelf ?? null,
    status: (fd.status && String(fd.status).toLowerCase() === 'inactive') ? 'inactive' : 'active',
    products: Array.isArray(fd.products) ? fd.products : [],
    group: fd.group ?? null,
  };
  const form_data = b.form_data !== undefined ? b.form_data : (typeof fd.rmSku !== 'undefined' || typeof fd.inciName !== 'undefined' ? fd : null);
  return { ...listFields, form_data };
}

/**
 * POST /api/v1/raw-materials — create. Body: full form payload (formData shape) or { form_data: {...} }.
 */
async function createRawMaterial(req, res) {
  try {
    const b = req.body || {};
    const fields = payloadToListFields(b);
    const row = await RawMaterial.create(fields);
    res.status(201).json(formatRawMaterialFull(row));
  } catch (err) {
    console.error('createRawMaterial error', err);
    res.status(500).json({ error: err.message || 'Failed to create raw material' });
  }
}

/**
 * PUT /api/v1/raw-materials/:id — update. Body: full form payload or { form_data: {...} }.
 */
async function updateRawMaterial(req, res) {
  try {
    const row = await RawMaterial.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Raw material not found' });
    const b = req.body || {};
    const fields = payloadToListFields(b);
    await row.update(fields);
    res.json(formatRawMaterialFull(row));
  } catch (err) {
    console.error('updateRawMaterial error', err);
    res.status(500).json({ error: err.message || 'Failed to update raw material' });
  }
}

/**
 * DELETE /api/v1/raw-materials/:id — delete.
 */
async function deleteRawMaterial(req, res) {
  try {
    const row = await RawMaterial.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Raw material not found' });
    await row.destroy();
    res.status(204).send();
  } catch (err) {
    console.error('deleteRawMaterial error', err);
    res.status(500).json({ error: err.message || 'Failed to delete raw material' });
  }
}

module.exports = {
  listRawMaterials,
  getRawMaterialById,
  createRawMaterial,
  updateRawMaterial,
  deleteRawMaterial,
  formatRawMaterial,
};

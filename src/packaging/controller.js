const Packaging = require('./models');
const { Op } = require('sequelize');

/**
 * Format DB row for API response (id as string for frontend compatibility).
 */
function formatPackaging(row) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return {
    id: String(d.id),
    package_code: d.package_code,
    package_name: d.package_name,
    package_sku: d.package_sku,
    bottom: d.bottom,
    cap_type: d.cap_type,
    bottom_name: d.bottom_name,
    bottom_material: d.bottom_material,
    cap_name: d.cap_name,
    cap_material: d.cap_material,
    bottom_color: d.bottom_color,
    cap_color: d.cap_color,
    bottom_weight: d.bottom_weight,
    cap_weight: d.cap_weight,
    dispenser_volume: d.dispenser_volume,
    minimum_order_quantity: d.minimum_order_quantity,
    budget: d.budget,
    comments: d.comments,
    status: d.status || 'active',
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

/**
 * GET /api/v1/packaging — list with optional ?search= for dynamic filter (real-time search).
 * Search matches package_code, package_name, package_sku, cap_type, bottom, bottom_name, cap_name (case-insensitive).
 */
async function listPackaging(req, res) {
  try {
    const search = req.query.search != null ? String(req.query.search).trim() : '';
    const where = {};

    if (search.length > 0) {
      const like = { [Op.iLike]: `%${search}%` };
      where[Op.or] = [
        { package_code: like },
        { package_name: like },
        { package_sku: like },
        { cap_type: like },
        { bottom: like },
        { bottom_name: like },
        { cap_name: like },
        { bottom_material: like },
        { cap_material: like },
        { dispenser_volume: like },
        { minimum_order_quantity: like },
        { budget: like },
      ];
    }

    const list = await Packaging.findAll({
      where,
      order: [['id', 'ASC']],
    });

    res.status(200).json(list.map(formatPackaging));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/v1/packaging/:id — get one by id.
 */
async function getPackagingById(req, res) {
  try {
    const row = await Packaging.findByPk(req.params.id);
    if (!row) {
      return res.status(404).json({ error: 'Packaging not found' });
    }
    res.status(200).json(formatPackaging(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/v1/packaging — create packaging. Body: snake_case or camelCase fields.
 */
async function createPackaging(req, res) {
  try {
    const b = req.body || {};
    const row = await Packaging.create({
      package_code: b.package_code ?? b.packageCode ?? null,
      package_name: b.package_name ?? b.packageName ?? null,
      package_sku: b.package_sku ?? b.packageSKU ?? null,
      bottom: b.bottom ?? null,
      cap_type: b.cap_type ?? b.capType ?? null,
      bottom_name: b.bottom_name ?? b.bottomName ?? null,
      bottom_material: b.bottom_material ?? b.bottomMaterial ?? null,
      cap_name: b.cap_name ?? b.capName ?? null,
      cap_material: b.cap_material ?? b.capMaterial ?? null,
      bottom_color: b.bottom_color ?? b.bottomColor ?? null,
      cap_color: b.cap_color ?? b.capColor ?? null,
      bottom_weight: b.bottom_weight ?? b.bottomWeight ?? null,
      cap_weight: b.cap_weight ?? b.capWeight ?? null,
      dispenser_volume: b.dispenser_volume ?? b.dispenserVolume ?? null,
      minimum_order_quantity: b.minimum_order_quantity ?? b.minimumOrderQuantity ?? null,
      budget: b.budget ?? null,
      comments: b.comments ?? null,
      status: (b.status && (b.status === 'inactive' ? 'inactive' : 'active')) || 'active',
    });
    res.status(201).json(formatPackaging(row));
  } catch (err) {
    console.error('createPackaging error', err);
    res.status(500).json({ error: err.message || 'Failed to create packaging' });
  }
}

/**
 * PUT /api/v1/packaging/:id — update packaging.
 */
async function updatePackaging(req, res) {
  try {
    const row = await Packaging.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Packaging not found' });
    const b = req.body || {};
    await row.update({
      package_code: b.package_code ?? b.packageCode ?? row.package_code,
      package_name: b.package_name ?? b.packageName ?? row.package_name,
      package_sku: b.package_sku ?? b.packageSKU ?? row.package_sku,
      bottom: b.bottom ?? row.bottom,
      cap_type: b.cap_type ?? b.capType ?? row.cap_type,
      bottom_name: b.bottom_name ?? b.bottomName ?? row.bottom_name,
      bottom_material: b.bottom_material ?? b.bottomMaterial ?? row.bottom_material,
      cap_name: b.cap_name ?? b.capName ?? row.cap_name,
      cap_material: b.cap_material ?? b.capMaterial ?? row.cap_material,
      bottom_color: b.bottom_color ?? b.bottomColor ?? row.bottom_color,
      cap_color: b.cap_color ?? b.capColor ?? row.cap_color,
      bottom_weight: b.bottom_weight ?? b.bottomWeight ?? row.bottom_weight,
      cap_weight: b.cap_weight ?? b.capWeight ?? row.cap_weight,
      dispenser_volume: b.dispenser_volume ?? b.dispenserVolume ?? row.dispenser_volume,
      minimum_order_quantity: b.minimum_order_quantity ?? b.minimumOrderQuantity ?? row.minimum_order_quantity,
      budget: b.budget ?? row.budget,
      comments: b.comments ?? row.comments,
      status: (b.status && (b.status === 'inactive' ? 'inactive' : 'active')) || row.status,
    });
    res.status(200).json(formatPackaging(row));
  } catch (err) {
    console.error('updatePackaging error', err);
    res.status(500).json({ error: err.message || 'Failed to update packaging' });
  }
}

/**
 * DELETE /api/v1/packaging/:id — delete packaging.
 */
async function deletePackaging(req, res) {
  try {
    const row = await Packaging.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Packaging not found' });
    await row.destroy();
    res.status(204).send();
  } catch (err) {
    console.error('deletePackaging error', err);
    res.status(500).json({ error: err.message || 'Failed to delete packaging' });
  }
}

module.exports = {
  listPackaging,
  getPackagingById,
  createPackaging,
  updatePackaging,
  deletePackaging,
};

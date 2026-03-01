const { Packaging } = require('./models');
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

module.exports = {
  listPackaging,
  getPackagingById,
};

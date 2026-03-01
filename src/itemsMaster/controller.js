const ItemMaster = require('./models');
const BOM = require('../bom/models');
const PackMaterial = require('../packMaterials/models');
const RawMaterial = require('../rawMaterials/models');

function toIntList(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val.map((x) => (typeof x === 'number' ? x : parseInt(x, 10))).filter((n) => !Number.isNaN(n));
  const n = typeof val === 'number' ? val : parseInt(val, 10);
  return Number.isNaN(n) ? [] : [n];
}

function formatItemMaster(row, linked = {}) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  const boms = linked.boms || [];
  const packMaterials = linked.packMaterials || [];
  const rawMaterials = linked.rawMaterials || [];
  const firstName = (boms[0] && boms[0].name) || (packMaterials[0] && packMaterials[0].description) || (rawMaterials[0] && rawMaterials[0].name);
  return {
    id: String(d.id),
    code: d.code,
    name: d.name || firstName || d.code,
    type: d.type || 'product',
    status: d.status,
    bomIds: toIntList(d.bom_ids),
    rawMaterialIds: toIntList(d.raw_material_ids),
    packMaterialIds: toIntList(d.pack_material_ids),
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    linked: {
      boms: boms.map((b) => ({ id: b.id, code: b.bom_code, name: b.name })),
      packMaterials: packMaterials.map((p) => ({ id: p.id, code: p.code, description: p.description })),
      rawMaterials: rawMaterials.map((r) => ({ id: r.id, code: r.code, name: r.name })),
    },
  };
}

async function listItemMasters(req, res) {
  try {
    const search = req.query.search != null ? String(req.query.search).trim() : '';
    const typeFilter = req.query.type != null ? String(req.query.type).trim() : '';
    const { Op } = require('sequelize');
    const where = {};
    if (search.length > 0) {
      where[Op.or] = [
        { code: { [Op.iLike]: `%${search}%` } },
        { name: { [Op.iLike]: `%${search}%` } },
      ];
    }
    if (typeFilter.length > 0) where.type = typeFilter;

    const rows = await ItemMaster.findAll({ where, order: [['code', 'ASC']] });
    const allBomIds = new Set();
    const allPmIds = new Set();
    const allRmIds = new Set();
    rows.forEach((r) => {
      const plain = r.get ? r.get({ plain: true }) : r;
      toIntList(plain.bom_ids).forEach((id) => allBomIds.add(id));
      toIntList(plain.pack_material_ids).forEach((id) => allPmIds.add(id));
      toIntList(plain.raw_material_ids).forEach((id) => allRmIds.add(id));
    });

    const [boms, packMaterials, rawMaterials] = await Promise.all([
      allBomIds.size ? BOM.findAll({ where: { id: [...allBomIds] } }) : [],
      allPmIds.size ? PackMaterial.findAll({ where: { id: [...allPmIds] } }) : [],
      allRmIds.size ? RawMaterial.findAll({ where: { id: [...allRmIds] } }) : [],
    ]);
    const bomMap = new Map(boms.map((b) => [b.id, b.get ? b.get({ plain: true }) : b]));
    const pmMap = new Map(packMaterials.map((p) => [p.id, p.get ? p.get({ plain: true }) : p]));
    const rmMap = new Map(rawMaterials.map((r) => [r.id, r.get ? r.get({ plain: true }) : r]));

    const list = rows.map((r) => {
      const plain = r.get ? r.get({ plain: true }) : r;
      const bid = toIntList(plain.bom_ids);
      const pid = toIntList(plain.pack_material_ids);
      const rid = toIntList(plain.raw_material_ids);
      return formatItemMaster(r, {
        boms: bid.map((id) => bomMap.get(id)).filter(Boolean),
        packMaterials: pid.map((id) => pmMap.get(id)).filter(Boolean),
        rawMaterials: rid.map((id) => rmMap.get(id)).filter(Boolean),
      });
    });
    res.json(list);
  } catch (err) {
    console.error('listItemMasters error', err);
    res.status(500).json({ error: 'Failed to list items master' });
  }
}

async function getItemMasterById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ItemMaster.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Item not found' });
    const plain = row.get ? row.get({ plain: true }) : row;
    const bid = toIntList(plain.bom_ids);
    const pid = toIntList(plain.pack_material_ids);
    const rid = toIntList(plain.raw_material_ids);
    const [boms, packMaterials, rawMaterials] = await Promise.all([
      bid.length ? BOM.findAll({ where: { id: bid } }) : [],
      pid.length ? PackMaterial.findAll({ where: { id: pid } }) : [],
      rid.length ? RawMaterial.findAll({ where: { id: rid } }) : [],
    ]);
    res.json(formatItemMaster(row, {
      boms: boms.map((b) => (b.get ? b.get({ plain: true }) : b)),
      packMaterials: packMaterials.map((p) => (p.get ? p.get({ plain: true }) : p)),
      rawMaterials: rawMaterials.map((r) => (r.get ? r.get({ plain: true }) : r)),
    }));
  } catch (err) {
    console.error('getItemMasterById error', err);
    res.status(500).json({ error: 'Failed to fetch item' });
  }
}

function bodyToItemMaster(b) {
  return {
    code: b.code ?? '',
    name: b.name ?? null,
    type: b.type ?? 'product',
    status: b.status ?? null,
    bom_ids: b.bomIds != null ? toIntList(b.bomIds) : (b.bom_ids != null ? toIntList(b.bom_ids) : []),
    raw_material_ids: b.rawMaterialIds != null ? toIntList(b.rawMaterialIds) : (b.raw_material_ids != null ? toIntList(b.raw_material_ids) : []),
    pack_material_ids: b.packMaterialIds != null ? toIntList(b.packMaterialIds) : (b.pack_material_ids != null ? toIntList(b.pack_material_ids) : []),
  };
}

async function createItemMaster(req, res) {
  try {
    const body = bodyToItemMaster(req.body || {});
    if (!body.code || !String(body.code).trim()) return res.status(400).json({ error: 'code is required' });
    const row = await ItemMaster.create(body);
    const plain = row.get ? row.get({ plain: true }) : row;
    const bid = toIntList(plain.bom_ids);
    const pid = toIntList(plain.pack_material_ids);
    const rid = toIntList(plain.raw_material_ids);
    const [boms, packMaterials, rawMaterials] = await Promise.all([
      bid.length ? BOM.findAll({ where: { id: bid } }) : [],
      pid.length ? PackMaterial.findAll({ where: { id: pid } }) : [],
      rid.length ? RawMaterial.findAll({ where: { id: rid } }) : [],
    ]);
    res.status(201).json(formatItemMaster(row, {
      boms: boms.map((b) => (b.get ? b.get({ plain: true }) : b)),
      packMaterials: packMaterials.map((p) => (p.get ? p.get({ plain: true }) : p)),
      rawMaterials: rawMaterials.map((r) => (r.get ? r.get({ plain: true }) : r)),
    }));
  } catch (err) {
    console.error('createItemMaster error', err);
    res.status(500).json({ error: 'Failed to create item' });
  }
}

async function updateItemMaster(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ItemMaster.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Item not found' });
    const body = bodyToItemMaster(req.body || {});
    if (body.code !== undefined) row.code = body.code;
    if (body.name !== undefined) row.name = body.name;
    if (body.type !== undefined) row.type = body.type;
    if (body.status !== undefined) row.status = body.status;
    if (body.bom_ids !== undefined) row.bom_ids = body.bom_ids;
    if (body.pack_material_ids !== undefined) row.pack_material_ids = body.pack_material_ids;
    if (body.raw_material_ids !== undefined) row.raw_material_ids = body.raw_material_ids;
    await row.save();
    const plain = row.get ? row.get({ plain: true }) : row;
    const bid = toIntList(plain.bom_ids);
    const pid = toIntList(plain.pack_material_ids);
    const rid = toIntList(plain.raw_material_ids);
    const [boms, packMaterials, rawMaterials] = await Promise.all([
      bid.length ? BOM.findAll({ where: { id: bid } }) : [],
      pid.length ? PackMaterial.findAll({ where: { id: pid } }) : [],
      rid.length ? RawMaterial.findAll({ where: { id: rid } }) : [],
    ]);
    res.json(formatItemMaster(row, {
      boms: boms.map((b) => (b.get ? b.get({ plain: true }) : b)),
      packMaterials: packMaterials.map((p) => (p.get ? p.get({ plain: true }) : p)),
      rawMaterials: rawMaterials.map((r) => (r.get ? r.get({ plain: true }) : r)),
    }));
  } catch (err) {
    console.error('updateItemMaster error', err);
    res.status(500).json({ error: 'Failed to update item' });
  }
}

async function deleteItemMaster(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const n = await ItemMaster.destroy({ where: { id } });
    if (n === 0) return res.status(404).json({ error: 'Item not found' });
    res.status(204).send();
  } catch (err) {
    console.error('deleteItemMaster error', err);
    res.status(500).json({ error: 'Failed to delete item' });
  }
}

module.exports = {
  listItemMasters,
  getItemMasterById,
  createItemMaster,
  updateItemMaster,
  deleteItemMaster,
};

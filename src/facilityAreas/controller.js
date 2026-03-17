const FacilityArea = require('./models');
const { WarehouseLocation, WarehouseRack } = require('../warehouseLocations/models');

function formatRack(r) {
  const plain = r.get ? r.get({ plain: true }) : r;
  return {
    id: plain.id,
    locationId: plain.location_id,
    code: plain.code,
    name: plain.name || null,
    description: plain.description || null,
    levels: plain.levels != null ? Number(plain.levels) : 4,
    slotsTotal: plain.slots_total != null ? Number(plain.slots_total) : 16,
  };
}

function formatArea(row) {
  const d = row.get ? row.get({ plain: true }) : row;
  const zones = (d.zones || []).map((z) => {
    const racks = (z.WarehouseRacks || []).map(formatRack);
    return {
      id: z.id,
      code: z.code,
      name: z.name,
      locationType: z.location_type || d.area_type,
      zoneLabel: z.zone_label,
      icon: z.icon,
      areaSqm: z.area_sqm,
      description: z.description,
      utilisationPct: z.utilisation_pct != null ? Number(z.utilisation_pct) : 0,
      racks,
    };
  });
  return {
    id: d.id,
    code: d.code,
    name: d.name,
    areaType: d.area_type,
    icon: d.icon,
    description: d.description,
    zones,
  };
}

async function listAreas(req, res) {
  try {
    const where = {};
    if (req.query.area_type) where.area_type = req.query.area_type;
    const rows = await FacilityArea.findAll({
      where,
      order: [['id', 'ASC']],
      include: [{
        model: WarehouseLocation,
        as: 'zones',
        required: false,
        order: [['id', 'ASC']],
        include: [{ model: WarehouseRack, as: 'WarehouseRacks', required: false, attributes: ['id', 'location_id', 'code', 'name', 'description', 'levels', 'slots_total'] }],
      }],
    });
    res.json(rows.map(formatArea));
  } catch (err) {
    console.error('listAreas error:', err);
    res.status(500).json({ error: 'Failed to fetch facility areas' });
  }
}

async function getAreaById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await FacilityArea.findByPk(id, {
      include: [{
        model: WarehouseLocation,
        as: 'zones',
        required: false,
        include: [{ model: WarehouseRack, as: 'WarehouseRacks', required: false }],
      }],
    });
    if (!row) return res.status(404).json({ error: 'Facility area not found' });
    res.json(formatArea(row));
  } catch (err) {
    console.error('getAreaById error:', err);
    res.status(500).json({ error: 'Failed to fetch facility area' });
  }
}

async function createArea(req, res) {
  try {
    const { code, name, area_type, icon, description } = req.body || {};
    if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
    const row = await FacilityArea.create({
      code: String(code).trim(),
      name: String(name).trim(),
      area_type: area_type || 'warehouse',
      icon: icon || null,
      description: description || null,
    });
    const full = await FacilityArea.findByPk(row.id, {
      include: [{
        model: WarehouseLocation,
        as: 'zones',
        required: false,
        include: [{ model: WarehouseRack, as: 'WarehouseRacks', required: false }],
      }],
    });
    res.status(201).json(formatArea(full));
  } catch (err) {
    console.error('createArea error:', err);
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'Area code already exists' });
    }
    res.status(500).json({ error: 'Failed to create facility area' });
  }
}

async function updateArea(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await FacilityArea.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Facility area not found' });
    const allowed = ['code', 'name', 'area_type', 'icon', 'description'];
    for (const k of allowed) {
      if (req.body[k] !== undefined) row.set(k, req.body[k]);
    }
    await row.save();
    const full = await FacilityArea.findByPk(id, {
      include: [{
        model: WarehouseLocation,
        as: 'zones',
        required: false,
        include: [{ model: WarehouseRack, as: 'WarehouseRacks', required: false }],
      }],
    });
    res.json(formatArea(full));
  } catch (err) {
    console.error('updateArea error:', err);
    res.status(500).json({ error: 'Failed to update facility area' });
  }
}

async function deleteArea(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await FacilityArea.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Facility area not found' });
    await WarehouseLocation.destroy({ where: { area_id: id } });
    await row.destroy();
    res.json({ message: 'Facility area deleted' });
  } catch (err) {
    console.error('deleteArea error:', err);
    res.status(500).json({ error: 'Failed to delete facility area' });
  }
}

module.exports = { listAreas, getAreaById, createArea, updateArea, deleteArea };

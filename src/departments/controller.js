const { Department } = require('./models');

async function listDepartments(_req, res) {
  try {
    const rows = await Department.findAll({ order: [['name', 'ASC']] });
    res.json(rows);
  } catch (err) {
    console.error('listDepartments error:', err);
    res.status(500).json({ error: 'Failed to fetch departments' });
  }
}

async function getDepartmentById(req, res) {
  try {
    const row = await Department.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Department not found' });
    res.json(row);
  } catch (err) {
    console.error('getDepartmentById error:', err);
    res.status(500).json({ error: 'Failed to fetch department' });
  }
}

async function createDepartment(req, res) {
  try {
    const { name, code, is_active } = req.body;
    if (!name || !code) return res.status(400).json({ error: 'name and code are required' });
    const existing = await Department.findOne({ where: { name } });
    if (existing) return res.status(409).json({ error: 'Department name already exists' });
    const row = await Department.create({
      name: name.trim(),
      code: code.trim().toLowerCase().replace(/\s+/g, '-'),
      is_active: is_active !== false,
      created_at: new Date(),
      updated_at: new Date(),
    });
    res.status(201).json(row);
  } catch (err) {
    console.error('createDepartment error:', err);
    res.status(500).json({ error: 'Failed to create department' });
  }
}

async function updateDepartment(req, res) {
  try {
    const row = await Department.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Department not found' });
    const allowed = ['name', 'code', 'is_active'];
    const updates = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    updates.updated_at = new Date();
    await row.update(updates);
    res.json(row);
  } catch (err) {
    console.error('updateDepartment error:', err);
    res.status(500).json({ error: 'Failed to update department' });
  }
}

async function deleteDepartment(req, res) {
  try {
    const row = await Department.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: 'Department not found' });
    await row.destroy();
    res.json({ success: true });
  } catch (err) {
    console.error('deleteDepartment error:', err);
    res.status(500).json({ error: 'Failed to delete department' });
  }
}

module.exports = { listDepartments, getDepartmentById, createDepartment, updateDepartment, deleteDepartment };

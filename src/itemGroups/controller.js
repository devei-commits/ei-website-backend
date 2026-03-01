const ItemGroup = require('./models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');

function toIntList(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val.map((x) => (typeof x === 'number' ? x : parseInt(x, 10))).filter((n) => !Number.isNaN(n));
  return [];
}

function formatGroup(row, approvedMembers = []) {
  if (!row) return null;
  const d = row.get ? row.get({ plain: true }) : row;
  return {
    id: String(d.id),
    code: d.code,
    icon: d.icon || '🔗',
    type: d.type || 'RM',
    name: d.name,
    description: d.description || '',
    purpose: d.purpose || '',
    status: d.status || 'Active',
    notes: d.notes || '',
    approvedMembers,
    proposedAlternates: Array.isArray(d.proposed_alternates) ? d.proposed_alternates : [],
    member_ids: toIntList(d.member_ids),
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

async function resolveMembers(type, memberIds) {
  const ids = toIntList(memberIds);
  if (ids.length === 0) return [];
  if (type === 'RM') {
    const rows = await RawMaterial.findAll({ where: { id: ids } });
    const byId = new Map(rows.map((r) => [r.id, r.get ? r.get({ plain: true }) : r]));
    return ids.map((id) => {
      const d = byId.get(id);
      return d ? { id: String(d.id), code: d.code, name: d.name || d.code, status: 'approved' } : null;
    }).filter(Boolean);
  }
  if (type === 'PM') {
    const rows = await PackMaterial.findAll({ where: { id: ids } });
    const byId = new Map(rows.map((r) => [r.id, r.get ? r.get({ plain: true }) : r]));
    return ids.map((id) => {
      const d = byId.get(id);
      return d ? { id: String(d.id), code: d.code, name: d.description || d.code, status: 'approved' } : null;
    }).filter(Boolean);
  }
  return [];
}

/**
 * GET /api/v1/item-groups — list all groups with resolved approvedMembers from RM/PM tables.
 */
async function listItemGroups(req, res) {
  try {
    const typeFilter = req.query.type; // optional 'RM' | 'PM'
    const where = {};
    if (typeFilter === 'RM' || typeFilter === 'PM') where.type = typeFilter;

    const rows = await ItemGroup.findAll({ where, order: [['code', 'ASC']] });
    const list = [];
    for (const row of rows) {
      const plain = row.get ? row.get({ plain: true }) : row;
      const members = await resolveMembers(plain.type, plain.member_ids);
      list.push(formatGroup(row, members));
    }
    res.json(list);
  } catch (err) {
    console.error('listItemGroups error', err);
    res.status(500).json({ error: 'Failed to list item groups' });
  }
}

/**
 * GET /api/v1/item-groups/:id — get one group with resolved approvedMembers.
 */
async function getItemGroupById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ItemGroup.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Item group not found' });
    const plain = row.get ? row.get({ plain: true }) : row;
    const members = await resolveMembers(plain.type, plain.member_ids);
    res.json(formatGroup(row, members));
  } catch (err) {
    console.error('getItemGroupById error', err);
    res.status(500).json({ error: 'Failed to fetch item group' });
  }
}

function bodyToPayload(body) {
  const memberIds = body.member_ids != null ? toIntList(body.member_ids) : (body.memberIds != null ? toIntList(body.memberIds) : []);
  const proposedAlternates = Array.isArray(body.proposed_alternates) ? body.proposed_alternates : (Array.isArray(body.proposedAlternates) ? body.proposedAlternates : []);
  return {
    code: body.code ?? '',
    icon: body.icon ?? null,
    type: body.type === 'PM' ? 'PM' : 'RM',
    name: body.name ?? '',
    description: body.description ?? null,
    purpose: body.purpose ?? null,
    status: body.status ?? 'Active',
    notes: body.notes ?? null,
    member_ids: memberIds,
    proposed_alternates: proposedAlternates,
  };
}

/**
 * POST /api/v1/item-groups — create. Body: code, type, name, description?, purpose?, status?, notes?, member_ids?, proposed_alternates?.
 */
async function createItemGroup(req, res) {
  try {
    const payload = bodyToPayload(req.body || {});
    if (!payload.name || !payload.code) return res.status(400).json({ error: 'code and name are required' });
    const row = await ItemGroup.create(payload);
    const plain = row.get ? row.get({ plain: true }) : row;
    const members = await resolveMembers(plain.type, plain.member_ids);
    res.status(201).json(formatGroup(row, members));
  } catch (err) {
    console.error('createItemGroup error', err);
    res.status(500).json({ error: err.message || 'Failed to create item group' });
  }
}

/**
 * PUT /api/v1/item-groups/:id — update. Body: same as create (partial).
 */
async function updateItemGroup(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ItemGroup.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Item group not found' });
    const payload = bodyToPayload(req.body || {});
    const updateData = {};
    if (payload.code !== undefined) updateData.code = payload.code;
    if (payload.icon !== undefined) updateData.icon = payload.icon;
    if (payload.type !== undefined) updateData.type = payload.type;
    if (payload.name !== undefined) updateData.name = payload.name;
    if (payload.description !== undefined) updateData.description = payload.description;
    if (payload.purpose !== undefined) updateData.purpose = payload.purpose;
    if (payload.status !== undefined) updateData.status = payload.status;
    if (payload.notes !== undefined) updateData.notes = payload.notes;
    if (payload.member_ids !== undefined) updateData.member_ids = payload.member_ids;
    if (payload.proposed_alternates !== undefined) updateData.proposed_alternates = payload.proposed_alternates;
    await row.update(updateData);
    const plain = row.get ? row.get({ plain: true }) : row;
    const members = await resolveMembers(plain.type, plain.member_ids);
    res.json(formatGroup(row, members));
  } catch (err) {
    console.error('updateItemGroup error', err);
    res.status(500).json({ error: err.message || 'Failed to update item group' });
  }
}

/**
 * DELETE /api/v1/item-groups/:id
 */
async function deleteItemGroup(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const n = await ItemGroup.destroy({ where: { id } });
    if (n === 0) return res.status(404).json({ error: 'Item group not found' });
    res.status(204).send();
  } catch (err) {
    console.error('deleteItemGroup error', err);
    res.status(500).json({ error: 'Failed to delete item group' });
  }
}

module.exports = {
  listItemGroups,
  getItemGroupById,
  createItemGroup,
  updateItemGroup,
  deleteItemGroup,
  formatGroup,
  resolveMembers,
};

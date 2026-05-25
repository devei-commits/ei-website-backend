const ItemGroup = require('./models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const db = require('../../db');
const { Op } = require('sequelize');

function toIntList(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val.map((x) => (typeof x === 'number' ? x : parseInt(x, 10))).filter((n) => !Number.isNaN(n));
  return [];
}

function formatGroup(row, approvedMembers = [], proposedAlternatesResolved = []) {
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
    proposedAlternates: Array.isArray(proposedAlternatesResolved) && proposedAlternatesResolved.length > 0 ? proposedAlternatesResolved : (Array.isArray(d.proposed_alternates) ? d.proposed_alternates : []),
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

/** Normalize proposed_alternates from client: [{ item_id, notes?, status? }] or legacy [{ id, name, notes, status }]. */
function normalizeProposedAlternates(arr, type) {
  if (!Array.isArray(arr)) return [];
  return arr.map((entry) => {
    const itemId = entry.item_id != null ? parseInt(entry.item_id, 10) : (entry.id != null ? parseInt(entry.id, 10) : null);
    if (itemId == null || Number.isNaN(itemId)) return null;
    return {
      item_id: itemId,
      notes: entry.notes ?? '',
      status: entry.status === 'under-review' ? 'under-review' : 'proposed',
    };
  }).filter(Boolean);
}

/** Resolve proposed_alternates (stored as [{ item_id, notes, status }]) to include code/name from RM/PM. */
async function resolveProposedAlternates(type, raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const list = raw.map((e) => ({
    item_id: e.item_id != null ? parseInt(e.item_id, 10) : (e.id != null ? parseInt(e.id, 10) : null),
    notes: e.notes ?? '',
    status: e.status === 'under-review' ? 'under-review' : 'proposed',
  })).filter((e) => e.item_id != null && !Number.isNaN(e.item_id));
  const ids = [...new Set(list.map((e) => e.item_id))];
  if (ids.length === 0) return [];
  if (type === 'RM') {
    const rows = await RawMaterial.findAll({ where: { id: ids } });
    const byId = new Map(rows.map((r) => [r.id, r.get ? r.get({ plain: true }) : r]));
    return list.map((e) => {
      const d = byId.get(e.item_id);
      return d ? { id: String(d.id), item_id: d.id, code: d.code, name: d.name || d.code, notes: e.notes, status: e.status } : null;
    }).filter(Boolean);
  }
  if (type === 'PM') {
    const rows = await PackMaterial.findAll({ where: { id: ids } });
    const byId = new Map(rows.map((r) => [r.id, r.get ? r.get({ plain: true }) : r]));
    return list.map((e) => {
      const d = byId.get(e.item_id);
      return d ? { id: String(d.id), item_id: d.id, code: d.code, name: d.description || d.code, notes: e.notes, status: e.status } : null;
    }).filter(Boolean);
  }
  return [];
}

/**
 * Sync item group id to raw_materials.group or pack_materials.group so RM/PM rows reference their group.
 * Uses raw SQL so the reserved column name "group" is set reliably in PostgreSQL.
 */
async function syncGroupIdToMembers(type, groupIdStr, memberIds, prevMemberIds = null) {
  const ids = toIntList(memberIds);
  const prev = prevMemberIds != null ? toIntList(prevMemberIds) : [];
  const toRemove = prev.filter((id) => !ids.includes(id));
  const toSet = ids;
  const table = type === 'RM' ? 'raw_materials' : 'pack_materials';
  const { backendNow } = require('../lib/backendTimestamps');
  const now = backendNow();
  if (toRemove.length > 0) {
    const inList = toRemove.map((_, i) => `:r${i}`).join(',');
    await db.query(`UPDATE "${table}" SET "group" = NULL, "updated_at" = :now WHERE id IN (${inList})`, {
      replacements: { now, ...Object.fromEntries(toRemove.map((id, i) => [`r${i}`, id])) },
      type: db.QueryTypes.UPDATE,
    });
  }
  if (toSet.length > 0) {
    const inList = toSet.map((_, i) => `:s${i}`).join(',');
    await db.query(`UPDATE "${table}" SET "group" = :groupId, "updated_at" = :now WHERE id IN (${inList})`, {
      replacements: { groupId: String(groupIdStr), now, ...Object.fromEntries(toSet.map((id, i) => [`s${i}`, id])) },
      type: db.QueryTypes.UPDATE,
    });
  }
}

/**
 * GET /api/v1/item-groups — list all groups with resolved approvedMembers from RM/PM tables.
 */
async function listItemGroups(req, res) {
  try {
    const typeFilter = req.query.type; // optional 'RM' | 'PM'
    const search = req.query.search != null ? String(req.query.search).trim() : '';
    const wantsPagination = req.query.limit != null || req.query.offset != null;

    const where = {};
    if (typeFilter === 'RM' || typeFilter === 'PM') where.type = typeFilter;
    if (search) {
      where[Op.or] = [
        { code: { [Op.iLike]: `%${search}%` } },
        { name: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const limit = req.query.limit != null ? parseInt(String(req.query.limit), 10) : undefined;
    const offset = req.query.offset != null ? parseInt(String(req.query.offset), 10) : undefined;

    const paginationMode = wantsPagination;
    if (paginationMode) {
      if (limit == null || offset == null || Number.isNaN(limit) || Number.isNaN(offset) || limit <= 0 || offset < 0) {
        return res.status(400).json({ error: 'Invalid limit/offset' });
      }

      const total = await ItemGroup.count({ where });
      const rows = await ItemGroup.findAll({
        where,
        order: [['code', 'ASC']],
        limit,
        offset,
      });

      const list = [];
      for (const row of rows) {
        const plain = row.get ? row.get({ plain: true }) : row;
        const [members, proposedAlternates] = await Promise.all([
          resolveMembers(plain.type, plain.member_ids),
          resolveProposedAlternates(plain.type, plain.proposed_alternates),
        ]);
        list.push(formatGroup(row, members, proposedAlternates));
      }

      return res.json({ rows: list, total, limit, offset });
    }

    const rows = await ItemGroup.findAll({ where, order: [['code', 'ASC']] });
    const list = [];
    for (const row of rows) {
      const plain = row.get ? row.get({ plain: true }) : row;
      const [members, proposedAlternates] = await Promise.all([
        resolveMembers(plain.type, plain.member_ids),
        resolveProposedAlternates(plain.type, plain.proposed_alternates),
      ]);
      list.push(formatGroup(row, members, proposedAlternates));
    }
    res.json(list);
  } catch (err) {
    console.error('listItemGroups error', err);
    res.status(500).json({ error: 'Failed to list item groups' });
  }
}

/**
 * GET /api/v1/item-groups/next-code?type=RM|PM — next code for new group (e.g. IG-001, IG-PM-001).
 */
async function getNextCode(req, res) {
  try {
    const type = (req.query.type || 'RM').toString().toUpperCase() === 'PM' ? 'PM' : 'RM';
    const prefix = type === 'PM' ? 'IG-PM' : 'IG';
    const rows = await ItemGroup.findAll({
      where: { type },
      attributes: ['code'],
      order: [['code', 'DESC']],
    });
    let nextNum = 1;
    const numericPart = rows
      .map((r) => {
        const code = r.code || (r.get && r.get('code'));
        const str = String(code || '');
        const match = str.replace(prefix, '').replace(/^-+/, '').match(/^(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter((n) => !Number.isNaN(n));
    if (numericPart.length > 0) nextNum = Math.max(...numericPart) + 1;
    const nextCode = `${prefix}-${String(nextNum).padStart(3, '0')}`;
    res.json({ nextCode });
  } catch (err) {
    console.error('getNextCode error', err);
    res.status(500).json({ error: 'Failed to generate next code' });
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
    const [members, proposedAlternates] = await Promise.all([
      resolveMembers(plain.type, plain.member_ids),
      resolveProposedAlternates(plain.type, plain.proposed_alternates),
    ]);
    res.json(formatGroup(row, members, proposedAlternates));
  } catch (err) {
    console.error('getItemGroupById error', err);
    res.status(500).json({ error: 'Failed to fetch item group' });
  }
}

function bodyToPayload(body, type) {
  const memberIds = body.member_ids != null ? toIntList(body.member_ids) : (body.memberIds != null ? toIntList(body.memberIds) : []);
  const rawAlternates = Array.isArray(body.proposed_alternates) ? body.proposed_alternates : (Array.isArray(body.proposedAlternates) ? body.proposedAlternates : []);
  const proposedAlternates = normalizeProposedAlternates(rawAlternates, type);
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
 * POST /api/v1/item-groups — create. Body: code (or omit to auto-generate from next-code), type, name, description?, purpose?, status?, notes?, member_ids?, proposed_alternates?.
 */
async function createItemGroup(req, res) {
  try {
    const body = req.body || {};
    let payload = bodyToPayload(body, body.type === 'PM' ? 'PM' : 'RM');
    if (!payload.name) return res.status(400).json({ error: 'name is required' });
    const type = payload.type === 'PM' ? 'PM' : 'RM';
    const prefix = type === 'PM' ? 'IG-PM' : 'IG';
    let code = (payload.code != null && String(payload.code).trim()) ? String(payload.code).trim() : '';
    if (!code) {
      const rows = await ItemGroup.findAll({ where: { type }, attributes: ['code'], order: [['code', 'DESC']] });
      let nextNum = 1;
      const numericPart = rows
        .map((r) => {
          const c = r.code || (r.get && r.get('code'));
          const str = String(c || '');
          const match = str.replace(prefix, '').replace(/^-+/, '').match(/^(\d+)/);
          return match ? parseInt(match[1], 10) : 0;
        })
        .filter((n) => !Number.isNaN(n));
      if (numericPart.length > 0) nextNum = Math.max(...numericPart) + 1;
      code = `${prefix}-${String(nextNum).padStart(3, '0')}`;
    }
    const codeToSave = String(code).trim() || `${prefix}-001`;
    const createData = {
      code: codeToSave,
      icon: payload.icon ?? null,
      type,
      name: payload.name,
      description: payload.description ?? null,
      purpose: payload.purpose ?? null,
      status: payload.status ?? 'Active',
      notes: payload.notes ?? null,
      member_ids: payload.member_ids ?? [],
      proposed_alternates: payload.proposed_alternates ?? [],
    };
    const row = await ItemGroup.create(createData);
    const plain = row.get ? row.get({ plain: true }) : row;
    await syncGroupIdToMembers(plain.type, String(plain.id), plain.member_ids);
    const [members, proposedAlternates] = await Promise.all([
      resolveMembers(plain.type, plain.member_ids),
      resolveProposedAlternates(plain.type, plain.proposed_alternates),
    ]);
    res.status(201).json(formatGroup(row, members, proposedAlternates));
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
    const plain = row.get ? row.get({ plain: true }) : row;
    const payload = bodyToPayload(req.body || {}, plain.type);
    const updateData = {};
    if (payload.code !== undefined && String(payload.code).trim() !== '') updateData.code = String(payload.code).trim();
    if (payload.icon !== undefined) updateData.icon = payload.icon;
    if (payload.type !== undefined) updateData.type = payload.type;
    if (payload.name !== undefined) updateData.name = payload.name;
    if (payload.description !== undefined) updateData.description = payload.description;
    if (payload.purpose !== undefined) updateData.purpose = payload.purpose;
    if (payload.status !== undefined) updateData.status = payload.status;
    if (payload.notes !== undefined) updateData.notes = payload.notes;
    if (payload.member_ids !== undefined) updateData.member_ids = payload.member_ids;
    if (payload.proposed_alternates !== undefined) updateData.proposed_alternates = payload.proposed_alternates;
    const prevMemberIds = plain.member_ids;
    await row.update(updateData);
    const plainUpdated = row.get ? row.get({ plain: true }) : row;
    if (payload.member_ids !== undefined) {
      await syncGroupIdToMembers(plainUpdated.type, String(plainUpdated.id), plainUpdated.member_ids, prevMemberIds);
    }
    const [members, proposedAlternates] = await Promise.all([
      resolveMembers(plainUpdated.type, plainUpdated.member_ids),
      resolveProposedAlternates(plainUpdated.type, plainUpdated.proposed_alternates),
    ]);
    res.json(formatGroup(row, members, proposedAlternates));
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
    const row = await ItemGroup.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Item group not found' });
    const plain = row.get ? row.get({ plain: true }) : row;
    await syncGroupIdToMembers(plain.type, String(id), [], plain.member_ids);
    await ItemGroup.destroy({ where: { id } });
    res.status(204).send();
  } catch (err) {
    console.error('deleteItemGroup error', err);
    res.status(500).json({ error: 'Failed to delete item group' });
  }
}

module.exports = {
  listItemGroups,
  getNextCode,
  getItemGroupById,
  createItemGroup,
  updateItemGroup,
  deleteItemGroup,
  formatGroup,
  resolveMembers,
};

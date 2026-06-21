/**
 * Roles controller. Roles and permissions from DB; module definitions from DB filtered by user role.
 * All handlers are protected by isAuthenticated + requireModule('role-management').
 */

const { Role, Permission, RolePermission, ModuleDefinition, User, StaffProfile } = require('../models/index');
const { Op } = require('sequelize');
const { softDeleteInstance, activeRowWhere } = require('../lib/softDelete');
const { buildInternalStaffRolesWhere } = require('../users/internalStaff');
const defaultModuleDef = require('./defaultModuleDefinition');

const MODULE_DEFINITIONS = defaultModuleDef.modules;
const DEFAULT_GLOBAL_SETTINGS = defaultModuleDef.globalSettings;

const SYSTEM_ROLE_IDS = [1, 2, 3, 4, 5];
const DB_ACTION_ENUM_SAFE = new Set(['view', 'create', 'edit', 'delete']);

function normalizePermissionForStorage(resource, action) {
  const safeResource = String(resource || '').trim();
  const safeAction = String(action || '').trim().toLowerCase();
  if (!safeResource || !safeAction) return null;
  if (DB_ACTION_ENUM_SAFE.has(safeAction)) {
    return { resource: safeResource, action: safeAction };
  }
  // Backward-compatible fallback for DBs where permissions.action is ENUM(view/create/edit/delete).
  // Preserve unsupported verbs (approve/export/...) inside resource and store action as view.
  return { resource: `${safeResource}.action.${safeAction}`, action: 'view' };
}

function parseGrantedKey(key) {
  const raw = typeof key === 'string' ? key.trim() : String(key || '').trim();
  if (!raw) return null;
  const actionTag = '.action.';
  const columnTag = '.column.';
  if (raw.includes(actionTag)) {
    const i = raw.lastIndexOf(actionTag);
    const resource = raw.slice(0, i);
    const action = raw.slice(i + actionTag.length);
    if (!resource || !action) return null;
    return normalizePermissionForStorage(resource, action);
  }
  if (raw.includes(columnTag)) {
    const parts = raw.split('.');
    if (parts.length >= 2) {
      const action = parts[parts.length - 1];
      const resource = parts.slice(0, -1).join('.');
      if (!resource || !action) return null;
      return normalizePermissionForStorage(resource, action);
    }
  }
  return normalizePermissionForStorage(raw, 'view');
}

function toGrantedKey(permission) {
  const resource = permission && permission.resource ? String(permission.resource).trim() : '';
  const action = permission && permission.action ? String(permission.action).trim() : '';
  if (!resource || !action) return resource || '';
  if (action === 'view' && resource.includes('.action.')) return resource;
  if (resource.includes('.column.')) return `${resource}.${action}`;
  return `${resource}.action.${action}`;
}

async function findRoleByParam(idParam) {
  const raw = String(idParam ?? '').trim();
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Role.findOne({ where: activeRowWhere({ role_id: numeric }) });
  }
  return Role.findOne({ where: activeRowWhere({ role_code: raw }) });
}

function deriveLegacyUsertypes(role) {
  const out = new Set();
  const code = String(role?.role_code || '').trim().toLowerCase();
  if (code) out.add(code);
  const nameAsType = String(role?.role_name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (nameAsType) out.add(nameAsType);
  return Array.from(out);
}

async function saveRolePermissions(roleId, grantedKeys) {
  const granted = Array.isArray(grantedKeys) ? grantedKeys : [];
  const parsed = granted.map((k) => parseGrantedKey(k)).filter(Boolean);
  const uniqMap = new Map();
  for (const p of parsed) {
    uniqMap.set(`${p.resource}|||${p.action}`, p);
  }
  const uniquePerms = Array.from(uniqMap.values());

  await RolePermission.destroy({ where: { role_id: roleId } });
  if (uniquePerms.length === 0) return [];

  const orWhere = uniquePerms.map((p) => ({ resource: p.resource, action: p.action }));
  let permissionRows = await Permission.findAll({ where: { [Op.or]: orWhere } });
  const existing = new Set(permissionRows.map((p) => `${p.resource}|||${p.action}`));
  const missing = uniquePerms.filter((p) => !existing.has(`${p.resource}|||${p.action}`));

  if (missing.length > 0) {
    await Permission.bulkCreate(missing, { ignoreDuplicates: true });
    permissionRows = await Permission.findAll({ where: { [Op.or]: orWhere } });
  }

  const rolePermRows = permissionRows.map((p) => ({ role_id: roleId, permission_id: p.permission_id }));
  if (rolePermRows.length > 0) {
    await RolePermission.bulkCreate(rolePermRows, { ignoreDuplicates: true });
  }
  return permissionRows;
}

async function listRoles(req, res) {
  try {
    const staffOnly = req.query.staffOnly === 'true';
    const roleWhere = staffOnly ? buildInternalStaffRolesWhere() : {};
    const roles = await Role.findAll({
      where: activeRowWhere(roleWhere),
      order: [['role_id', 'ASC']],
    });
    const roleIds = roles.map((r) => r.role_id);

    const [userCounts, permCounts] = await Promise.all([
      StaffProfile.findAll({
        attributes: ['role_id', [StaffProfile.sequelize.fn('COUNT', StaffProfile.sequelize.col('user_id')), 'count']],
        where: { role_id: { [Op.in]: roleIds } },
        group: ['role_id'],
        raw: true,
      }).catch(() => []),
      RolePermission.findAll({
        attributes: ['role_id', [RolePermission.sequelize.fn('COUNT', RolePermission.sequelize.col('permission_id')), 'count']],
        where: { role_id: { [Op.in]: roleIds } },
        group: ['role_id'],
        raw: true,
      }).catch(() => []),
    ]);

    const userCountByRoleId = new Map(userCounts.map((r) => [Number(r.role_id), Number(r.count) || 0]));
    const permCountByRoleId = new Map(permCounts.map((r) => [Number(r.role_id), Number(r.count) || 0]));

    const list = await Promise.all(
      roles.map(async (r) => {
        const userCount = userCountByRoleId.get(Number(r.role_id)) || 0;
        const permCount = permCountByRoleId.get(Number(r.role_id)) || 0;
        return {
          role_id: r.role_id,
          role_code: r.role_code,
          role_name: r.role_name,
          description: r.description,
          level: r.level,
          status: r.status || 'active',
          userCount,
          permissionsSet: permCount > 0,
          createdAt: r.created_at ? String(r.created_at).slice(0, 10) : '',
        };
      })
    );
    res.status(200).json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Load module definitions from DB and filter by the current user's role permissions.
 * - If module_definitions table has a row, use it; otherwise fall back to static MODULE_DEFINITIONS.
 * - req.user.role is usertype (e.g. super_admin). We find Role by role_code and get its permissions.
 * - Only modules that the role has at least one permission for are returned (resource = moduleId or starts with moduleId).
 */
async function getModuleDefinitionsHandler(req, res) {
  try {
    let modules = MODULE_DEFINITIONS;
    let globalSettings = DEFAULT_GLOBAL_SETTINGS;

    const defRow = await ModuleDefinition.findOne({ order: [['id', 'ASC']] }).catch(() => null);
    if (defRow && defRow.definition_json) {
      const def = defRow.definition_json;
      if (Array.isArray(def.modules)) modules = def.modules;
      if (def.globalSettings && typeof def.globalSettings === 'object') globalSettings = def.globalSettings;
    }

    const usertype = req.user?.role;
    if (!usertype) {
      return res.status(200).json({ modules, globalSettings });
    }

    const role = await Role.findOne({ where: { role_code: usertype } }).catch(() => null);
    if (!role) {
      return res.status(200).json({ modules, globalSettings });
    }

    const roleWithPerms = await Role.findByPk(role.role_id, { include: [Permission] }).catch(() => null);
    const permissions = roleWithPerms && roleWithPerms.Permissions ? roleWithPerms.Permissions : [];
    const allowedModuleIds = new Set();
    for (const p of permissions) {
      if (p && p.resource) {
        const moduleId = p.resource.split('.')[0];
        allowedModuleIds.add(moduleId);
      }
    }

    if (allowedModuleIds.size > 0) {
      modules = modules.filter((m) => allowedModuleIds.has(m.moduleId));
    }

    res.status(200).json({ modules, globalSettings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getRoleById(req, res) {
  try {
    const roleBase = await findRoleByParam(req.params.id);
    const role = roleBase ? await Role.findByPk(roleBase.role_id, { include: [Permission] }) : null;
    if (!role) {
      return res.status(404).json({ error: 'Role not found' });
    }
    const id = Number(role.role_id);
    const staffRows = await StaffProfile.findAll({
      where: { role_id: id },
      include: [{ model: User, as: 'user', attributes: ['userid', 'email', 'fname', 'lname', 'display_name', 'status', 'created_at'] }],
      order: [['created_at', 'ASC']],
    }).catch(() => []);
    const assignedUsersFromStaff = staffRows
      .map((r) => {
        const u = r.user;
        if (!u) return null;
        const name = [u.fname, u.lname].filter(Boolean).join(' ') || u.display_name || u.email || `User ${u.userid}`;
        return {
          user_id: u.userid,
          email: u.email || '',
          name,
          status: u.status || 'active',
          assigned_at: r.created_at ? String(r.created_at) : '',
        };
      })
      .filter(Boolean);
    const legacyTypes = deriveLegacyUsertypes(role);
    const assignedUsersFromLegacy = legacyTypes.length > 0
      ? await User.findAll({
        where: { usertype: { [Op.in]: legacyTypes } },
        attributes: ['userid', 'email', 'fname', 'lname', 'display_name', 'status', 'created_at'],
        order: [['created_at', 'ASC']],
      }).then((rows) => rows.map((u) => {
        const name = [u.fname, u.lname].filter(Boolean).join(' ') || u.display_name || u.email || `User ${u.userid}`;
        return {
          user_id: u.userid,
          email: u.email || '',
          name,
          status: u.status || 'active',
          assigned_at: u.created_at ? String(u.created_at) : '',
        };
      })).catch(() => [])
      : [];
    const byUserId = new Map();
    for (const u of [...assignedUsersFromLegacy, ...assignedUsersFromStaff]) {
      byUserId.set(Number(u.user_id), u);
    }
    const assignedUsers = Array.from(byUserId.values()).sort((a, b) =>
      String(a.assigned_at || '').localeCompare(String(b.assigned_at || ''))
    );
    const permissions = role.Permissions || [];
    const granted = permissions.map((p) => toGrantedKey(p)).filter(Boolean);
    res.status(200).json({
      role_id: role.role_id,
      role_code: role.role_code,
      role_name: role.role_name,
      description: role.description,
      level: role.level,
      status: role.status || 'active',
      created_at: role.created_at ? String(role.created_at) : '',
      updated_at: role.updated_at ? String(role.updated_at) : '',
      assignedUsers,
      permissions: {
        granted,
        globalSettings: DEFAULT_GLOBAL_SETTINGS,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function createRole(req, res) {
  try {
    const { role_code, role_name, description, level, status, permissions } = req.body || {};
    if (!role_code || !role_name || !level) {
      return res.status(400).json({ error: 'role_code, role_name, and level are required' });
    }
    const existing = await Role.findOne({ where: { role_code: String(role_code).trim() } });
    if (existing) {
      return res.status(409).json({ error: 'Role with this role_code already exists' });
    }
    const role = await Role.create({
      role_code: String(role_code).trim(),
      role_name: String(role_name).trim(),
      description: description != null ? String(description) : null,
      level: String(level).trim() || 'staff',
      status: status || 'active',
    });
    const granted = permissions?.granted && Array.isArray(permissions.granted) ? permissions.granted : [];
    const perms = await saveRolePermissions(role.role_id, granted);
    const grantedOut = perms.map((p) => toGrantedKey(p)).filter(Boolean);
    res.status(201).json({
      role_id: role.role_id,
      role_code: role.role_code,
      role_name: role.role_name,
      description: role.description,
      level: role.level,
      status: role.status,
      created_at: role.created_at ? String(role.created_at) : '',
      updated_at: role.updated_at ? String(role.updated_at) : '',
      permissions: { granted: grantedOut, globalSettings: DEFAULT_GLOBAL_SETTINGS },
    });
  } catch (err) {
    if (err?.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'Role with this role_code already exists' });
    }
    res.status(500).json({ error: err.message });
  }
}

async function updateRole(req, res) {
  try {
    const role = await findRoleByParam(req.params.id);
    if (!role) {
      return res.status(404).json({ error: 'Role not found' });
    }
    const id = Number(role.role_id);
    const body = req.body || {};
    if (body.role_code != null) {
      const nextRoleCode = String(body.role_code).trim();
      if (nextRoleCode && nextRoleCode !== role.role_code) {
        const duplicate = await Role.findOne({
          where: { role_code: nextRoleCode, role_id: { [Op.ne]: id } },
          attributes: ['role_id'],
        });
        if (duplicate) {
          return res.status(409).json({ error: 'Role with this role_code already exists' });
        }
      }
      role.role_code = nextRoleCode;
    }
    if (body.role_name != null) role.role_name = String(body.role_name).trim();
    if (body.description !== undefined) role.description = body.description != null ? String(body.description) : null;
    if (body.level != null) role.level = String(body.level).trim();
    if (body.status != null) role.status = String(body.status);
    await role.save();
    let perms = [];
    if (body.permissions && Array.isArray(body.permissions.granted)) {
      perms = await saveRolePermissions(id, body.permissions.granted);
    } else {
      perms = await role.getPermissions();
    }
    const granted = perms.map((p) => toGrantedKey(p)).filter(Boolean);
    res.status(200).json({
      role_id: role.role_id,
      role_code: role.role_code,
      role_name: role.role_name,
      description: role.description,
      level: role.level,
      status: role.status,
      created_at: role.created_at ? String(role.created_at) : '',
      updated_at: role.updated_at ? String(role.updated_at) : '',
      permissions: { granted, globalSettings: DEFAULT_GLOBAL_SETTINGS },
    });
  } catch (err) {
    if (err?.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'Role with this role_code already exists' });
    }
    res.status(500).json({ error: err.message });
  }
}

async function deleteRole(req, res) {
  try {
    const role = await findRoleByParam(req.params.id);
    if (!role) {
      return res.status(404).json({ error: 'Role not found' });
    }
    const id = Number(role.role_id);
    if (SYSTEM_ROLE_IDS.includes(id)) {
      return res.status(403).json({ error: 'System roles cannot be deleted' });
    }
    await RolePermission.destroy({ where: { role_id: id } });
    await softDeleteInstance(role);
    res.status(200).json({ message: 'Role deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  listRoles,
  getModuleDefinitionsHandler,
  getRoleById,
  createRole,
  updateRole,
  deleteRole,
  saveRolePermissions,
};

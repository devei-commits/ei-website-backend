/**
 * Roles controller. Roles and permissions from DB; module definitions from DB filtered by user role.
 * All handlers are protected by isAuthenticated + requireModule('role-management').
 */

const { Role, Permission, RolePermission, ModuleDefinition, User } = require('../models/index');
const defaultModuleDef = require('./defaultModuleDefinition');

const MODULE_DEFINITIONS = defaultModuleDef.modules;
const DEFAULT_GLOBAL_SETTINGS = defaultModuleDef.globalSettings;

const SYSTEM_ROLE_IDS = [1, 2, 3, 4, 5];

async function listRoles(_req, res) {
  try {
    const roles = await Role.findAll({ order: [['role_id', 'ASC']] });
    const list = await Promise.all(
      roles.map(async (r) => {
        const [userCount, permCount] = await Promise.all([
          User.count({ where: { usertype: r.role_code } }).catch(() => 0),
          RolePermission.count({ where: { role_id: r.role_id } }).catch(() => 0),
        ]);
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
    const id = Number(req.params.id);
    const role = await Role.findByPk(id, { include: [Permission] });
    if (!role) {
      return res.status(404).json({ error: 'Role not found' });
    }
    const permissions = role.Permissions || [];
    const granted = permissions.map((p) => (p.action ? `${p.resource}.${p.action}` : p.resource));
    res.status(200).json({
      role_id: role.role_id,
      role_code: role.role_code,
      role_name: role.role_name,
      description: role.description,
      level: role.level,
      status: role.status || 'active',
      created_at: role.created_at ? String(role.created_at) : '',
      updated_at: role.updated_at ? String(role.updated_at) : '',
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
    for (const key of granted) {
      const resource = typeof key === 'string' ? key.split('.')[0] : String(key);
      const [perm] = await Permission.findOrCreate({
        where: { resource, action: 'view' },
        defaults: { resource, action: 'view' },
      });
      await RolePermission.findOrCreate({
        where: { role_id: role.role_id, permission_id: perm.permission_id },
        defaults: { role_id: role.role_id, permission_id: perm.permission_id },
      });
    }
    const perms = await role.getPermissions();
    const grantedOut = perms.map((p) => (p.action ? `${p.resource}.${p.action}` : p.resource));
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
    res.status(500).json({ error: err.message });
  }
}

async function updateRole(req, res) {
  try {
    const id = Number(req.params.id);
    const role = await Role.findByPk(id);
    if (!role) {
      return res.status(404).json({ error: 'Role not found' });
    }
    const body = req.body || {};
    if (body.role_code != null) role.role_code = String(body.role_code).trim();
    if (body.role_name != null) role.role_name = String(body.role_name).trim();
    if (body.description !== undefined) role.description = body.description != null ? String(body.description) : null;
    if (body.level != null) role.level = String(body.level).trim();
    if (body.status != null) role.status = String(body.status);
    await role.save();
    if (body.permissions && Array.isArray(body.permissions.granted)) {
      await RolePermission.destroy({ where: { role_id: id } });
      for (const key of body.permissions.granted) {
        const resource = typeof key === 'string' ? key.split('.')[0] : String(key);
        const [perm] = await Permission.findOrCreate({
          where: { resource, action: 'view' },
          defaults: { resource, action: 'view' },
        });
        await RolePermission.create({ role_id: id, permission_id: perm.permission_id });
      }
    }
    const perms = await role.getPermissions();
    const granted = perms.map((p) => (p.action ? `${p.resource}.${p.action}` : p.resource));
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
    res.status(500).json({ error: err.message });
  }
}

async function deleteRole(req, res) {
  try {
    const id = Number(req.params.id);
    if (SYSTEM_ROLE_IDS.includes(id)) {
      return res.status(403).json({ error: 'System roles cannot be deleted' });
    }
    const role = await Role.findByPk(id);
    if (!role) {
      return res.status(404).json({ error: 'Role not found' });
    }
    await RolePermission.destroy({ where: { role_id: id } });
    await role.destroy();
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
};

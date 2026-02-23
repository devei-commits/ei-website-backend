const { Role, StaffProfile } = require('../models/index');
const { getModuleDefinitions, getDefaultGlobalSettings } = require('./moduleDefinitions');
const { Op } = require('sequelize');

/**
 * GET /roles — List roles (admin only).
 * Response: array of { role_id, role_code, role_name, description, level, status, userCount, createdAt }
 */
const listRoles = async (req, res) => {
  try {
    const roles = await Role.findAll({
      attributes: ['role_id', 'role_code', 'role_name', 'description', 'level', 'status', 'created_at', 'permissions_json'],
      order: [['role_id', 'ASC']],
    });
    const roleIds = roles.map((r) => r.role_id);
    const countRows = await StaffProfile.findAll({
      attributes: ['role_id'],
      where: { role_id: { [Op.in]: roleIds } },
      raw: true,
    });
    const countMap = {};
    countRows.forEach((r) => {
      countMap[r.role_id] = (countMap[r.role_id] || 0) + 1;
    });
    const list = roles.map((r) => {
      const granted = r.permissions_json && Array.isArray(r.permissions_json.granted) ? r.permissions_json.granted : [];
      return {
        role_id: r.role_id,
        role_code: r.role_code,
        role_name: r.role_name,
        description: r.description,
        level: r.level,
        status: r.status,
        userCount: countMap[r.role_id] ?? 0,
        permissionsSet: granted.length > 0,
        createdAt: r.created_at,
      };
    });
    res.status(200).json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /roles/module-definitions — Static module/submodule list for Permission Matrix UI.
 */
const getModuleDefinitionsHandler = async (req, res) => {
  try {
    const modules = getModuleDefinitions();
    const globalSettings = getDefaultGlobalSettings();
    res.status(200).json({ modules, globalSettings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /roles/:id — One role. permissions = { granted: string[], globalSettings? } (minimal state; module tree lives in frontend).
 */
const getRoleById = async (req, res) => {
  try {
    const role = await Role.findByPk(req.params.id);
    if (!role) {
      return res.status(404).json({ error: 'Role not found' });
    }
    const payload = {
      role_id: role.role_id,
      role_code: role.role_code,
      role_name: role.role_name,
      description: role.description,
      level: role.level,
      status: role.status,
      created_at: role.created_at,
      updated_at: role.updated_at,
    };
    if (role.permissions_json && typeof role.permissions_json === 'object' && Array.isArray(role.permissions_json.granted)) {
      payload.permissions = role.permissions_json;
    } else {
      payload.permissions = { granted: [], globalSettings: getDefaultGlobalSettings() };
    }
    res.status(200).json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * POST /roles — Create role. permissions = { granted: string[], globalSettings? } only (minimal state).
 */
const createRole = async (req, res) => {
  try {
    const { role_code, role_name, description, level, status, permissions } = req.body;
    if (!role_code || !role_name || level == null) {
      return res.status(400).json({ error: 'role_code, role_name, and level are required' });
    }
    const existing = await Role.findOne({ where: { role_code } });
    if (existing) {
      return res.status(409).json({ error: 'Role with this role_code already exists' });
    }
    const permissionsJson = permissions && Array.isArray(permissions.granted)
      ? { granted: permissions.granted, globalSettings: permissions.globalSettings || getDefaultGlobalSettings() }
      : null;
    const role = await Role.create({
      role_code,
      role_name,
      description: description || null,
      level: level || 'staff',
      status: status || 'active',
      permissions_json: permissionsJson,
    });
    const payload = {
      role_id: role.role_id,
      role_code: role.role_code,
      role_name: role.role_name,
      description: role.description,
      level: role.level,
      status: role.status,
      permissions: role.permissions_json || { granted: [], globalSettings: getDefaultGlobalSettings() },
      created_at: role.created_at,
    };
    res.status(201).json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * PUT /roles/:id — Update role. permissions = { granted: string[], globalSettings? } only; replaces existing.
 */
const updateRole = async (req, res) => {
  try {
    const role = await Role.findByPk(req.params.id);
    if (!role) {
      return res.status(404).json({ error: 'Role not found' });
    }
    const { role_code, role_name, description, level, status, permissions } = req.body;
    if (role_code != null) role.role_code = role_code;
    if (role_name != null) role.role_name = role_name;
    if (description !== undefined) role.description = description;
    if (level != null) role.level = level;
    if (status != null) role.status = status;
    if (permissions && Array.isArray(permissions.granted)) {
      role.permissions_json = {
        granted: permissions.granted,
        globalSettings: permissions.globalSettings ?? role.permissions_json?.globalSettings ?? getDefaultGlobalSettings(),
      };
    }
    await role.save();
    const payload = {
      role_id: role.role_id,
      role_code: role.role_code,
      role_name: role.role_name,
      description: role.description,
      level: role.level,
      status: role.status,
      permissions: role.permissions_json || { granted: [], globalSettings: getDefaultGlobalSettings() },
      updated_at: role.updated_at,
    };
    res.status(200).json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * DELETE /roles/:id — Delete role if no staff_profiles reference it.
 */
const deleteRole = async (req, res) => {
  try {
    const role = await Role.findByPk(req.params.id);
    if (!role) {
      return res.status(404).json({ error: 'Role not found' });
    }
    const count = await StaffProfile.count({ where: { role_id: role.role_id } });
    if (count > 0) {
      return res.status(400).json({ error: 'Cannot delete role: one or more staff members are assigned to it' });
    }
    await role.destroy();
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  listRoles,
  getModuleDefinitionsHandler,
  getRoleById,
  createRole,
  updateRole,
  deleteRole,
};

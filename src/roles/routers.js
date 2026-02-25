/**
 * Roles API. Every route is protected by:
 * 1. isAuthenticated — ensures the user is logged in and req.user is set
 * 2. requireModule('role-management') — ensures the user has access to role-management (super_admin has '*' so can access)
 * Only users with that permission can list roles, get module definitions, get/update/delete a role, or create one.
 */
const express = require('express');
const router = express.Router();
const {
  listRoles,
  getModuleDefinitionsHandler,
  getRoleById,
  createRole,
  updateRole,
  deleteRole,
} = require('./controller');
const { isAuthenticated, requireModule } = require('../middleware/security');

// Middleware: authenticate then check that the user has permission to access role-management
const requireRoleManagement = [isAuthenticated, requireModule('role-management')];

// Static path must be registered before /:id
router.get('/module-definitions', ...requireRoleManagement, getModuleDefinitionsHandler);

router.get('/', ...requireRoleManagement, listRoles);
router.get('/:id', ...requireRoleManagement, getRoleById);
router.post('/', ...requireRoleManagement, createRole);
router.put('/:id', ...requireRoleManagement, updateRole);
router.delete('/:id', ...requireRoleManagement, deleteRole);

module.exports = router;

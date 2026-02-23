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
const { isAuthenticated, authorizeRoles } = require('../middleware/security');

const adminOnly = [isAuthenticated, authorizeRoles('super_admin', 'admin')];

// Static route must be before /:id
router.get('/module-definitions', ...adminOnly, getModuleDefinitionsHandler);

router.get('/', ...adminOnly, listRoles);
router.get('/:id', ...adminOnly, getRoleById);
router.post('/', ...adminOnly, createRole);
router.put('/:id', ...adminOnly, updateRole);
router.delete('/:id', ...adminOnly, deleteRole);

module.exports = router;

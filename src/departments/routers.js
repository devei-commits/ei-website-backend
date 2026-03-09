const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const {
  listDepartments, getDepartmentById, createDepartment, updateDepartment, deleteDepartment,
} = require('./controller');

// Any authenticated user can list departments (needed for dropdowns)
router.get('/', isAuthenticated, listDepartments);
router.get('/:id', isAuthenticated, getDepartmentById);

// Only users with user-management access can create/update/delete
router.post('/', isAuthenticated, requireModule('user-management'), createDepartment);
router.patch('/:id', isAuthenticated, requireModule('user-management'), updateDepartment);
router.delete('/:id', isAuthenticated, requireModule('user-management'), deleteDepartment);

module.exports = router;

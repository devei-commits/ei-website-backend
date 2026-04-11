const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const {
  listAdminCustomizationPackaging,
  getCustomizationPackagingByPk,
  createCustomizationPackaging,
  updateCustomizationPackaging,
  deleteCustomizationPackaging,
} = require('./controller');

const guard = [isAuthenticated, requireModule('packaging-management')];

router.get('/', guard, listAdminCustomizationPackaging);
router.post('/', guard, createCustomizationPackaging);
router.get('/:id', guard, getCustomizationPackagingByPk);
router.put('/:id', guard, updateCustomizationPackaging);
router.delete('/:id', guard, deleteCustomizationPackaging);

module.exports = router;

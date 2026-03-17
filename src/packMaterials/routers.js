const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const {
  listPackMaterials,
  getNextCode,
  getPackMaterialById,
  createPackMaterial,
  updatePackMaterial,
  deletePackMaterial,
  getReservedStock,
} = require('./controller');

const requirePackMaterials = [isAuthenticated, requireModule('packaging-management')];

router.get('/next-code', requirePackMaterials, getNextCode);
router.post('/', requirePackMaterials, createPackMaterial);
router.get('/:id/reserved-stock', requirePackMaterials, getReservedStock);
router.get('/:id', requirePackMaterials, getPackMaterialById);
router.put('/:id', requirePackMaterials, updatePackMaterial);
router.delete('/:id', requirePackMaterials, deletePackMaterial);
router.get('/', requirePackMaterials, listPackMaterials);

module.exports = router;

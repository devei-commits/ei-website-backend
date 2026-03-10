const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { listRawMaterials, getRawMaterialById, createRawMaterial, updateRawMaterial, deleteRawMaterial, getReservedStock } = require('./controller');

const requireRawMaterials = [isAuthenticated, requireModule('raw-materials-management')];

router.get('/', requireRawMaterials, listRawMaterials);
router.post('/', requireRawMaterials, createRawMaterial);
router.get('/:id/reserved-stock', requireRawMaterials, getReservedStock);
router.get('/:id', requireRawMaterials, getRawMaterialById);
router.put('/:id', requireRawMaterials, updateRawMaterial);
router.delete('/:id', requireRawMaterials, deleteRawMaterial);

module.exports = router;

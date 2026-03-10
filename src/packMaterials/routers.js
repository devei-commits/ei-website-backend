const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { listPackMaterials, getNextCode, createPackMaterial, getReservedStock } = require('./controller');

const requirePackMaterials = [isAuthenticated, requireModule('packaging-management')];

router.get('/next-code', requirePackMaterials, getNextCode);
router.post('/', requirePackMaterials, createPackMaterial);
router.get('/:id/reserved-stock', requirePackMaterials, getReservedStock);
router.get('/', requirePackMaterials, listPackMaterials);

module.exports = router;

const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { listRawMaterials, getRawMaterialById, getNextCode, syncRmZoho, createRawMaterial, updateRawMaterial, deleteRawMaterial, getReservedStock } = require('./controller');
const { createCacheReadMiddleware } = require('../cache/cacheReadMiddleware');

const requireRawMaterials = [isAuthenticated, requireModule('raw-materials-management')];

const cacheRawMaterialsList = createCacheReadMiddleware({ namespace: 'raw-materials', ttlSeconds: 120 });
const cacheRawMaterialsOne = createCacheReadMiddleware({ namespace: 'raw-materials', ttlSeconds: 300 });

router.get('/', requireRawMaterials, cacheRawMaterialsList, listRawMaterials);
router.get('/next-code', requireRawMaterials, getNextCode);
router.post('/zoho-sync', requireRawMaterials, syncRmZoho);
router.post('/', requireRawMaterials, createRawMaterial);
router.get('/:id/reserved-stock', requireRawMaterials, getReservedStock);
router.get('/:id', requireRawMaterials, cacheRawMaterialsOne, getRawMaterialById);
router.put('/:id', requireRawMaterials, updateRawMaterial);
router.delete('/:id', requireRawMaterials, deleteRawMaterial);

module.exports = router;

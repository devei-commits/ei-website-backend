const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const {
  listPackMaterials,
  getNextCode,
  getPackMaterialById,
  syncPmZoho,
  createPackMaterial,
  updatePackMaterial,
  deletePackMaterial,
  getReservedStock,
} = require('./controller');
const { createCacheReadMiddleware } = require('../cache/cacheReadMiddleware');

const requirePackMaterials = [isAuthenticated, requireModule('packaging-management')];

const cachePackMaterialsList = createCacheReadMiddleware({ namespace: 'pack-materials', ttlSeconds: 120 });
const cachePackMaterialsOne = createCacheReadMiddleware({ namespace: 'pack-materials', ttlSeconds: 300 });

router.get('/next-code', requirePackMaterials, getNextCode);
router.post('/zoho-sync', requirePackMaterials, syncPmZoho);
router.post('/', requirePackMaterials, createPackMaterial);
router.get('/:id/reserved-stock', requirePackMaterials, getReservedStock);
router.get('/:id', requirePackMaterials, cachePackMaterialsOne, getPackMaterialById);
router.put('/:id', requirePackMaterials, updatePackMaterial);
router.delete('/:id', requirePackMaterials, deletePackMaterial);
router.get('/', requirePackMaterials, cachePackMaterialsList, listPackMaterials);

module.exports = router;

const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { listRawMaterials, getRawMaterialById, getNextCode, syncRmZoho, createRawMaterial, updateRawMaterial, deleteRawMaterial, getReservedStock } = require('./controller');
const { postItemReferenceBulkChunk } = require('../masterBulk/itemReferenceBulkChunk');
const { createCacheReadMiddleware } = require('../cache/cacheReadMiddleware');

const requireRawMaterials = [isAuthenticated, requireModule('raw-materials-management')];
const requireItemReferenceBulk = [
  isAuthenticated,
  requireModule('packaging-management', 'raw-materials-management'),
];
/** List (GET /) only: procurement / planning need RM codes to record quotations & POs without full master-edit access. */
const requireRawMaterialsListRead = [
  isAuthenticated,
  requireModule('raw-materials-management', 'sales-purchase', 'order-management', 'vendor-client'),
];

const cacheRawMaterialsList = createCacheReadMiddleware({ namespace: 'raw-materials', ttlSeconds: 120 });
const cacheRawMaterialsOne = createCacheReadMiddleware({ namespace: 'raw-materials', ttlSeconds: 300 });

router.get('/', requireRawMaterialsListRead, cacheRawMaterialsList, listRawMaterials);
router.get('/next-code', requireRawMaterials, getNextCode);
router.post('/item-reference-bulk-chunk', requireItemReferenceBulk, postItemReferenceBulkChunk);
router.post('/zoho-sync', requireRawMaterials, syncRmZoho);
router.post('/', requireRawMaterials, createRawMaterial);
router.get('/:id/reserved-stock', requireRawMaterials, getReservedStock);
router.get('/:id', requireRawMaterials, cacheRawMaterialsOne, getRawMaterialById);
router.put('/:id', requireRawMaterials, updateRawMaterial);
router.delete('/:id', requireRawMaterials, deleteRawMaterial);

module.exports = router;

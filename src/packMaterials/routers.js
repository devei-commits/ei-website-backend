const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { requireMasterApprovalUpdate } = require('../lib/masterApprovalAuth');
const {
  listPackMaterials,
  getNextCode,
  getPackMaterialById,
  syncPmZoho,
  createPackMaterial,
  updatePackMaterial,
  patchPackMaterialApprovalStatus,
  deletePackMaterial,
  getReservedStock,
  resetAllPackMaterials,
} = require('./controller');
const { postItemReferenceBulkChunk } = require('../masterBulk/itemReferenceBulkChunk');
const { uploadPmMasterExcelMiddleware, postPmMasterExcelUpload } = require('../masterBulk/pmMasterExcelUpload');
const { createCacheReadMiddleware } = require('../cache/cacheReadMiddleware');

const requirePackMaterials = [isAuthenticated, requireModule('packaging-management')];
/** Item Reference excel bulk — user may have only PM or only RM; handler skips rows by module. */
const requireItemReferenceBulk = [
  isAuthenticated,
  requireModule('packaging-management', 'raw-materials-management'),
];
/** List (GET /) only: same as raw materials — quotation & PO flows need PM lookup without packaging-management. */
const requirePackMaterialsListRead = [
  isAuthenticated,
  requireModule('packaging-management', 'sales-purchase', 'order-management', 'vendor-client'),
];

const cachePackMaterialsList = createCacheReadMiddleware({ namespace: 'pack-materials', ttlSeconds: 120 });
const cachePackMaterialsOne = createCacheReadMiddleware({ namespace: 'pack-materials', ttlSeconds: 300 });

function uploadPmMasterExcelSafe(req, res, next) {
  uploadPmMasterExcelMiddleware(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'File upload failed' });
    next();
  });
}

function resetAllPmMethodNotAllowed(_req, res) {
  res.status(405).json({
    error:
      'Use POST /api/v1/pack-materials/reset-all with JSON body { "confirm": "RESET_ALL_PACK_MATERIALS" } (Bearer auth required).',
  });
}

router.get('/next-code', requirePackMaterials, getNextCode);
router.get('/reset-all', resetAllPmMethodNotAllowed);
router.post('/reset-all', requirePackMaterials, resetAllPackMaterials);
router.post('/zoho-sync', requirePackMaterials, syncPmZoho);
router.post('/item-reference-bulk-chunk', requireItemReferenceBulk, postItemReferenceBulkChunk);
router.post('/import-excel', requirePackMaterials, uploadPmMasterExcelSafe, postPmMasterExcelUpload);
router.post('/', requirePackMaterials, createPackMaterial);
router.get('/:id/reserved-stock', requirePackMaterials, getReservedStock);
router.get('/:id', requirePackMaterials, cachePackMaterialsOne, getPackMaterialById);
router.patch('/:id/approval-status', requirePackMaterials, requireMasterApprovalUpdate('PM'), patchPackMaterialApprovalStatus);
router.put('/:id', requirePackMaterials, updatePackMaterial);
router.delete('/:id', requirePackMaterials, deletePackMaterial);
router.get('/', requirePackMaterialsListRead, cachePackMaterialsList, listPackMaterials);

module.exports = router;

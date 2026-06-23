const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { requireMasterApprovalUpdate } = require('../lib/masterApprovalAuth');
const {
  listRawMaterials,
  getRawMaterialById,
  syncRmZoho,
  createRawMaterial,
  updateRawMaterial,
  patchRawMaterialApprovalStatus,
  getRawMaterialApprovalStatusHistory,
  deleteRawMaterial,
  getReservedStock,
  resetAllRawMaterials,
} = require('./controller');
const { postItemReferenceBulkChunk } = require('../masterBulk/itemReferenceBulkChunk');
const { uploadRmMasterExcelMiddleware, postRmMasterExcelUpload } = require('../masterBulk/rmMasterExcelUpload');
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

function uploadRmMasterExcelSafe(req, res, next) {
  uploadRmMasterExcelMiddleware(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'File upload failed' });
    next();
  });
}

/** Avoid treating "reset-all" as a numeric id on GET (was returning "Raw material not found"). */
function resetAllMethodNotAllowed(_req, res) {
  res.status(405).json({
    error:
      'Use POST /api/v1/raw-materials/reset-all with JSON body { "confirm": "RESET_ALL_RAW_MATERIALS" } (Bearer auth required).',
  });
}

router.get('/', requireRawMaterialsListRead, cacheRawMaterialsList, listRawMaterials);
router.get('/reset-all', resetAllMethodNotAllowed);
router.post('/reset-all', requireRawMaterials, resetAllRawMaterials);
router.post('/item-reference-bulk-chunk', requireItemReferenceBulk, postItemReferenceBulkChunk);
router.post('/import-excel', requireRawMaterials, uploadRmMasterExcelSafe, postRmMasterExcelUpload);
router.post('/zoho-sync', requireRawMaterials, syncRmZoho);
router.post('/', requireRawMaterials, createRawMaterial);
router.get('/:id/reserved-stock', requireRawMaterials, getReservedStock);
router.get('/:id', requireRawMaterials, cacheRawMaterialsOne, getRawMaterialById);
router.get('/:id/approval-status/history', requireRawMaterialsListRead, getRawMaterialApprovalStatusHistory);
router.patch('/:id/approval-status', requireRawMaterials, requireMasterApprovalUpdate('RM'), patchRawMaterialApprovalStatus);
router.put('/:id', requireRawMaterials, updateRawMaterial);
router.delete('/:id', requireRawMaterials, deleteRawMaterial);

module.exports = router;

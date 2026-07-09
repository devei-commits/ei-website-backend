const express = require('express');
const router = express.Router();
const { requireModule } = require('../middleware/security');
const { requireMasterApprovalUpdate } = require('../lib/masterApprovalAuth');
const { getAllProducts, saveProduct, syncPrProductZoho, createPRRegistration, getProductById, getProductDetail, updateProduct, patchProductApprovalStatus, claimProductApprovalTrack, getProductApprovalStatusHistory, deleteProduct, getCategory, saveCategory, getCategoryById, updateCategory, deleteCategory } = require('./controller');
const { getZohoCompositeSkuBomSuggestion } = require('./zohoCompositeSkuBomSuggestion');
const {
  uploadSkuBomExcelMiddleware,
  uploadSkuBomExcel,
  clearSkuBomForReimport,
  clearPrBomFullForExcelReimport,
  clearAllPrBomForExcelReimport,
} = require('./skuBomExcelUpload');
const {
  uploadFormulaRmBomExcelMiddleware,
  uploadFormulaRmBomExcel,
  processFormulaRmBomChunk,
} = require('./formulaRmBomExcelUpload');
const {
  uploadFormulaPackBomExcelMiddleware,
  uploadFormulaPackBomExcel,
  processFormulaPackBomChunk,
} = require('./formulaPackBomExcelUpload');
const { processFormulaSummaryChunk } = require('./formulaSummaryExcelUpload');
const { createCacheReadMiddleware } = require('../cache/cacheReadMiddleware');

const requireCatalogueModule = requireModule('catalogue-management', 'packaging-management', 'active-ingredients');

const cacheProductsList = createCacheReadMiddleware({ namespace: 'products', ttlSeconds: 120 });
const cacheProductsOne = createCacheReadMiddleware({ namespace: 'products', ttlSeconds: 300 });

// Read: any authenticated user can list and view products
router.get('/', cacheProductsList, getAllProducts);
router.get('/categories', getCategory);
router.get('/categories/:id([0-9]+)', getCategoryById);
/** Zoho Inventory/Books composite → SKU BOM lines (per-unit), before /:id routes. */
router.get(
  '/zoho-composite/:zohoCompositeId([0-9]+)/sku-bom-suggestion',
  requireCatalogueModule,
  getZohoCompositeSkuBomSuggestion
);
router.get('/:id/detail', cacheProductsOne, getProductDetail);
router.get('/:id', cacheProductsOne, getProductById);

// Write: require catalogue/packaging/active-ingredients module
router.post('/pr-zoho-sync', requireCatalogueModule, syncPrProductZoho);
router.post('/pr-registration', requireCatalogueModule, createPRRegistration);
router.post('/', requireCatalogueModule, saveProduct);
/** Multi-composite "Formula BOM - RM per KG-LTR" sheet: SKU RM lines + limits only (before /:id). */
router.post(
  '/formula-rm-bom/upload-excel',
  requireCatalogueModule,
  uploadFormulaRmBomExcelMiddleware,
  uploadFormulaRmBomExcel
);
/** Chunked JSON import for large workbooks (same row shape as formula-rm-bom sheet). */
router.post('/formula-rm-bom/chunk', requireCatalogueModule, processFormulaRmBomChunk);
/** Full-file Packaging BOM sheet import (optional; chunked flow preferred from UI). */
router.post(
  '/formula-pack-bom/upload-excel',
  requireCatalogueModule,
  uploadFormulaPackBomExcelMiddleware,
  uploadFormulaPackBomExcel
);
router.post('/formula-pack-bom/chunk', requireCatalogueModule, processFormulaPackBomChunk);
/** Chunked JSON import for Summary worksheet (PR category, pack size, SG). */
router.post('/formula-summary/chunk', requireCatalogueModule, processFormulaSummaryChunk);
/** Danger: deletes all PR-linked products, all `boms` rows, and dependents (same as per-product delete). Requires confirm body. */
router.post('/bom/full-reset-all', requireCatalogueModule, clearAllPrBomForExcelReimport);
router.post(
  '/:id([0-9]+)/sku-bom/upload-excel',
  requireCatalogueModule,
  uploadSkuBomExcelMiddleware,
  uploadSkuBomExcel
);
/** Clear SKU RM lines + Pack BOM lines (and net limit) for fresh Excel import; keeps formula % and process steps. */
router.post('/:id([0-9]+)/sku-bom/clear', requireCatalogueModule, clearSkuBomForReimport);
/** Full BOM line wipe + clear fill_size for the PR (for Formula BOM / SKU Excel re-import from scratch). */
router.post('/:id([0-9]+)/bom/full-reset', requireCatalogueModule, clearPrBomFullForExcelReimport);
router.get('/:id([0-9]+)/approval-status/history', requireCatalogueModule, getProductApprovalStatusHistory);
router.patch('/:id([0-9]+)/approval-status', requireCatalogueModule, requireMasterApprovalUpdate('PR'), patchProductApprovalStatus);
// Claim an open RM/PM section on first touch — catalogue-gated (same as editing the product),
// so any editor takes ownership immediately, not only approval-permission holders.
router.patch('/:id([0-9]+)/approval-track-claim', requireCatalogueModule, claimProductApprovalTrack);
router.put('/:id', requireCatalogueModule, updateProduct);
router.delete('/:id([0-9]+)', requireCatalogueModule, deleteProduct);
router.post('/categories', requireCatalogueModule, saveCategory);
router.put('/categories/:id([0-9]+)', requireCatalogueModule, updateCategory);
router.delete('/categories/:id([0-9]+)', requireCatalogueModule, deleteCategory);

module.exports = router;
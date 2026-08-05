const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middleware/security');
const {
  list,
  updateStock,
  listLocationHistory,
  listAllLocationHistory,
  getRackLocations,
  getStockByLocation,
  listLowThresholdAlerts,
  listUsageStats,
  getConsumptionBetween,
  getReservedItems,
} = require('./controller');
const {
  uploadInventorySummaryExcelSafe,
  postInventorySummaryExcelImport,
} = require('./inventorySummaryExcelImport');
const {
  uploadSihExcelSafe,
  postWarehouseSihExcelImport,
  postMl1SihExcelImport,
  postMl2SihExcelImport,
  postWarehouseSihExcelChunk,
} = require('./warehouseSihBucketExcelImport');
const { createCacheReadMiddleware } = require('../cache/cacheReadMiddleware');

const cacheWarehouseInventoryList = createCacheReadMiddleware({
  namespace: 'warehouse-inventory',
  ttlSeconds: 120,
});

router.post(
  '/import-inventory-summary-excel',
  isAuthenticated,
  uploadInventorySummaryExcelSafe,
  postInventorySummaryExcelImport
);
router.post(
  '/import-sih-excel/warehouse',
  isAuthenticated,
  uploadSihExcelSafe,
  postWarehouseSihExcelImport
);
// Chunked variant: client parses the workbook and POSTs bounded row batches here (JSON body,
// no file upload) so large files don't produce one long-running request that can time out.
router.post('/import-sih-excel/warehouse/chunk', isAuthenticated, postWarehouseSihExcelChunk);
router.post(
  '/import-sih-excel/ml1',
  isAuthenticated,
  uploadSihExcelSafe,
  postMl1SihExcelImport
);
router.post(
  '/import-sih-excel/ml2',
  isAuthenticated,
  uploadSihExcelSafe,
  postMl2SihExcelImport
);
router.get('/', isAuthenticated, cacheWarehouseInventoryList, list);
router.get('/location-history', isAuthenticated, listAllLocationHistory);
router.get('/reserved-items', isAuthenticated, getReservedItems);
router.get('/low-threshold-alerts', isAuthenticated, listLowThresholdAlerts);
router.get('/usage-stats', isAuthenticated, listUsageStats);
router.get('/consumption-between', isAuthenticated, getConsumptionBetween);
router.patch('/:id', isAuthenticated, updateStock);
router.get('/:id/rack-locations', isAuthenticated, getRackLocations);
router.get('/:id/stock-by-location', isAuthenticated, getStockByLocation);
router.get('/:id/location-history', isAuthenticated, listLocationHistory);

module.exports = router;

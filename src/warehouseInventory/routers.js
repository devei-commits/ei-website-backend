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
} = require('./controller');
const {
  uploadInventorySummaryExcelSafe,
  postInventorySummaryExcelImport,
} = require('./inventorySummaryExcelImport');
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
router.get('/', isAuthenticated, cacheWarehouseInventoryList, list);
router.get('/location-history', isAuthenticated, listAllLocationHistory);
router.get('/low-threshold-alerts', isAuthenticated, listLowThresholdAlerts);
router.get('/usage-stats', isAuthenticated, listUsageStats);
router.patch('/:id', isAuthenticated, updateStock);
router.get('/:id/rack-locations', isAuthenticated, getRackLocations);
router.get('/:id/stock-by-location', isAuthenticated, getStockByLocation);
router.get('/:id/location-history', isAuthenticated, listLocationHistory);

module.exports = router;

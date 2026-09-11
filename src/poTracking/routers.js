const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { getByPurchaseOrderId, getBatchByPurchaseOrderIds, upsertByPurchaseOrderId } = require('./controller');

const guard = [isAuthenticated, requireModule('sales-purchase')];

// Plural batch route — was never registered even though the frontend has always called it
// (fetchPoTrackingBatch); every call 404'd and silently fell back to an empty map.
router.get('/purchase-orders', guard, getBatchByPurchaseOrderIds);
router.get('/purchase-order/:purchaseOrderId', guard, getByPurchaseOrderId);
router.put('/purchase-order/:purchaseOrderId', guard, upsertByPurchaseOrderId);

module.exports = router;

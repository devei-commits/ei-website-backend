const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { getByPurchaseOrderId, upsertByPurchaseOrderId } = require('./controller');

const guard = [isAuthenticated, requireModule('sales-purchase')];

router.get('/purchase-order/:purchaseOrderId', guard, getByPurchaseOrderId);
router.put('/purchase-order/:purchaseOrderId', guard, upsertByPurchaseOrderId);

module.exports = router;

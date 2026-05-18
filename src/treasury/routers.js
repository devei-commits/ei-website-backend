const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { listPurchaseOrdersForTreasury } = require('./controller');

const guard = [isAuthenticated, requireModule('treasury', 'sales-purchase')];

router.get('/purchase-orders', guard, listPurchaseOrdersForTreasury);

module.exports = router;

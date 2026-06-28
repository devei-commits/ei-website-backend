const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { createCacheReadMiddleware } = require('../cache/cacheReadMiddleware');
const {
  listProcurementRequests,
  getProcurementRequestById,
  createProcurementRequest,
  updateProcurementRequest,
  deleteProcurementRequest,
  getItemPriceList,
} = require('./controller');

const guard = [isAuthenticated, requireModule('order-management')];

const cacheProcurementRequests = createCacheReadMiddleware({ namespace: 'procurement', ttlSeconds: 120 });

router.get('/', guard, cacheProcurementRequests, listProcurementRequests);
// Must precede '/:id' so the literal path isn't captured as an id param.
router.get('/item-price-list', guard, getItemPriceList);
router.get('/:id', guard, cacheProcurementRequests, getProcurementRequestById);
router.post('/', guard, createProcurementRequest);
router.patch('/:id', guard, updateProcurementRequest);
router.delete('/:id', guard, deleteProcurementRequest);

module.exports = router;

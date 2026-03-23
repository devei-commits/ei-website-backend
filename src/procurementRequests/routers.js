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
} = require('./controller');

const guard = [isAuthenticated, requireModule('order-management')];

const cacheProcurementRequests = createCacheReadMiddleware({ namespace: 'procurement', ttlSeconds: 120 });

router.get('/', guard, cacheProcurementRequests, listProcurementRequests);
router.get('/:id', guard, cacheProcurementRequests, getProcurementRequestById);
router.post('/', guard, createProcurementRequest);
router.patch('/:id', guard, updateProcurementRequest);
router.delete('/:id', guard, deleteProcurementRequest);

module.exports = router;

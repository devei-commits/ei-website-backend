const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { createCacheReadMiddleware } = require('../cache/cacheReadMiddleware');
const {
  listProcurementQuotations,
  getQuoteLineDefaults,
  getProcurementQuotationById,
  createProcurementQuotation,
  updateProcurementQuotation,
  deleteProcurementQuotation,
} = require('./controller');

const guard = [isAuthenticated, requireModule('order-management')];

const cacheProcurementQuotations = createCacheReadMiddleware({ namespace: 'procurement-quotations', ttlSeconds: 120 });

router.get('/', guard, cacheProcurementQuotations, listProcurementQuotations);
router.get('/quote-line-defaults', guard, cacheProcurementQuotations, getQuoteLineDefaults);
router.get('/:id', guard, cacheProcurementQuotations, getProcurementQuotationById);
router.post('/', guard, createProcurementQuotation);
router.patch('/:id', guard, updateProcurementQuotation);
router.delete('/:id', guard, deleteProcurementQuotation);

module.exports = router;

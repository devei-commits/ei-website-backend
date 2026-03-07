const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const {
  listProcurementQuotations,
  getProcurementQuotationById,
  createProcurementQuotation,
  updateProcurementQuotation,
  deleteProcurementQuotation,
} = require('./controller');

const guard = [isAuthenticated, requireModule('order-management')];

router.get('/', guard, listProcurementQuotations);
router.get('/:id', guard, getProcurementQuotationById);
router.post('/', guard, createProcurementQuotation);
router.patch('/:id', guard, updateProcurementQuotation);
router.delete('/:id', guard, deleteProcurementQuotation);

module.exports = router;

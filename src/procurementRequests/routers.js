const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const {
  listProcurementRequests,
  getProcurementRequestById,
  createProcurementRequest,
  updateProcurementRequest,
  deleteProcurementRequest,
} = require('./controller');

const guard = [isAuthenticated, requireModule('order-management')];

router.get('/', guard, listProcurementRequests);
router.get('/:id', guard, getProcurementRequestById);
router.post('/', guard, createProcurementRequest);
router.patch('/:id', guard, updateProcurementRequest);
router.delete('/:id', guard, deleteProcurementRequest);

module.exports = router;

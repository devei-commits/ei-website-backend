const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const {
  listPlanningQuotationAsks,
  createPlanningQuotationAsk,
  updatePlanningQuotationAsk,
} = require('./controller');

const guard = [isAuthenticated, requireModule('order-management')];

router.get('/', guard, listPlanningQuotationAsks);
router.post('/', guard, createPlanningQuotationAsk);
router.patch('/:id', guard, updatePlanningQuotationAsk);

module.exports = router;

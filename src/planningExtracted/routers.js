const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const {
  listPlanningExtracted,
  getPlanningExtractedById,
  updatePlanningExtracted,
  getItemsInvolved,
  getItemsInvolvedByPlanningId,
} = require('./controller');

const guard = [isAuthenticated, requireModule('order-management')];

router.get('/', guard, listPlanningExtracted);
router.get('/items-involved', guard, getItemsInvolved);
router.get('/:id/items-involved', guard, getItemsInvolvedByPlanningId);
router.get('/:id', guard, getPlanningExtractedById);
router.patch('/:id', guard, updatePlanningExtracted);

module.exports = router;

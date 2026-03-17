const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const {
  listPlanningExtracted,
  getPlanningExtractedById,
  updatePlanningExtracted,
  getBomOverride,
  putBomOverride,
  listAllBatches,
  getSentBatchSummary,
  listBatches,
  getBatchById,
  createOrUpdateBatches,
  addOneBatchFromMaster,
  addRworkBatch,
  updateBatch,
  getItemsInvolved,
  getItemsInvolvedByPlanningId,
} = require('./controller');

const guard = [isAuthenticated, requireModule('order-management')];

router.get('/', guard, listPlanningExtracted);
router.get('/batches/all', guard, listAllBatches);
router.get('/sent-summary', guard, getSentBatchSummary);
router.get('/items-involved', guard, getItemsInvolved);
router.get('/:id/items-involved', guard, getItemsInvolvedByPlanningId);
router.get('/:id/bom-override', guard, getBomOverride);
router.put('/:id/bom-override', guard, putBomOverride);
router.get('/:id/batches', guard, listBatches);
router.post('/:id/batches', guard, createOrUpdateBatches);
router.post('/:id/batches/add-one', guard, addOneBatchFromMaster);
router.post('/:id/batches/add-rework', guard, addRworkBatch);
router.get('/:id/batches/:batchId', guard, getBatchById);
router.put('/:id/batches/:batchId', guard, updateBatch);
router.get('/:id', guard, getPlanningExtractedById);
router.patch('/:id', guard, updatePlanningExtracted);

module.exports = router;

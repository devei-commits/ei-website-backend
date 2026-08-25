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
  deleteBatch,
  createOrUpdateBatches,
  confirmBatchBom,
  addOneBatchFromMaster,
  addRworkBatch,
  updateBatch,
  getItemsInvolved,
  getItemsInvolvedByPlanningId,
  reservePlanningBatchLinesHandler,
  unreservePlanningBatchLinesHandler,
  getPlanningBatchCoverageHandler,
  getPlanningBatchesReservedCountsHandler,
} = require('./controller');
const { createCacheReadMiddleware } = require('../cache/cacheReadMiddleware');

const guard = [isAuthenticated, requireModule('order-management')];

const cachePlanningExtractedList = createCacheReadMiddleware({ namespace: 'planning-extracted', ttlSeconds: 300 });

router.get('/', guard, cachePlanningExtractedList, listPlanningExtracted);
router.get('/batches/all', guard, listAllBatches);
router.get('/sent-summary', guard, getSentBatchSummary);
// Per-planning-batch manual reserve / un-reserve (RM/PM Status popups).
router.get('/batches/reserved-counts', guard, getPlanningBatchesReservedCountsHandler);
router.get('/batches/:planningBatchId/reservation-coverage', guard, getPlanningBatchCoverageHandler);
router.post('/batches/:planningBatchId/reserve-lines', guard, reservePlanningBatchLinesHandler);
router.post('/batches/:planningBatchId/unreserve-lines', guard, unreservePlanningBatchLinesHandler);
const cachePlanningExtractedOne = createCacheReadMiddleware({ namespace: 'planning-extracted', ttlSeconds: 300 });
const cachePlanningItemsInvolved = createCacheReadMiddleware({ namespace: 'planning-extracted', ttlSeconds: 120 });

router.get('/items-involved', guard, cachePlanningItemsInvolved, getItemsInvolved);
router.get('/:id/items-involved', guard, cachePlanningItemsInvolved, getItemsInvolvedByPlanningId);
router.get('/:id/bom-override', guard, getBomOverride);
router.put('/:id/bom-override', guard, putBomOverride);
router.get('/:id/batches', guard, listBatches);
router.post('/:id/batches', guard, createOrUpdateBatches);
router.post('/:id/batches/add-one', guard, addOneBatchFromMaster);
router.post('/:id/batches/add-rework', guard, addRworkBatch);
router.get('/:id/batches/:batchId', guard, getBatchById);
router.post('/:id/batches/:batchId/confirm-bom', guard, confirmBatchBom);
router.put('/:id/batches/:batchId', guard, updateBatch);
router.delete('/:id/batches/:batchId', guard, deleteBatch);
router.get('/:id', guard, cachePlanningExtractedOne, getPlanningExtractedById);
router.patch('/:id', guard, updatePlanningExtracted);

module.exports = router;

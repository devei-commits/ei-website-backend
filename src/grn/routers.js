const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middleware/security');
const { list, getById, create, update, remove, assignableUsers, generateLabels, qcReference } = require('./controller');
const {
  initiateTransit, consolidatedShipment, getShipmentBatch, advanceGrnStage, listGrnTracker,
  listShipmentHistoryForPo,
} = require('./shipmentBatchController');

router.get('/', isAuthenticated, list);
router.get('/assignable-users', isAuthenticated, assignableUsers);
// Shipment Batch + GRN-stage (Procurement spec §4A/§4B/§7) — before '/:id' so literals aren't captured.
router.get('/tracker', isAuthenticated, listGrnTracker);
router.post('/initiate-transit', isAuthenticated, initiateTransit);
router.post('/consolidated-shipment', isAuthenticated, consolidatedShipment);
router.get('/shipment-batches/:sbId', isAuthenticated, getShipmentBatch);
router.get('/shipment-history/:poId', isAuthenticated, listShipmentHistoryForPo);
router.put('/:id/stage', isAuthenticated, advanceGrnStage);
router.get('/:id/qc-reference', isAuthenticated, qcReference);
router.get('/:id', isAuthenticated, getById);
router.post('/', isAuthenticated, create);
router.post('/:id/generate-labels', isAuthenticated, generateLabels);
router.put('/:id', isAuthenticated, update);
router.delete('/:id', isAuthenticated, remove);

module.exports = router;

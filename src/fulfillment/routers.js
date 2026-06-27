const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { createCacheReadMiddleware } = require('../cache/cacheReadMiddleware');
const {
  listOrders, getOrderById, createOrder, updateOrder, deleteOrder,
  pickSplits, invoiceSplits, shipSplits, deliverSplits,
  listBatchSplits,
  getNextSoNo, getCustomers, getProducts, getClientProductPrice,
  listTransporters, createInvoice, listInvoices,
  getSoPlanningAvailability,
} = require('./controller');
const {
  listSalesOrdersDashboard,
  listBatchesDashboard,
  listComments, addComment, resolveComment,
  getSlaTemplate, upsertSlaTemplate,
  updateCommercialStatus,
  createTransporter, updateTransporter, deleteTransporter,
} = require('./dashboardController');

const guard = [isAuthenticated, requireModule('order-management')];

const cacheFulfillment = createCacheReadMiddleware({ namespace: 'fulfillment', ttlSeconds: 120 });

// ── Dashboards (must be before /:id wildcard) ──
router.get('/sales-orders-dashboard', guard, listSalesOrdersDashboard);
router.get('/batches-dashboard', guard, listBatchesDashboard);

// ── Comments & History ──
router.get('/comments/:entityType/:entityId', guard, listComments);
router.post('/comments/:entityType/:entityId', guard, addComment);
router.patch('/comments/:commentId/resolve', guard, resolveComment);

// ── SLA Templates ──
router.get('/sla-templates/:productId', guard, getSlaTemplate);
router.put('/sla-templates/:productId', guard, upsertSlaTemplate);

// ── Standard fulfillment routes ──
router.get('/', guard, cacheFulfillment, listOrders);
router.get('/next-so-no', guard, getNextSoNo);
router.get('/customers', guard, getCustomers);
router.get('/products', guard, getProducts);
router.get('/client-product-price', guard, getClientProductPrice);
router.get('/batch-splits', guard, listBatchSplits);
router.get('/transporters', guard, listTransporters);
router.post('/transporters', guard, createTransporter);
router.patch('/transporters/:id', guard, updateTransporter);
router.delete('/transporters/:id', guard, deleteTransporter);
router.get('/invoices', guard, cacheFulfillment, listInvoices);
router.post('/invoices', guard, createInvoice);
// SO planning availability summary (RM/PM needed vs requested vs available)
router.get('/so-planning-availability', guard, getSoPlanningAvailability);
router.get('/:id', guard, cacheFulfillment, getOrderById);
router.post('/', guard, createOrder);
router.patch('/:id', guard, updateOrder);
router.delete('/:id', guard, deleteOrder);

router.patch('/:id/pick', guard, pickSplits);
router.patch('/:id/invoice', guard, invoiceSplits);
router.patch('/:id/ship', guard, shipSplits);
router.patch('/:id/deliver', guard, deliverSplits);
router.patch('/:id/commercial-status', guard, updateCommercialStatus);

module.exports = router;

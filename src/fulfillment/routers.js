const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { createCacheReadMiddleware } = require('../cache/cacheReadMiddleware');
const {
  listOrders, getOrderById, createOrder, updateOrder, deleteOrder,
  pickSplits, invoiceSplits, shipSplits, deliverSplits,
  listBatchSplits,
  getNextSoNo, getCustomers, getProducts,
  listTransporters, getNextInvoiceNo, createInvoice, listInvoices,
  getSoPlanningAvailability,
} = require('./controller');

const guard = [isAuthenticated, requireModule('order-management')];

const cacheFulfillment = createCacheReadMiddleware({ namespace: 'fulfillment', ttlSeconds: 120 });

router.get('/', guard, cacheFulfillment, listOrders);
router.get('/next-so-no', guard, getNextSoNo);
router.get('/customers', guard, getCustomers);
router.get('/products', guard, getProducts);
router.get('/batch-splits', guard, listBatchSplits);
router.get('/transporters', guard, listTransporters);
router.get('/next-invoice-no', guard, getNextInvoiceNo);
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

module.exports = router;

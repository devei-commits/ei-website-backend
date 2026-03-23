const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { createCacheReadMiddleware } = require('../cache/cacheReadMiddleware');
const {
  getDashboard,
  getClientById,
  createClient,
  addQuery,
  addDevelopment,
  addOrder,
  addAppointment,
  updateQuery,
  updateDevelopment,
  updateOrder,
  updateAppointment,
} = require('./controller');

const guard = [isAuthenticated, requireModule('order-management')];

const cacheClientHub = createCacheReadMiddleware({ namespace: 'client-hub', ttlSeconds: 300 });

router.get('/', guard, cacheClientHub, getDashboard);
router.get('/:id', guard, cacheClientHub, getClientById);
router.post('/clients', guard, createClient);

router.post('/:clientId/queries', guard, addQuery);
router.post('/:clientId/developments', guard, addDevelopment);
router.post('/:clientId/orders', guard, addOrder);
router.post('/:clientId/appointments', guard, addAppointment);

router.put('/queries/:id', guard, updateQuery);
router.put('/developments/:id', guard, updateDevelopment);
router.put('/orders/:id', guard, updateOrder);
router.put('/appointments/:id', guard, updateAppointment);

module.exports = router;

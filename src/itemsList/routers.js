const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const {
  listItemsList,
  getItemsListById,
  createItemsList,
  updateItemsList,
  deleteItemsList,
  listRates,
  createRate,
  updateRate,
  deleteRate,
  createTier,
  updateTier,
  deleteTier,
} = require('./controller');

const guard = [isAuthenticated, requireModule('items-master')];

router.get('/', guard, listItemsList);
router.get('/:id/rates', guard, listRates);
router.post('/:id/rates', guard, createRate);
router.put('/:id/rates/:rateId', guard, updateRate);
router.delete('/:id/rates/:rateId', guard, deleteRate);
router.post('/:id/rates/:rateId/tiers', guard, createTier);
router.put('/:id/rates/:rateId/tiers/:tierId', guard, updateTier);
router.delete('/:id/rates/:rateId/tiers/:tierId', guard, deleteTier);
router.get('/:id', guard, getItemsListById);
router.post('/', guard, createItemsList);
router.put('/:id', guard, updateItemsList);
router.delete('/:id', guard, deleteItemsList);

module.exports = router;

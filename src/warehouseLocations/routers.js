const express = require('express');
const router = express.Router();
const {
  list,
  getLocationById,
  createLocation,
  updateLocation,
  deleteLocation,
  setDefaultLocation,
  getRackById,
  createRack,
  updateRack,
  deleteRack,
  addRackItem,
  removeRackItem,
} = require('./controller');
const { createCacheReadMiddleware } = require('../cache/cacheReadMiddleware');

// Rack routes first so "racks" is not captured as :id
router.get('/racks/:rackId', getRackById);
router.post('/racks', createRack);
router.patch('/racks/:rackId', updateRack);
router.delete('/racks/:rackId', deleteRack);
router.post('/racks/:rackId/items', addRackItem);
router.delete('/racks/:rackId/items/:warehouseInventoryId', removeRackItem);

const cacheWarehouseLocationsList = createCacheReadMiddleware({ namespace: 'warehouse-locations', ttlSeconds: 120 });
const cacheWarehouseLocationsOne = createCacheReadMiddleware({ namespace: 'warehouse-locations', ttlSeconds: 300 });

router.get('/', cacheWarehouseLocationsList, list);
router.get('/:id', cacheWarehouseLocationsOne, getLocationById);
router.post('/', createLocation);
router.post('/:id/set-default', setDefaultLocation);
router.patch('/:id', updateLocation);
router.delete('/:id', deleteLocation);

module.exports = router;

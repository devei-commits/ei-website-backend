const express = require('express');
const router = express.Router();
const {
  list,
  getLocationById,
  createLocation,
  updateLocation,
  deleteLocation,
  getRackById,
  createRack,
  updateRack,
  deleteRack,
  addRackItem,
  removeRackItem,
} = require('./controller');

// Rack routes first so "racks" is not captured as :id
router.get('/racks/:rackId', getRackById);
router.post('/racks', createRack);
router.patch('/racks/:rackId', updateRack);
router.delete('/racks/:rackId', deleteRack);
router.post('/racks/:rackId/items', addRackItem);
router.delete('/racks/:rackId/items/:warehouseInventoryId', removeRackItem);

router.get('/', list);
router.get('/:id', getLocationById);
router.post('/', createLocation);
router.patch('/:id', updateLocation);
router.delete('/:id', deleteLocation);

module.exports = router;

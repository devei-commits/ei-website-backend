const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { listAreas, getAreaById, createArea, updateArea, deleteArea, ensureCustomLocation } = require('./controller');

const guard = [isAuthenticated, requireModule('order-management')];

// Open to any authenticated user — called from GRN (warehouse) and Production MU to
// auto-register free-text zone/rack entries into Facility Management.
router.post('/ensure-custom', isAuthenticated, ensureCustomLocation);

router.get('/', guard, listAreas);
router.get('/:id', guard, getAreaById);
router.post('/', guard, createArea);
router.patch('/:id', guard, updateArea);
router.delete('/:id', guard, deleteArea);

module.exports = router;

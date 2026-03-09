const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { listAreas, getAreaById, createArea, updateArea, deleteArea } = require('./controller');

const guard = [isAuthenticated, requireModule('order-management')];

router.get('/', guard, listAreas);
router.get('/:id', guard, getAreaById);
router.post('/', guard, createArea);
router.patch('/:id', guard, updateArea);
router.delete('/:id', guard, deleteArea);

module.exports = router;

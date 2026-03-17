const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middleware/security');
const { list, getById, create, update, remove, assignablePickers, generateLabels, getLocationHistory } = require('./controller');

router.get('/', isAuthenticated, list);
router.get('/assignable-pickers', isAuthenticated, assignablePickers);
router.get('/:id/location-history', isAuthenticated, getLocationHistory);
router.get('/:id', isAuthenticated, getById);
router.post('/', isAuthenticated, create);
router.post('/:id/generate-labels', isAuthenticated, generateLabels);
router.put('/:id', isAuthenticated, update);
router.delete('/:id', isAuthenticated, remove);

module.exports = router;

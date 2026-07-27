const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middleware/security');
const { listAvailable, splitPack, materializeRackStock } = require('./controller');

router.get('/available', isAuthenticated, listAvailable);
router.post('/materialize', isAuthenticated, materializeRackStock);
router.post('/:id/split', isAuthenticated, splitPack);

module.exports = router;

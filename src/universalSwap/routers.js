const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { getAffected, listHistory, applySwap } = require('./controller');

const requireUniversalSwap = [isAuthenticated, requireModule('universal-swap')];

router.get('/affected', requireUniversalSwap, getAffected);
router.get('/history', requireUniversalSwap, listHistory);
router.post('/apply', requireUniversalSwap, applySwap);

module.exports = router;

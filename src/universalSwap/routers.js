const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { getAffected, listHistory, applySwap, getHistoryAffected } = require('./controller');

const requireUniversalSwap = [isAuthenticated, requireModule('universal-swap')];

router.get('/affected', requireUniversalSwap, getAffected);
router.get('/history', requireUniversalSwap, listHistory);
router.get('/history/:id/affected', requireUniversalSwap, getHistoryAffected);
router.post('/apply', requireUniversalSwap, applySwap);

module.exports = router;

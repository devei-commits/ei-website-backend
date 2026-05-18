const express = require('express');
const router = express.Router();
const { createCacheReadMiddleware } = require('../cache/cacheReadMiddleware');
const { getOverview } = require('./controller');

const cacheDashboard = createCacheReadMiddleware({ namespace: 'dashboard', ttlSeconds: 45 });

router.get('/overview', cacheDashboard, getOverview);

module.exports = router;

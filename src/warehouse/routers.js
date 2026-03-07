const express = require('express');
const router = express.Router();
const { getOverview } = require('./controller');

router.get('/overview', getOverview);

module.exports = router;

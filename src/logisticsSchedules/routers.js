const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middleware/security');
const { list, create } = require('./controller');

router.get('/', isAuthenticated, list);
router.post('/', isAuthenticated, create);

module.exports = router;


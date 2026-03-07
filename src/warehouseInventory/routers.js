const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middleware/security');
const { list, updateStock } = require('./controller');

router.get('/', isAuthenticated, list);
router.patch('/:id', isAuthenticated, updateStock);

module.exports = router;

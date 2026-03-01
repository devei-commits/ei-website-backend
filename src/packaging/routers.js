const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { listPackaging, getPackagingById } = require('./controller');

const requirePackaging = [isAuthenticated, requireModule('packaging-management')];

router.get('/', requirePackaging, listPackaging);
router.get('/:id', requirePackaging, getPackagingById);

module.exports = router;

const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { listPackMaterials } = require('./controller');

const requirePackMaterials = [isAuthenticated, requireModule('packaging-management')];

router.get('/', requirePackMaterials, listPackMaterials);

module.exports = router;

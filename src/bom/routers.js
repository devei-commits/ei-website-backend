const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { listBOMs, getBOMById, createBOM } = require('./controller');

const requireBOM = [isAuthenticated, requireModule('packaging-management')];

router.get('/', requireBOM, listBOMs);
router.post('/', requireBOM, createBOM);
router.get('/:id', requireBOM, getBOMById);

module.exports = router;

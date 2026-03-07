const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { listBOMs, getBOMById, createBOM, updateBOM } = require('./controller');

const requireBOM = [isAuthenticated, requireModule('packaging-management')];
const requireBOMOrPlanning = [isAuthenticated, requireModule('packaging-management', 'order-management')];

router.get('/', requireBOMOrPlanning, listBOMs);
router.post('/', requireBOM, createBOM);
router.get('/:id', requireBOMOrPlanning, getBOMById);
router.patch('/:id', requireBOMOrPlanning, updateBOM);

module.exports = router;

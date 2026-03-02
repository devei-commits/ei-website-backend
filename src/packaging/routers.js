const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { listPackaging, getPackagingById, createPackaging, updatePackaging, deletePackaging } = require('./controller');

const requirePackaging = [isAuthenticated, requireModule('packaging-management')];

router.get('/', requirePackaging, listPackaging);
router.post('/', requirePackaging, createPackaging);
router.get('/:id', requirePackaging, getPackagingById);
router.put('/:id', requirePackaging, updatePackaging);
router.delete('/:id', requirePackaging, deletePackaging);

module.exports = router;

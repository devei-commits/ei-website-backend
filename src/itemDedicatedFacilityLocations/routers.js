const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { listAll, upsert, remove, resolve } = require('./controller');

const guard = [isAuthenticated, requireModule('order-management')];

router.get('/', guard, listAll);
router.post('/resolve', isAuthenticated, resolve);
router.post('/upsert', guard, upsert);
router.delete('/:id', guard, remove);

module.exports = router;

const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middleware/security');
const { list, getById, create, update, remove, assignablePickers } = require('./controller');

router.get('/', isAuthenticated, list);
router.get('/assignable-pickers', isAuthenticated, assignablePickers);
router.get('/:id', isAuthenticated, getById);
router.post('/', isAuthenticated, create);
router.put('/:id', isAuthenticated, update);
router.delete('/:id', isAuthenticated, remove);

module.exports = router;

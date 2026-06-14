const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middleware/security');
const { list, getById, create, update, remove, assignableUsers, generateLabels, qcReference } = require('./controller');

router.get('/', isAuthenticated, list);
router.get('/assignable-users', isAuthenticated, assignableUsers);
router.get('/:id/qc-reference', isAuthenticated, qcReference);
router.get('/:id', isAuthenticated, getById);
router.post('/', isAuthenticated, create);
router.post('/:id/generate-labels', isAuthenticated, generateLabels);
router.put('/:id', isAuthenticated, update);
router.delete('/:id', isAuthenticated, remove);

module.exports = router;

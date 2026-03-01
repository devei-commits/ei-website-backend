const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const {
  listItemGroups,
  getNextCode,
  getItemGroupById,
  createItemGroup,
  updateItemGroup,
  deleteItemGroup,
} = require('./controller');

const guard = [isAuthenticated, requireModule('item-groups')];

router.get('/', guard, listItemGroups);
router.get('/next-code', guard, getNextCode);
router.get('/:id', guard, getItemGroupById);
router.post('/', guard, createItemGroup);
router.put('/:id', guard, updateItemGroup);
router.delete('/:id', guard, deleteItemGroup);

module.exports = router;

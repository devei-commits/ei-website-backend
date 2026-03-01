const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const {
  listItemMasters,
  getItemMasterById,
  createItemMaster,
  updateItemMaster,
  deleteItemMaster,
} = require('./controller');

const requireItemsMaster = [isAuthenticated, requireModule('items-master')];

router.get('/', requireItemsMaster, listItemMasters);
router.get('/:id', requireItemsMaster, getItemMasterById);
router.post('/', requireItemsMaster, createItemMaster);
router.put('/:id', requireItemsMaster, updateItemMaster);
router.delete('/:id', requireItemsMaster, deleteItemMaster);

module.exports = router;

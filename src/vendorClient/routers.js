const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const {
  listVendorClients,
  getVendorClientById,
  getNextCode,
  createVendorClient,
  updateVendorClient,
  deleteVendorClient,
} = require('./controller');

const requireVendorClient = [isAuthenticated, requireModule('vendor-client')];

router.get('/', requireVendorClient, listVendorClients);
router.get('/next-code', requireVendorClient, getNextCode);
router.get('/:id', requireVendorClient, getVendorClientById);
router.post('/', requireVendorClient, createVendorClient);
router.put('/:id', requireVendorClient, updateVendorClient);
router.delete('/:id', requireVendorClient, deleteVendorClient);

module.exports = router;

const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const {
  listVendorClients,
  getVendorClientById,
  getNextCode,
  syncZohoVendorDraft,
  importZohoVendors,
  importZohoVendor,
  createVendorClient,
  updateVendorClient,
  deleteVendorClient,
} = require('./controller');
const {
  uploadClientMasterExcelSafe,
  postClientMasterExcelImport,
} = require('./clientMasterExcelImport');
const {
  uploadVendorMasterExcelSafe,
  postVendorMasterExcelImport,
} = require('./vendorMasterExcelImport');

const requireVendorClient = [isAuthenticated, requireModule('vendor-client')];

router.get('/', requireVendorClient, listVendorClients);
router.post(
  '/import-excel',
  requireVendorClient,
  uploadClientMasterExcelSafe,
  postClientMasterExcelImport
);
router.post(
  '/import-vendor-excel',
  requireVendorClient,
  uploadVendorMasterExcelSafe,
  postVendorMasterExcelImport
);



router.get('/next-code', requireVendorClient, getNextCode);
router.post('/sync-zoho', requireVendorClient, syncZohoVendorDraft);
router.post('/import-zoho-vendors', requireVendorClient, importZohoVendors);
router.post('/import-zoho-vendor', requireVendorClient, importZohoVendor);
router.get('/:id', requireVendorClient, getVendorClientById);
router.post('/', requireVendorClient, createVendorClient);
router.put('/:id', requireVendorClient, updateVendorClient);
router.delete('/:id', requireVendorClient, deleteVendorClient);

module.exports = router;

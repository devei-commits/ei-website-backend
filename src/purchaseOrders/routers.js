const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const {
  listPurchaseOrders,
  getPurchaseOrderById,
  createPurchaseOrder,
  updatePurchaseOrder,
  deletePurchaseOrder,
} = require('./controller');
const {
  uploadPrRowsExcelSafe,
  postPrRowsExcelImport,
} = require('./prRowsExcelImport');

const guard = [isAuthenticated, requireModule('sales-purchase')];

router.get('/', guard, listPurchaseOrders);
router.post('/import-excel', guard, uploadPrRowsExcelSafe, postPrRowsExcelImport);
router.get('/:id', guard, getPurchaseOrderById);
router.post('/', guard, createPurchaseOrder);
router.put('/:id', guard, updatePurchaseOrder);
router.delete('/:id', guard, deletePurchaseOrder);

module.exports = router;

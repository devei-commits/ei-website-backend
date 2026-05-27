const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const {
  listSalesOrders,
  getSalesOrderById,
  createSalesOrder,
  updateSalesOrder,
  deleteSalesOrder,
} = require('./controller');
const {
  uploadOpenSoHeadersExcelSafe,
  postOpenSoHeadersExcelImport,
} = require('./openSoHeadersExcelImport');

const guard = [isAuthenticated, requireModule('sales-purchase')];

router.post('/import-excel', guard, uploadOpenSoHeadersExcelSafe, postOpenSoHeadersExcelImport);
router.get('/', guard, listSalesOrders);
router.get('/:id', guard, getSalesOrderById);
router.post('/', guard, createSalesOrder);
router.put('/:id', guard, updateSalesOrder);
router.delete('/:id', guard, deleteSalesOrder);

module.exports = router;

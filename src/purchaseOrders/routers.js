const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const {
  listPurchaseOrders,
  getPurchaseOrderById,
  createPurchaseOrder,
  updatePurchaseOrder,
  updatePoConnectingDates,
  deletePurchaseOrder,
} = require('./controller');
const {
  uploadPrRowsExcelSafe,
  postPrRowsExcelImport,
} = require('./prRowsExcelImport');
const {
  submitPoForReview,
  actOnPoApproval,
  getPoApprovalTrail,
} = require('./approvalController');
const {
  sendPoToVendor,
  acknowledgePo,
  rejectPoByVendor,
  resendToVendor,
  reopenAfterReject,
  getVendorState,
} = require('./vendorController');
const {
  getMatchState,
  captureInvoice,
  overrideMatch,
  recordFinalPayment,
  sendToTreasury,
  closePo,
} = require('./matchController');
const {
  getExceptionState,
  holdPo,
  resumePo,
  cancelPo,
  amendPo,
} = require('./exceptionController');
const {
  getGrnExceptionState,
  shortClosePo,
  raiseRtv,
  resolveRtv,
} = require('./grnExceptionController');
const { blockOnExceptions } = require('./poExceptionGuard');

const guard = [isAuthenticated, requireModule('sales-purchase')];
// Block workflow mutations while a PO is on hold or cancelled (exception paths).
const notBlocked = blockOnExceptions();

router.get('/', guard, listPurchaseOrders);
router.post('/import-excel', guard, uploadPrRowsExcelSafe, postPrRowsExcelImport);
// Approval workflow (Sub-flow E) — declared before '/:id' so they resolve first.
router.get('/:id/approval', guard, getPoApprovalTrail);
router.post('/:id/approval/submit', guard, notBlocked, submitPoForReview);
router.post('/:id/approval/action', guard, notBlocked, actOnPoApproval);
// Vendor loop (Sub-flow F — SENT / ACK / reject).
router.get('/:id/vendor', guard, getVendorState);
router.post('/:id/vendor/send', guard, notBlocked, sendPoToVendor);
router.post('/:id/vendor/acknowledge', guard, notBlocked, acknowledgePo);
router.post('/:id/vendor/reject', guard, notBlocked, rejectPoByVendor);
router.post('/:id/vendor/resend', guard, notBlocked, resendToVendor);
router.post('/:id/vendor/reopen', guard, notBlocked, reopenAfterReject);
// 3-way match + Payment → Closed (Sub-flow I).
router.get('/:id/match', guard, getMatchState);
router.post('/:id/match/invoice', guard, notBlocked, captureInvoice);
router.post('/:id/match/override', guard, notBlocked, overrideMatch);
router.post('/:id/match/pay', guard, notBlocked, recordFinalPayment);
router.post('/:id/match/treasury', guard, notBlocked, sendToTreasury);
router.post('/:id/match/close', guard, notBlocked, closePo);
// Exception paths (Hold · Resume · Cancel · Amend) — self-gated, no block middleware.
router.get('/:id/exception', guard, getExceptionState);
router.post('/:id/exception/hold', guard, holdPo);
router.post('/:id/exception/resume', guard, resumePo);
router.post('/:id/exception/cancel', guard, cancelPo);
router.post('/:id/exception/amend', guard, amendPo);
// GRN-stage exceptions (Short-supply short-close · QC-fail RTV) — read GRN read-only.
router.get('/:id/grn-exception', guard, getGrnExceptionState);
router.post('/:id/grn-exception/short-close', guard, notBlocked, shortClosePo);
router.post('/:id/grn-exception/rtv', guard, notBlocked, raiseRtv);
router.post('/:id/grn-exception/rtv-resolve', guard, notBlocked, resolveRtv);
router.get('/:id', guard, getPurchaseOrderById);
router.post('/', guard, createPurchaseOrder);
router.patch('/:id/connecting-dates', guard, updatePoConnectingDates);
router.put('/:id', guard, updatePurchaseOrder);
router.delete('/:id', guard, deletePurchaseOrder);

module.exports = router;

const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { listPurchaseOrdersForTreasury } = require('./controller');
// Side-effect: register Treasury models so db.sync({ alter:true }) creates their tables at boot.
require('./models');
const inward = require('./inwardController');
const outward = require('./outwardController');
const dash = require('./dashboardController');
const recurring = require('./recurringController');
const sourceLink = require('./sourceLink');
const dev = require('./devController');

const guard = [isAuthenticated, requireModule('treasury', 'sales-purchase')];

/* Existing PO-tracking slice */
router.get('/purchase-orders', guard, listPurchaseOrdersForTreasury);

/* Home Dashboard + Cashflow Forecast (View 1) + Payment Schedule (View 5) */
router.get('/dashboard', guard, dash.getDashboard);
router.get('/cashflow', guard, dash.getCashflowForecast);
router.get('/cashflow/day/:date', guard, dash.getCashflowDay);
router.get('/schedule', guard, dash.getSchedule);

/* Recurring Payments (View 6) */
router.get('/recurring', guard, recurring.listRecurring);
router.post('/recurring', guard, recurring.createRecurring);
router.post('/recurring/generate', guard, recurring.generateDue);
router.get('/recurring/:id', guard, recurring.getRecurring);
router.patch('/recurring/:id', guard, recurring.updateRecurring);
router.post('/recurring/:id/pause', guard, recurring.pauseRecurring);
router.post('/recurring/:id/resume', guard, recurring.resumeRecurring);
router.post('/recurring/:id/cancel', guard, recurring.cancelRecurring);

/* Reference reads */
router.get('/bank-accounts', guard, inward.listBankAccounts);
router.get('/clients', guard, inward.listClients);
router.get('/clients/:id/open-invoices', guard, inward.listClientOpenInvoices);

/* Inward Payments (Receivables) — View 2 + popups 5A/5B/5C */
router.get('/inward-payments', guard, inward.listInwardPayments);
router.post('/inward-payments', guard, inward.createInwardPayment);
router.post('/inward-payments/preview', guard, inward.previewNewInward);
router.get('/inward-payments/reschedule-summary/:clientId', guard, inward.clientRescheduleSummary);
router.get('/inward-payments/:id', guard, inward.getInwardPayment);
router.post('/inward-payments/:id/confirm', guard, inward.confirmReceipt);
router.post('/inward-payments/:id/reschedule', guard, inward.rescheduleReceipt);
router.post('/inward-payments/:id/preview-reschedule', guard, inward.previewReschedule);
router.post('/inward-payments/:id/hold', guard, inward.holdReceipt);
router.post('/inward-payments/:id/write-off', guard, inward.writeOffReceipt);
router.post('/inward-payments/:id/cancel', guard, inward.cancelReceipt);

/* Outward Payments (Payables) — View 3 */
router.get('/outward-payments', guard, outward.listOutwardPayments);
router.post('/outward-payments', guard, outward.createOutwardPayment);
router.post('/outward-payments/bulk-approve', guard, outward.bulkApprove);
router.get('/outward-payments/:id', guard, outward.getOutwardPayment);
router.post('/outward-payments/:id/submit', guard, outward.submitOutwardPayment);
router.post('/outward-payments/:id/approve', guard, outward.approveOutwardPayment);
router.post('/outward-payments/:id/reject', guard, outward.rejectOutwardPayment);
router.post('/outward-payments/:id/hold', guard, outward.holdOutwardPayment);
router.post('/outward-payments/:id/schedule', guard, outward.scheduleOutwardPayment);
router.post('/outward-payments/:id/execute', guard, outward.executeOutwardPayment);
router.post('/outward-payments/:id/preview-gate', guard, outward.previewOutwardGate);

/* Approvals Inbox — View 4 */
router.get('/approvals', guard, outward.approvalsInbox);

/* Cross-module wiring (Phase 7) */
router.post('/outward-payments/from-source', guard, sourceLink.pushFromSourceHandler);
router.post('/sync/procurement-payables', guard, sourceLink.syncProcurementHandler);

/* Cash-Risk report + dev/demo data controls */
router.get('/gate-overrides', guard, dev.listGateOverrides);
router.post('/dev/seed-mock', guard, dev.seedMockHandler);
router.post('/dev/reset-mock', guard, dev.resetMockHandler);

module.exports = router;

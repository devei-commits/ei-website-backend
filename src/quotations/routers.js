// ─────────────────────────────────────────────────────────────
// QUOTATION ROUTES — mounted at /api/v1/quotes
// isAuthenticated + authorizeRoles('super_admin') applied at mount
// point in app.js, so every route below is super_admin-only.
// ─────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const c = require('./controller');

// Calculation
router.post('/calculate', c.calculateQuote);

// Grades
router.get('/grades', c.listGrades);
router.post('/grades', c.createGrade);
router.put('/grades/:id', c.updateGrade);
router.delete('/grades/:id', c.deleteGrade);

// Overheads
router.get('/overheads', c.listOverheads);
router.post('/overheads', c.createOverhead);
router.put('/overheads/:id', c.updateOverhead);
router.delete('/overheads/:id', c.deleteOverhead);

// Timeline — procurement
router.get('/timeline/procurement', c.listProcurement);
router.post('/timeline/procurement', c.createProcurement);
router.put('/timeline/procurement/:id', c.updateProcurement);
router.delete('/timeline/procurement/:id', c.deleteProcurement);

// Timeline — manufacturing
router.get('/timeline/manufacturing', c.listManufacturing);
router.post('/timeline/manufacturing', c.createManufacturing);
router.put('/timeline/manufacturing/:id', c.updateManufacturing);
router.delete('/timeline/manufacturing/:id', c.deleteManufacturing);

// Timeline — QC + dispatch
router.get('/timeline/qc', c.listQc);
router.post('/timeline/qc', c.upsertQc);
router.delete('/timeline/qc/:id', c.deleteQc);
router.get('/timeline/dispatch', c.listDispatch);
router.post('/timeline/dispatch', c.upsertDispatch);

// Saved quotes
router.post('/save', c.saveQuote);
router.get('/stats', c.quoteStats);
router.get('/analytics', c.quoteAnalytics);
router.get('/clients', c.listClients);
router.get('/saved', c.listSaved);
router.get('/saved/:id', c.getSaved);
router.post('/saved/:id/status', c.changeStatus);
router.post('/saved/:id/convert', c.convertToSalesOrder);
router.post('/saved/:id/revise', c.reviseQuote);
router.get('/saved/:id/versions', c.listVersions);
router.delete('/saved/:id', c.deleteSaved);

// Persist manually-entered SG back to RM master
router.post('/rm-sg', c.saveRmSg);

// Material lead-time tooling (view/bulk-edit raw_materials & pack_materials)
router.get('/lead-times', c.listLeadTimes);
router.post('/lead-times', c.saveLeadTimes);

// Email (stub)
router.post('/email', c.sendEmail);

module.exports = router;

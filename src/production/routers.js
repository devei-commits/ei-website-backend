const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule, requireAnyGranularAccess, hasGranularAccess } = require('../middleware/security');
const { createCacheReadMiddleware } = require('../cache/cacheReadMiddleware');
const {
  listEquipment, getEquipmentById, createEquipment, updateEquipment, deleteEquipment,
  listTeam,
  listBatches, getBatchById, createBatch, createRworkBatch, splitBatchForVessel, updateBatch, deleteBatch, getBatchBom, getBatchMtrReserved, getBatchDispensingMuStock, syncBatchesFromPlanning,
  listReservedItems, reserveBatchLines, unreserveBatchLines, getBatchReservationCoverage,
  qaApproveBatchDoc,
  ipqaVerifyBatchGate,
  productionConfirmBatchGate,
} = require('./controller');

const guard = [isAuthenticated, requireModule('order-management')];
const productionReadGuard = [
  ...guard,
  requireAnyGranularAccess([
    { resource: 'order-management.production-bmr', action: 'view' },
    { resource: 'order-management.production-bpr', action: 'view' },
    { resource: 'order-management.production-transfer-yield', action: 'view' },
  ]),
];
const productionWriteGuard = [
  ...guard,
  requireAnyGranularAccess([
    { resource: 'order-management.production-bmr', action: 'edit' },
    { resource: 'order-management.production-bpr', action: 'edit' },
    { resource: 'order-management.production-transfer-yield', action: 'edit' },
  ]),
];
// QA sign-off on BMR/BPR docs requires the Quality submodule's approve action specifically.
const qualityApproveGuard = [
  ...guard,
  requireAnyGranularAccess([{ resource: 'order-management.quality', action: 'approve' }]),
];

async function requireBatchGranularEdit(req, res, next) {
  try {
    const body = req.body || {};
    const keys = Object.keys(body);
    const touchesBmr = keys.some((k) => /^bmr_|^team_bmr$|^qc_officer_bmr$|^rm_/.test(k));
    const touchesBpr = keys.some((k) => /^bpr_|^team_bpr$|^qc_officer_bpr$|^pm_/.test(k));
    const touchesYield = keys.some((k) => /_yield$|_batch_accepted$/.test(k));
    const checks = [];
    if (touchesBmr) checks.push(hasGranularAccess(req, 'order-management.production-bmr', 'edit'));
    if (touchesBpr) checks.push(hasGranularAccess(req, 'order-management.production-bpr', 'edit'));
    if (touchesYield) checks.push(hasGranularAccess(req, 'order-management.production-transfer-yield', 'edit'));
    if (checks.length === 0) {
      const [canBmr, canBpr, canYield] = await Promise.all([
        hasGranularAccess(req, 'order-management.production-bmr', 'edit'),
        hasGranularAccess(req, 'order-management.production-bpr', 'edit'),
        hasGranularAccess(req, 'order-management.production-transfer-yield', 'edit'),
      ]);
      if (canBmr || canBpr || canYield) return next();
      return res.sendStatus(403);
    }
    const results = await Promise.all(checks);
    if (results.every(Boolean)) return next();
    return res.sendStatus(403);
  } catch {
    return res.sendStatus(500);
  }
}

const cacheProduction = createCacheReadMiddleware({ namespace: 'production', ttlSeconds: 120 });

// Equipment
router.get('/equipment', productionReadGuard, cacheProduction, listEquipment);
router.get('/equipment/:id', productionReadGuard, cacheProduction, getEquipmentById);
router.post('/equipment', productionWriteGuard, createEquipment);
router.patch('/equipment/:id', productionWriteGuard, updateEquipment);
router.delete('/equipment/:id', productionWriteGuard, deleteEquipment);

// Team
router.get('/team', productionReadGuard, cacheProduction, listTeam);

// Batches (BMR / BPR) — specific paths before :id so they are not matched as id
router.get('/reserved-items', productionReadGuard, listReservedItems);
router.get('/batches', productionReadGuard, cacheProduction, listBatches);
router.post('/batches/sync-from-planning', productionWriteGuard, syncBatchesFromPlanning);
router.post('/batches/create-rework', productionWriteGuard, createRworkBatch);
router.post('/batches/split-for-vessel', productionWriteGuard, splitBatchForVessel);
router.get('/batches/:id/bom', productionReadGuard, cacheProduction, getBatchBom);
router.get('/batches/:id/mtr-reserved', productionReadGuard, getBatchMtrReserved);
router.get('/batches/:id/reservation-coverage', productionReadGuard, getBatchReservationCoverage);
router.post('/batches/:id/qa-approve', qualityApproveGuard, qaApproveBatchDoc);
// IPQA pre-production gate: quality user marks verifications; production lead ticks their confirmations.
router.post('/batches/:id/ipqa-verify', qualityApproveGuard, ipqaVerifyBatchGate);
router.post('/batches/:id/production-confirm', ...guard, requireBatchGranularEdit, productionConfirmBatchGate);
router.post('/batches/:id/reserve-lines', productionWriteGuard, reserveBatchLines);
router.post('/batches/:id/unreserve-lines', productionWriteGuard, unreserveBatchLines);
router.get('/batches/:id/dispensing-mu-stock', productionReadGuard, getBatchDispensingMuStock);
router.get('/batches/:id', productionReadGuard, cacheProduction, getBatchById);
router.post('/batches', productionWriteGuard, createBatch);
router.patch('/batches/:id', ...guard, requireBatchGranularEdit, updateBatch);
router.delete('/batches/:id', productionWriteGuard, deleteBatch);

module.exports = router;

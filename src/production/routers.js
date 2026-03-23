const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const { createCacheReadMiddleware } = require('../cache/cacheReadMiddleware');
const {
  listEquipment, getEquipmentById, createEquipment, updateEquipment, deleteEquipment,
  listTeam, getTeamMemberById, createTeamMember, updateTeamMember, deleteTeamMember,
  listBatches, getBatchById, createBatch, createRworkBatch, updateBatch, deleteBatch, getBatchBom, syncBatchesFromPlanning,
} = require('./controller');

const guard = [isAuthenticated, requireModule('order-management')];

const cacheProduction = createCacheReadMiddleware({ namespace: 'production', ttlSeconds: 120 });

// Equipment
router.get('/equipment', guard, cacheProduction, listEquipment);
router.get('/equipment/:id', guard, cacheProduction, getEquipmentById);
router.post('/equipment', guard, createEquipment);
router.patch('/equipment/:id', guard, updateEquipment);
router.delete('/equipment/:id', guard, deleteEquipment);

// Team
router.get('/team', guard, cacheProduction, listTeam);
router.get('/team/:id', guard, cacheProduction, getTeamMemberById);
router.post('/team', guard, createTeamMember);
router.patch('/team/:id', guard, updateTeamMember);
router.delete('/team/:id', guard, deleteTeamMember);

// Batches (BMR / BPR) — specific paths before :id so they are not matched as id
router.get('/batches', guard, cacheProduction, listBatches);
router.post('/batches/sync-from-planning', guard, syncBatchesFromPlanning);
router.post('/batches/create-rework', guard, createRworkBatch);
router.get('/batches/:id/bom', guard, cacheProduction, getBatchBom);
router.get('/batches/:id', guard, cacheProduction, getBatchById);
router.post('/batches', guard, createBatch);
router.patch('/batches/:id', guard, updateBatch);
router.delete('/batches/:id', guard, deleteBatch);

module.exports = router;

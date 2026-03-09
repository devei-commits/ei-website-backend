const express = require('express');
const router = express.Router();
const { isAuthenticated, requireModule } = require('../middleware/security');
const {
  listEquipment, getEquipmentById, createEquipment, updateEquipment, deleteEquipment,
  listTeam, getTeamMemberById, createTeamMember, updateTeamMember, deleteTeamMember,
  listBatches, getBatchById, createBatch, updateBatch, deleteBatch,
} = require('./controller');

const guard = [isAuthenticated, requireModule('order-management')];

// Equipment
router.get('/equipment', guard, listEquipment);
router.get('/equipment/:id', guard, getEquipmentById);
router.post('/equipment', guard, createEquipment);
router.patch('/equipment/:id', guard, updateEquipment);
router.delete('/equipment/:id', guard, deleteEquipment);

// Team
router.get('/team', guard, listTeam);
router.get('/team/:id', guard, getTeamMemberById);
router.post('/team', guard, createTeamMember);
router.patch('/team/:id', guard, updateTeamMember);
router.delete('/team/:id', guard, deleteTeamMember);

// Batches (BMR / BPR)
router.get('/batches', guard, listBatches);
router.get('/batches/:id', guard, getBatchById);
router.post('/batches', guard, createBatch);
router.patch('/batches/:id', guard, updateBatch);
router.delete('/batches/:id', guard, deleteBatch);

module.exports = router;

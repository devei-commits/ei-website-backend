const express = require('express');
const router = express.Router();
const { 
  createCustomization, 
  getMyCustomizations, 
  getAllCustomizations,
  updateCustomizationAdmin,
  getCustomizationById,
  updateCustomization
} = require('./controllers');

router.post('/', createCustomization);
router.get('/admin/all', getAllCustomizations);
router.put('/admin/:id', updateCustomizationAdmin);
router.get('/', getMyCustomizations);
router.get('/:id', getCustomizationById);
router.put('/:id', updateCustomization);

module.exports = router;

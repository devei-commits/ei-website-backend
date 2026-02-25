const express = require('express');
const router = express.Router();
const { 
  createCustomization, 
  getMyCustomizations, 
  getCustomizationById,
  updateCustomization
} = require('./controllers');

router.post('/', createCustomization);
router.get('/', getMyCustomizations);
router.get('/:id', getCustomizationById);
router.put('/:id', updateCustomization);

module.exports = router;

const express = require('express');
const router = express.Router();
const {
  getAllCustomizations,
  GroupedCategory,
  getCustomizationById,
  createCustomization,
  updateCustomization,
  deleteCustomization,
} = require('./controller');

router.get('/', getAllCustomizations);
router.get('/groupedcategory', GroupedCategory);
router.get('/:id', getCustomizationById);
router.post('/', createCustomization);
router.put('/:id', updateCustomization);
router.delete('/:id', deleteCustomization);

module.exports = router;

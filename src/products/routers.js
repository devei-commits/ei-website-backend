const express = require('express');
const router = express.Router();
const { requireModule } = require('../middleware/security');
const { getAllProducts, saveProduct, getProductById, updateProduct, deleteProduct, getCategory, saveCategory, getCategoryById, updateCategory, deleteCategory } = require('./controller');

router.use(requireModule('catalogue-management', 'packaging-management', 'active-ingredients'));

router.get('/', getAllProducts);
router.get('/:id', getProductById);
router.post('/', saveProduct);
router.put('/:id', updateProduct);
router.delete('/:id([0-9]+)', deleteProduct);
router.get('/categories', getCategory);
router.post('/categories', saveCategory);
router.get('/categories/:id([0-9]+)', getCategoryById);
router.put('/categories/:id([0-9]+)', updateCategory);
router.delete('/categories/:id([0-9]+)', deleteCategory);

module.exports = router;
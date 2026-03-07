const express = require('express');
const router = express.Router();
const { requireModule } = require('../middleware/security');
const { getAllProducts, saveProduct, getProductById, getProductDetail, updateProduct, deleteProduct, getCategory, saveCategory, getCategoryById, updateCategory, deleteCategory } = require('./controller');

const requireCatalogueModule = requireModule('catalogue-management', 'packaging-management', 'active-ingredients');

// Read: any authenticated user can list and view products
router.get('/', getAllProducts);
router.get('/categories', getCategory);
router.get('/categories/:id([0-9]+)', getCategoryById);
router.get('/:id/detail', getProductDetail);
router.get('/:id', getProductById);

// Write: require catalogue/packaging/active-ingredients module
router.post('/', requireCatalogueModule, saveProduct);
router.put('/:id', requireCatalogueModule, updateProduct);
router.delete('/:id([0-9]+)', requireCatalogueModule, deleteProduct);
router.post('/categories', requireCatalogueModule, saveCategory);
router.put('/categories/:id([0-9]+)', requireCatalogueModule, updateCategory);
router.delete('/categories/:id([0-9]+)', requireCatalogueModule, deleteCategory);

module.exports = router;
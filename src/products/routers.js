const express = require('express');
const router = express.Router();
const { requireModule } = require('../middleware/security');
const { getAllProducts, saveProduct, syncPrProductZoho, createPRRegistration, getProductById, getProductDetail, updateProduct, deleteProduct, getCategory, saveCategory, getCategoryById, updateCategory, deleteCategory } = require('./controller');
const { createCacheReadMiddleware } = require('../cache/cacheReadMiddleware');

const requireCatalogueModule = requireModule('catalogue-management', 'packaging-management', 'active-ingredients');

const cacheProductsList = createCacheReadMiddleware({ namespace: 'products', ttlSeconds: 120 });
const cacheProductsOne = createCacheReadMiddleware({ namespace: 'products', ttlSeconds: 300 });

// Read: any authenticated user can list and view products
router.get('/', cacheProductsList, getAllProducts);
router.get('/categories', getCategory);
router.get('/categories/:id([0-9]+)', getCategoryById);
router.get('/:id/detail', cacheProductsOne, getProductDetail);
router.get('/:id', cacheProductsOne, getProductById);

// Write: require catalogue/packaging/active-ingredients module
router.post('/pr-zoho-sync', requireCatalogueModule, syncPrProductZoho);
router.post('/pr-registration', requireCatalogueModule, createPRRegistration);
router.post('/', requireCatalogueModule, saveProduct);
router.put('/:id', requireCatalogueModule, updateProduct);
router.delete('/:id([0-9]+)', requireCatalogueModule, deleteProduct);
router.post('/categories', requireCatalogueModule, saveCategory);
router.put('/categories/:id([0-9]+)', requireCatalogueModule, updateCategory);
router.delete('/categories/:id([0-9]+)', requireCatalogueModule, deleteCategory);

module.exports = router;
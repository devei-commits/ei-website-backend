const express = require('express');
const router = express.Router();
const { authorizeRoles } = require('../middleware/security');
const { getAllProducts, saveProduct, getProductById, updateProduct, deleteProduct, getCategory, saveCategory, getCategoryById, updateCategory, deleteCategory } = require('./controller');

const adminRoles = ['super_admin', 'admin', 'bd_manager'];

router.get('/', getAllProducts);
router.get('/:id', getProductById);
router.post('/',  saveProduct); //authorizeRoles(...adminRoles)
router.put('/:id', authorizeRoles(...adminRoles), updateProduct);
router.delete('/:id([0-9]+)', authorizeRoles(...adminRoles), deleteProduct);
router.get('/categories', getCategory);
router.post('/categories', authorizeRoles(...adminRoles), saveCategory);
router.get('/categories/:id([0-9]+)', getCategoryById);
router.put('/categories/:id([0-9]+)', authorizeRoles(...adminRoles), updateCategory);
router.delete('/categories/:id([0-9]+)', authorizeRoles(...adminRoles), deleteCategory);

module.exports = router;
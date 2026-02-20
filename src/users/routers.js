const express = require('express');
const router = express.Router();
const { createUser, userLogin, updateUserPaymentTerms, getAllUsers, getMe, updateMe, createAddress } = require('./controller');
const { isAuthenticated, authorizeRoles, token, deleteToken } = require('../middleware/security');

// Authentication routes
router.post('/', createUser);
router.post('/login', userLogin);
router.get('/token', token);
router.get('/logout', deleteToken);

// Current user's own details
router.get('/me', isAuthenticated, getMe);
router.put('/me', isAuthenticated, updateMe);
router.post('/addresses', isAuthenticated, createAddress);

// Admin-only: get all users
router.get(
  '/getusers',
  isAuthenticated,
  authorizeRoles('super_admin', 'admin', 'bd_manager'),
  getAllUsers
);

// Admin-approved payment terms update
router.put(
  '/:id/payment-terms',
  isAuthenticated,
  authorizeRoles('super_admin', 'admin', 'bd_manager'),
  updateUserPaymentTerms
);

module.exports = router;

const express = require('express');
const router = express.Router();
const {
  createUser,
  createStaffUser,
  userLogin,
  updateUserPaymentTerms,
  getAllUsers,
  searchUsers,
  getUserById,
  updateUserRole,
  updateUserProfile,
  deleteUser,
  getMe,
  updateMe,
  createAddress,
} = require('./controller');
const { isAuthenticated, requireModule, token, deleteToken } = require('../middleware/security');

// Authentication routes
router.post('/', createUser);
/** Alias for public website signup (website-client tries /users/register first). */
router.post('/register', createUser);
router.post('/login', userLogin);
router.get('/token', token);
router.get('/logout', deleteToken);

// Search users by name/email (for approver dropdowns). Any authenticated user.
router.get('/search', isAuthenticated, searchUsers);

// Current user's own details
router.get('/me', isAuthenticated, getMe);
router.put('/me', isAuthenticated, updateMe);
router.post('/addresses', isAuthenticated, createAddress);

// Admin: require user-management module permission
router.get(
  '/getusers',
  isAuthenticated,
  requireModule('user-management'),
  getAllUsers
);

router.post(
  '/create',
  isAuthenticated,
  requireModule('user-management'),
  createStaffUser
);

router.get(
  '/:id',
  isAuthenticated,
  requireModule('user-management'),
  getUserById
);

router.patch(
  '/:id/role',
  isAuthenticated,
  requireModule('user-management'),
  updateUserRole
);

router.patch(
  '/:id',
  isAuthenticated,
  requireModule('user-management'),
  updateUserProfile
);

router.delete(
  '/:id',
  isAuthenticated,
  requireModule('user-management'),
  deleteUser
);

router.put(
  '/:id/payment-terms',
  isAuthenticated,
  requireModule('user-management'),
  updateUserPaymentTerms
);

module.exports = router;

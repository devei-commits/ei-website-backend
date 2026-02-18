const express = require('express');
const router = express.Router();
const { authorizeRoles } = require('../middleware/security');
const { createPaymentOrder, verifyPayment, approveChequePayment } = require('./controller');

const adminRoles = ['super_admin', 'admin', 'bd_manager'];

router.post('/create', createPaymentOrder);
router.post('/verify', verifyPayment);
router.post('/approve-cheque', authorizeRoles(...adminRoles), approveChequePayment);

module.exports = router;


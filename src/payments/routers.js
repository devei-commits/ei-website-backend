const express = require('express');
const router = express.Router();
const { createPaymentOrder, verifyPayment } = require('./controller');

router.post('/create', createPaymentOrder);
router.post('/verify', verifyPayment);

module.exports = router;


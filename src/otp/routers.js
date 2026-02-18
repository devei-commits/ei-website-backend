const express = require('express');
const router = express.Router();
const { verifyOtp } = require('./controller');

// router.post('/generateotp', );
router.post('/verifyotp', verifyOtp);


module.exports = router;
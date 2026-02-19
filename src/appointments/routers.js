const express = require('express');
const router = express.Router();
const { createAppointment, getAppointments } = require('./controller');
const { isAuthenticated } = require('../middleware/security');

// All appointment routes require authentication
router.post('/', isAuthenticated, createAppointment);
router.get('/', isAuthenticated, getAppointments);

module.exports = router;

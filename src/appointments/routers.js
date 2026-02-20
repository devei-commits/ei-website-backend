const express = require('express');
const router = express.Router();
const { createAppointment, getAppointments } = require('./controller');

// All appointment routes require authentication
router.post('/', createAppointment);
router.get('/', getAppointments);

module.exports = router;

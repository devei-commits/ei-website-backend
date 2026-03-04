const express = require('express');
const router = express.Router();
const { createAppointment, getAppointmentsByUserId, getallAppointment } = require('./controller');

// All appointment routes require authentication
router.post('/', createAppointment);
router.get('/', getallAppointment);
router.get('/:id', getAppointmentsByUserId);
// router.put('/:id', updateAppointment);
// router.delete('/:id', deleteAppointment);

module.exports = router;

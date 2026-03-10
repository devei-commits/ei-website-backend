const Appointment = require('./models');
const { appointmentSchema } = require('./schemas');
const { Op } = require('sequelize');

/**
 * Create a new appointment
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const createAppointment = async (req, res, next) => {
  try {
    // Validate request body
    const { error, value } = appointmentSchema.validate(req.body);
    
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Include the user_id from the authenticated user and manual timestamps
    const now = new Date();
    const appointmentData = {
      ...value,
      user_id: req.user.id,
      lifecycle_status: 'active',
      created_at: now,
      updated_at: now
    };

    const appointment = await Appointment.create(appointmentData);

    res.status(201).json({
      success: true,
      message: 'Appointment created successfully',
      data: appointment
    });
  } catch (err) {
    console.error('Error creating appointment:', err);
    next(err);
  }
};

/**
 * Get all appointments for the logged-in user (as patient or doctor)
 */
const getAppointmentsByUserId = async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Base condition: user is the patient
    const orConditions = [{ user_id: userId }];

    // If the logged-in user is a doctor and we know their legacy doctor ID,
    // also fetch appointments where they are the doctor (by legacy code).
    if (req.user.role === 'doctor' && req.user.doctorIdLegacy) {
      orConditions.push({ doctor_id: req.user.doctorIdLegacy });
    }

    const appointments = await Appointment.findAll({
      where: {
        [Op.or]: orConditions,
      },
      order: [['created_at', 'DESC']]
    });

    res.status(200).json({
      success: true,
      data: appointments
    });
  } catch (err) {
    console.error('Error getting appointments:', err);
    next(err);
  }
};

const getallAppointment = async (req, res, next) => {
  try {
    const appointment = await Appointment.findAll();
    res.status(200).json({
      success: true,
      data: appointment
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

module.exports = {
  createAppointment,
  getAppointmentsByUserId,
  getallAppointment
};

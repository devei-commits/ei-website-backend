const Appointment = require('./models');
const { appointmentSchema } = require('./schemas');

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
const getAppointments = async (req, res, next) => {
  try {
    const userId = req.user.id;
    
    // Find appointments where the user is either the patient or the doctor
    const appointments = await Appointment.findAll({
      where: {
        [require('sequelize').Op.or]: [
          { user_id: userId },
          { doctor_id: userId }
        ]
      },
      order: [['created_at', 'DESC']]
    });

    res.status(200).json({
      success: true,
      data: appointments
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createAppointment,
  getAppointments
};

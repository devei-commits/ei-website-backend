const Newdevelopment = require('./models');
const { newdevelopmentSchema } = require('./schemas');

/**
 * Create a new development request
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware
 */
const createNewdevelopment = async (req, res, next) => {
  try {
    // Validate request body
    const { error, value } = newdevelopmentSchema.validate(req.body);
    
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Include the user_id from the authenticated user and manual timestamps
    const now = new Date();
    const developmentData = {
      ...value,
      user_id: req.user.id,
      created_at: now,
      updated_at: now
    };

    const newdevelopment = await Newdevelopment.create(developmentData);

    res.status(201).json({
      success: true,
      message: 'Development request submitted successfully',
      data: newdevelopment
    });
  } catch (err) {
    console.error('Error creating new development:', err);
    next(err);
  }
};

/**
 * Get all developments for the logged-in user
 */
const getNewdevelopments = async (req, res, next) => {
  try {
    const userId = req.user.id;
    
    const developments = await Newdevelopment.findAll({
      where: { user_id: userId },
      order: [['created_at', 'DESC']]
    });

    res.status(200).json({
      success: true,
      data: developments
    });
  } catch (err) {
    console.error('Error fetching developments:', err);
    next(err);
  }
};

/**
 * Get a specific development by Newdevelopments_id
 */
const getNewdevelopmentById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const development = await Newdevelopment.findOne({
      where: { 
        Newdevelopments_id: id,
        user_id: userId
      }
    });

    if (!development) {
      return res.status(404).json({
        success: false,
        message: 'Development request not found'
      });
    }

    res.status(200).json({
      success: true,
      data: development
    });
  } catch (err) {
    console.error('Error fetching development by ID:', err);
    next(err);
  }
};

module.exports = {
  createNewdevelopment,
  getNewdevelopments,
  getNewdevelopmentById
};

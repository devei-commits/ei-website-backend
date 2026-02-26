const Enquiry = require('./models');
const { enquirySchema } = require('./schemas');
const { ENQUIRY_TYPES, DETAILS_SHAPE_BY_TYPE } = require('./constants');

/** Get allowed enquiry types and suggested details shape per type (for form mapping) */
const getEnquiryTypes = (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      types: ENQUIRY_TYPES,
      detailsShapeByType: DETAILS_SHAPE_BY_TYPE
    }
  });
};

const createEnquiry = async (req, res, next) => {
  try {
    const { error, value } = enquirySchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }
    const now = new Date();
    const data = {
      ...value,
      user_id: req.user.id,
      created_at: now,
      updated_at: now
    };
    const enquiry = await Enquiry.create(data);
    res.status(201).json({
      success: true,
      message: 'Enquiry created successfully',
      data: enquiry
    });
  } catch (err) {
    console.error('Error creating enquiry:', err);
    next(err);
  }
};

const getMyEnquiries = async (req, res, next) => {
  try {
    const enquiries = await Enquiry.findAll({
      where: { user_id: req.user.id },
      order: [['created_at', 'DESC']]
    });
    res.status(200).json({
      success: true,
      data: enquiries
    });
  } catch (err) {
    console.error('Error fetching enquiries:', err);
    next(err);
  }
};

const getEnquiryById = async (req, res, next) => {
  try {
    const enquiry = await Enquiry.findOne({
      where: {
        enquiry_id: req.params.id,
        user_id: req.user.id
      }
    });
    if (!enquiry) {
      return res.status(404).json({
        success: false,
        message: 'Enquiry not found'
      });
    }
    res.status(200).json({
      success: true,
      data: enquiry
    });
  } catch (err) {
    console.error('Error fetching enquiry:', err);
    next(err);
  }
};

const updateEnquiry = async (req, res, next) => {
  try {
    const { error, value } = enquirySchema.validate(req.body, { allowUnknown: true });
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }
    const enquiry = await Enquiry.findOne({
      where: {
        enquiry_id: req.params.id,
        user_id: req.user.id
      }
    });
    if (!enquiry) {
      return res.status(404).json({
        success: false,
        message: 'Enquiry not found'
      });
    }
    const now = new Date();
    await enquiry.update({ ...value, updated_at: now });
    res.status(200).json({
      success: true,
      message: 'Enquiry updated successfully',
      data: enquiry
    });
  } catch (err) {
    console.error('Error updating enquiry:', err);
    next(err);
  }
};

module.exports = {
  getEnquiryTypes,
  createEnquiry,
  getMyEnquiries,
  getEnquiryById,
  updateEnquiry
};

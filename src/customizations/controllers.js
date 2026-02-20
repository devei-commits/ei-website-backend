const ProductCustomization = require('./models');
const { customizationSchema } = require('./schemas');
const { Product } = require('../products/models');

/**
 * Create a new product customization request
 */
const createCustomization = async (req, res, next) => {
  try {
    const { error, value } = customizationSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const now = new Date();
    const customizationData = {
      ...value,
      user_id: req.user.id,
      created_at: now
    };

    const customization = await ProductCustomization.create(customizationData);

    res.status(201).json({
      success: true,
      message: 'Product customization request submitted successfully',
      data: customization
    });
  } catch (err) {
    console.error('Error creating product customization:', err);
    next(err);
  }
};

/**
 * Get all customization requests for the logged-in user
 */
const getMyCustomizations = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const customizations = await ProductCustomization.findAll({
      where: { user_id: userId },
      include: [{ model: Product, as: 'product', attributes: ['product_name', 'product_sku'] }],
      order: [['created_at', 'DESC']]
    });

    res.status(200).json({
      success: true,
      data: customizations
    });
  } catch (err) {
    console.error('Error fetching customizations:', err);
    next(err);
  }
};

/**
 * Get a specific customization by ID
 */
const getCustomizationById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const customization = await ProductCustomization.findOne({
      where: { 
        customization_id: id,
        user_id: userId
      },
      include: [{ model: Product, as: 'product' }]
    });

    if (!customization) {
      return res.status(404).json({
        success: false,
        message: 'Product customization request not found'
      });
    }

    res.status(200).json({
      success: true,
      data: customization
    });
  } catch (err) {
    console.error('Error fetching customization by ID:', err);
    next(err);
  }
};

/**
 * Update a customization request
 */
const updateCustomization = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { error, value } = customizationSchema.validate(req.body, { allowUnknown: true });

    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const customization = await ProductCustomization.findOne({
      where: { customization_id: id, user_id: userId }
    });

    if (!customization) {
      return res.status(404).json({
        success: false,
        message: 'Product customization not found'
      });
    }

    const now = new Date();
    const updateData = {
      ...value,
      updated_at: now
    };

    await customization.update(updateData);

    res.status(200).json({
      success: true,
      message: 'Product customization updated successfully',
      data: customization
    });
  } catch (err) {
    console.error('Error updating product customization:', err);
    next(err);
  }
};

module.exports = {
  createCustomization,
  getMyCustomizations,
  getCustomizationById,
  updateCustomization
};

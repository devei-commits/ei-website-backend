const ProductCustomization = require('./models');
const { customizationSchema } = require('./schemas');
const { Product } = require('../products/models');
const { User } = require('../users/models');

function isAdminRole(user) {
  const roleRaw = user?.role ?? user?.usertype ?? '';
  const role = String(roleRaw).toLowerCase();
  const allowedRoles = new Set(['super_admin', 'admin', 'bd_manager']);
  return allowedRoles.has(role);
}

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
      include: [{ model: Product, as: 'product', attributes: ['product_name', 'product_sku', 'incredients', 'how_to_use'] }],
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
 * Admin: Get all product customization requests across users
 */
const getAllCustomizations = async (req, res, next) => {
  try {
    if (!isAdminRole(req.user)) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: insufficient permissions'
      });
    }

    const customizations = await ProductCustomization.findAll({
      include: [
        {
          model: Product,
          as: 'product',
          attributes: ['product_name', 'product_sku']
        },
        {
          model: User,
          as: 'user',
          attributes: ['userid', 'fname', 'lname', 'email', 'mobile', 'usertype']
        }
      ],
      order: [['created_at', 'DESC']]
    });

    res.status(200).json({
      success: true,
      data: customizations
    });
  } catch (err) {
    console.error('Error fetching all customizations:', err);
    next(err);
  }
};

/**
 * Admin: update assignment / status / internal details for a product customization
 */
const updateCustomizationAdmin = async (req, res, next) => {
  try {
    if (!isAdminRole(req.user)) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: insufficient permissions'
      });
    }

    const { id } = req.params;
    const row = await ProductCustomization.findByPk(id);
    if (!row) {
      return res.status(404).json({
        success: false,
        message: 'Product customization not found'
      });
    }

    const body = req.body || {};
    const updates = {};

    if (body.status !== undefined) updates.status = body.status || 'Pending';
    if (body.internal_notes !== undefined || body.internalNotes !== undefined) {
      updates.internal_notes = body.internal_notes ?? body.internalNotes ?? null;
    }

    const hasAssignee =
      body.assigned_bd_user_id !== undefined ||
      body.assignedBdUserId !== undefined ||
      body.assigned_bd_name !== undefined ||
      body.assignedBdName !== undefined ||
      body.assigned_bd_email !== undefined ||
      body.assignedBdEmail !== undefined;

    if (hasAssignee) {
      updates.assigned_bd_user_id = body.assigned_bd_user_id ?? body.assignedBdUserId ?? null;
      updates.assigned_bd_name = body.assigned_bd_name ?? body.assignedBdName ?? null;
      updates.assigned_bd_email = body.assigned_bd_email ?? body.assignedBdEmail ?? null;
      updates.assigned_at = updates.assigned_bd_user_id || updates.assigned_bd_name || updates.assigned_bd_email
        ? new Date()
        : null;
    }

    updates.updated_at = new Date();
    await row.update(updates);
    await row.reload({
      include: [
        { model: Product, as: 'product', attributes: ['product_name', 'product_sku'] },
        { model: User, as: 'user', attributes: ['userid', 'fname', 'lname', 'email', 'mobile', 'usertype'] }
      ]
    });

    res.status(200).json({
      success: true,
      message: 'Product customization updated',
      data: row
    });
  } catch (err) {
    console.error('Error updating customization (admin):', err);
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
  getAllCustomizations,
  updateCustomizationAdmin,
  getCustomizationById,
  updateCustomization
};

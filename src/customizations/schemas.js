const Joi = require('joi');

const customizationSchema = Joi.object({
  product_id: Joi.number().integer().required(),
  formulation: Joi.string().allow('', null),
  packaging: Joi.string().allow('', null),
  product_category: Joi.string().allow('', null),
  sub_category: Joi.string().allow('', null),
  sub_sub_category: Joi.string().allow('', null),
  product_sku: Joi.string().allow('', null),
  product_description: Joi.string().allow('', null),
  application_area: Joi.string().allow('', null),
  skin_type: Joi.string().allow('', null),
  fragrance: Joi.string().allow('', null),
  color: Joi.string().allow('', null),
  ph_range: Joi.string().allow('', null),
  status: Joi.string().default('Pending'),
});

module.exports = {
  customizationSchema
};

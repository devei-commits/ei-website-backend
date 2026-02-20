const Joi = require('joi');

const newdevelopmentSchema = Joi.object({
  application_type: Joi.string().allow('', null),
  condition_type: Joi.string().allow('', null),
  fragrance_preference: Joi.string().allow('', null),
  ingredients_preference: Joi.string().allow('', null),
  ph_range: Joi.string().allow('', null),
  product_category: Joi.string().allow('', null),
  product_type: Joi.string().allow('', null),
  request_status: Joi.string().default('Pending'),
  specifications: Joi.array().items(Joi.string()).default([]),
  submitted_date: Joi.string().allow('', null),
  target_area: Joi.string().allow('', null)
});

module.exports = {
  newdevelopmentSchema
};

const Joi = require('joi');

const customizationSchema = Joi.object({
  product_id: Joi.number().integer().required(),
  category: Joi.string().allow('', null),
  formulation: Joi.object().pattern(Joi.string(), Joi.string()).allow(null),
  formulationSummary: Joi.string().allow('', null),
  care: Joi.string().allow('', null),
  packagingType: Joi.string().default('standard').allow('', null),
  packaging_image: Joi.string().allow('', null),
  userNotes: Joi.string().allow('', null),
  packaging: Joi.string().allow('', null),
  status: Joi.string().default('Pending'),
});

module.exports = {
  customizationSchema
};

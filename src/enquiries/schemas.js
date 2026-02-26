const Joi = require('joi');
const { ENQUIRY_TYPES } = require('./constants');

const enquirySchema = Joi.object({
  enquiry_type: Joi.string().valid(...ENQUIRY_TYPES).allow('', null),
  details: Joi.object().pattern(Joi.string(), Joi.any()).allow(null),
  status: Joi.string().allow('', null),
});

module.exports = {
  enquirySchema,
};

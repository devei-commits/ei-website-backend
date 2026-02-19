const Joi = require('joi');

const appointmentSchema = Joi.object({
  doctor_id: Joi.number().integer().required(),
  clinic_name: Joi.string().allow('', null),
  email: Joi.string().email().allow('', null),
  phone: Joi.string().allow('', null),
  address: Joi.string().allow('', null),
  city: Joi.string().allow('', null),
  state: Joi.string().allow('', null),
  pincode: Joi.string().allow('', null),
  reason: Joi.string().allow('', null),
  mode: Joi.string().allow('', null),
  status: Joi.string().default('pending'),
  lifecycle_status: Joi.string().default('active'),
  slot1_date: Joi.date().iso().allow(null),
  slot1_time: Joi.string().regex(/^([01]\d|2[0-3]):?([0-5]\d)$/).allow(null),
  slot2_date: Joi.date().iso().allow(null),
  slot2_time: Joi.string().regex(/^([01]\d|2[0-3]):?([0-5]\d)$/).allow(null)
});

module.exports = {
  appointmentSchema
};

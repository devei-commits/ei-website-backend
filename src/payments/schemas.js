const Joi = require('joi');

const createPaymentOrderSchema = Joi.object({
  orderId: Joi.number().integer().required(),
  amount: Joi.number().precision(2).min(0.01).required(),
  currency: Joi.string().default('INR'),
  receipt: Joi.string().optional(),
});

const verifyPaymentSchema = Joi.object({
  orderId: Joi.number().integer().required(),
  razorpayOrderId: Joi.string().required(),
  razorpayPaymentId: Joi.string().required(),
  razorpaySignature: Joi.string().required(),
  paymentMethod: Joi.string().optional(),
  paidAmount: Joi.number().precision(2).min(0.01).required(),
  currency: Joi.string().default('INR'),
});

module.exports = {
  createPaymentOrderSchema,
  verifyPaymentSchema,
};


const Joi = require('joi');

const orderSchema = Joi.object({
    shippingAddress: Joi.string()
        .min(3)
        .max(75)
        .required(),
    shippingCity: Joi.string()
        .min(2)
        .max(75)
        .required(),
    shippingState: Joi.string()
        .min(2)
        .max(75).required(),
    shippingZip: Joi.string().min(2)
        .max(30).required(),
    orderDate: Joi.date().default(Date.now),
    status: Joi.string().valid('pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded').default('pending'),
    orderType: Joi.string().valid('product', 'process').default('product'),
    customRequirements: Joi.string().when('orderType', {
        is: 'process',
        then: Joi.string().min(5).required(),
        otherwise: Joi.string().optional().allow(null, '')
    }),
    userId: Joi.number().integer().required(),
    orderItems: Joi.array().items(Joi.object({
        quantity: Joi.number().integer().min(1).required(),
        productId: Joi.number().integer().required(),
        price: Joi.number().precision(2).required()
    }))
        .min(1)
        .required()
});

const updateOrderSchema = Joi.object({
    shippingAddress: Joi.string()
        .min(3)
        .max(75),
    shippingCity: Joi.string()
        .min(2)
        .max(75),
    shippingState: Joi.string()
        .min(2)
        .max(75),
    shippingZip: Joi.string().min(2)
        .max(30),
    status: Joi.string().valid('pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'),
    orderType: Joi.string().valid('product', 'process'),
    customRequirements: Joi.string().min(5),
}).or('shippingAddress', 'shippingCity', 'shippingState', 'shippingZip', 'status', 'orderType', 'customRequirements').required();

module.exports = {
    orderSchema,
    updateOrderSchema
};
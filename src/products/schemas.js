const Joi = require('joi');

const productSchema = Joi.object({
    name: Joi.string()
        .min(3)
        .max(30)
        .required(),
    description: Joi.string()
        .min(3)
        .max(100)
        .required(),
    price: Joi.number()
        .precision(2).
        required(),
    categoryId: Joi.number().integer()
        .min(1)
        .required(),
    stock: Joi.number().integer()
        .min(1)
        .required(),
});

const productUpdateSchema = Joi.object({
    name: Joi.string().min(3).max(30),
    description: Joi.string().min(3).max(100),
    price: Joi.number().precision(2),
    categoryId: Joi.number().integer().min(1),
    stock: Joi.number().integer().min(1),
}).min(1);

const categoryValidValues = ['Electronics', 'Books', 'Clothing', 'Home & Kitchen', 'Beauty & Personal Care', 'Toys', 'Sports & Outdoors', 'Automotive', 'Health', 'Baby', 'Other'];

const categorySchema = Joi.object({
    name: Joi.string()
        .min(3)
        .max(30)
        .valid(...categoryValidValues)
        .required()
});

const categoryUpdateSchema = Joi.object({
    name: Joi.string()
        .min(3)
        .max(30)
        .valid(...categoryValidValues)
        .required()
});

module.exports = { productSchema, productUpdateSchema, categorySchema, categoryUpdateSchema };
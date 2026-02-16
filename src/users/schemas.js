const Joi = require('joi');

const loginSchema = Joi.object({
    email: Joi.string()
        .email({ minDomainSegments: 2, tlds: { allow: ['com', 'net'] } })
        .regex(/^[a-zA-Z][a-zA-Z0-9._]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/)
        .required()
        .messages({
            'string.pattern.base': 'Email must be a valid email address. for example: test@gmail.com'
        }),
    password: Joi.string()
        .min(6)
        .max(30)
        .regex(/^(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{6,30}$/) // At least one uppercase letter, one number, and one special character
        .required()
        .messages({
            'string.pattern.base': 'Password must be at least 6 characters long, contain one uppercase letter, one number, and one special character'
        })
});

const userSchema = Joi.object({
    name: Joi.string()
        .min(3)
        .max(30)
        .regex(/^[a-zA-Z ]*$/) // Only letters and spaces
        .required()
        .messages({
            'string.pattern.base': 'Name must only contain letters and spaces'
        }),
    email: Joi.string()
        .email({ minDomainSegments: 2, tlds: { allow: ['com', 'net'] } })
        .regex(/^[a-zA-Z][a-zA-Z0-9._]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/)
        .required()
        .messages({
            'string.pattern.base': 'Email must be a valid email address. for example: test@gmail.com'
        }),
    password: Joi.string()
        .min(6)
        .max(30)
        .regex(/^(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{6,30}$/) // At least one uppercase letter, one number, and one special character
        .required()
        .messages({
            'string.pattern.base': 'Password must be at least 6 characters long, contain one uppercase letter, one number, and one special character'
        }),
    gstNumber: Joi.string().optional(),
    billingAddress: Joi.string().optional(),
    shippingAddress: Joi.string().optional(),
    // paymentTerms is admin-approved; not accepted at registration time
});

module.exports = { loginSchema, userSchema };
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
});

const addressUpdateSchema = Joi.object({
    first_name: Joi.string().allow('', null),
    last_name: Joi.string().allow('', null),
    address_line1: Joi.string().allow('', null),
    address_line2: Joi.string().allow('', null),
    city: Joi.string().allow('', null),
    state: Joi.string().allow('', null),
    country: Joi.string().allow('', null),
    pincode: Joi.string().allow('', null),
    phone: Joi.string().allow('', null),
});

const clinicUpdateSchema = Joi.object({
    doctor_id: Joi.string().allow('', null),
    clinic_name: Joi.string().allow('', null),
    clinic_address: Joi.string().allow('', null),
    city: Joi.string().allow('', null),
    state: Joi.string().allow('', null),
    country: Joi.string().allow('', null),
    pincode: Joi.string().allow('', null),
});

const updateUserSchema = Joi.object({
    fname: Joi.string().allow('', null),
    lname: Joi.string().allow('', null),
    display_name: Joi.string().allow('', null),
    email: Joi.string().email().allow('', null),
    mobile: Joi.string().allow('', null),
    clinic_details: clinicUpdateSchema,
    shipping_address: addressUpdateSchema,
    billing_address: addressUpdateSchema,
});

module.exports = { loginSchema, userSchema, updateUserSchema };
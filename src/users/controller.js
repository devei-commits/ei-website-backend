const { User } = require('./models');
const bcrypt = require('bcrypt');
const { loginSchema, userSchema } = require('./schemas');
const { ValidationError, where } = require('sequelize');
const e = require('express');
const { generateToken, generateRefreshToken } = require('../middleware/security')

const createUser = async (req, res) => {
  const { error } = userSchema.validate(req.body, { abortEarly: false });
  if (error) {
    return res.status(400).json({ errors: error.details.map(e => e.message) });
  }
  const { name, email, password, gstNumber, billingAddress, shippingAddress } = req.body;
  try {
    const existing = await User.findOne({ where: { email: email } });
    if (existing) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    await User.create({
      name,
      email,
      password: bcrypt.hashSync(password, 10),
      gstNumber,
      billingAddress,
      shippingAddress,
      // paymentTerms is admin-approved; do not set from public registration
    });
    return res.status(201).json({ status: "Success", detials: "User created!" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const userLogin = async (req, res) => {
  const { error } = loginSchema.validate(req.body, { abortEarly: false });
  if (error) {
    return res.status(400).json({ errors: error.details.map(e => e.message) });
  }
  const { email, password } = req.body;
  const user = await User.findOne({ where: { email: email } });
  if (!user || !bcrypt.compare(password, user.password)) {
    res.status(404).json({ error: 'Invalid credentials!' });
  } else {
    const refreshToken = await generateRefreshToken(user);
    res.cookie('refreshToken', refreshToken, { httpOnly: true });
    res.status(200).json({ token: generateToken(user) });
  }
}

// Admin-only: update a user's payment terms
const updateUserPaymentTerms = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const { paymentTerms } = req.body;
    if (!paymentTerms || typeof paymentTerms !== 'string') {
      return res.status(400).json({ error: 'paymentTerms is required and must be a string' });
    }
    await user.update({ paymentTerms });
    res.status(200).json({ id: user.id, email: user.email, paymentTerms: user.paymentTerms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Current user's own profile (from token)
const getMe = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'name', 'email', 'gstNumber', 'billingAddress', 'shippingAddress', 'paymentTerms', 'role']
    });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.status(200).json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Admin-only: list all users
const getAllUsers = async (req, res) => {
  try {
    const users = await User.findAll({
      attributes: ['id', 'name', 'email', 'gstNumber', 'billingAddress', 'shippingAddress', 'paymentTerms', 'role']
    });
    res.status(200).json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { createUser, userLogin, updateUserPaymentTerms, getAllUsers, getMe };

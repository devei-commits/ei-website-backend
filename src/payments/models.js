const { DataTypes, Model } = require('sequelize');
const db = require('../../db');
const { Order } = require('../orders/models');
const { User } = require('../users/models');

class Payment extends Model {}

Payment.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  paymentId: {
    // Gateway payment id (e.g. Razorpay payment_id or cheque reference)
    type: DataTypes.STRING,
    allowNull: true,
  },
  razorpayOrderId: {
    // Razorpay order_id (when gateway === 'razorpay')
    type: DataTypes.STRING,
    allowNull: true,
  },
  gateway: {
    // Mirrors `gateway` in legacy schema: razorpay, cod, wallet, etc.
    type: DataTypes.ENUM('razorpay', 'cheque', 'cod', 'wallet'),
    allowNull: false,
  },
  gatewayReference: {
    // Generic external reference (e.g. Razorpay order id, cheque no)
    type: DataTypes.STRING,
    allowNull: true,
  },
  paidAmount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
  },
  remainingAmount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
  },
  currency: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'INR',
  },
  status: {
    // Mirrors payments.status in legacy schema
    type: DataTypes.ENUM('pending', 'completed', 'failed', 'refunded'),
    allowNull: false,
    defaultValue: 'pending',
  },
}, {
  sequelize: db,
  modelName: 'payment',
});

Payment.belongsTo(Order);
Order.hasMany(Payment, { as: 'payments' });

Payment.belongsTo(User);
User.hasMany(Payment);

module.exports = { Payment };


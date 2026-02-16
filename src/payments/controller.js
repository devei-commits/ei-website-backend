require('dotenv').config();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { Payment } = require('./models');
const { Order } = require('../orders/models');
const { createPaymentOrderSchema, verifyPaymentSchema } = require('./schemas');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const createPaymentOrder = async (req, res) => {
  try {
    const { error } = createPaymentOrderSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({ errors: error.details.map((e) => e.message) });
    }

    const { orderId, amount, currency, receipt } = req.body;
    const order = await Order.findByPk(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const options = {
      amount: Math.round(amount * 100), // Razorpay expects amount in paise
      currency,
      receipt: receipt || `order_rcpt_${orderId}`,
      notes: {
        orderId: String(orderId),
      },
    };

    const razorpayOrder = await razorpay.orders.create(options);

    const payment = await Payment.create({
      orderId: order.id,
      userId: order.userId,
      razorpayOrderId: razorpayOrder.id,
      gateway: 'razorpay',
      gatewayReference: razorpayOrder.id,
      paidAmount: 0,
      remainingAmount: amount,
      currency,
      status: 'pending',
    });

    return res.status(201).json({
      razorpayOrder,
      paymentId: payment.id,
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};

const verifyPayment = async (req, res) => {
  try {
    const { error } = verifyPaymentSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({ errors: error.details.map((e) => e.message) });
    }

    const {
      orderId,
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      paymentMethod,
      paidAmount,
      currency,
    } = req.body;

    const payment = await Payment.findOne({ where: { razorpayOrderId, orderId } });
    if (!payment) {
      return res.status(404).json({ error: 'Payment record not found' });
    }

    const body = `${razorpayOrderId}|${razorpayPaymentId}`;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    if (expectedSignature !== razorpaySignature) {
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    await payment.update({
      paymentId: razorpayPaymentId,
      gateway: 'razorpay',
      gatewayReference: razorpayPaymentId,
      paidAmount,
      remainingAmount: payment.remainingAmount - paidAmount,
      currency,
      status: 'completed',
    });

    // Optionally, update related order paymentStatus when fully paid
    const order = await Order.findByPk(orderId);
    if (order && Number(payment.remainingAmount) <= 0 && order.paymentStatus === 'pending') {
      await order.update({ paymentStatus: 'paid' });
    }

    return res.status(200).json({ message: 'Payment verified', payment });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};

module.exports = {
  createPaymentOrder,
  verifyPayment,
};


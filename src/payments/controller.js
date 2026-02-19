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

    // Enforce payment terms: if advance is required, amount must match
    const gstpercent =  (Number(order.advance_amount_due.split('.')[0])*18)/100
    const advanceDue = Number(order.advance_amount_due + gstpercent.toFixed(2));
   
    if (advanceDue > 0) {
      const requestedAmount = Number(amount);
      if (Math.abs(requestedAmount - advanceDue) > 0.01) {
        return res.status(400).json({
          error: `Payment terms require an advance of ₹${advanceDue}. Requested amount ₹${requestedAmount} does not match.`,
          advance_amount_due: advanceDue,
        });
      }
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
      orderOrderId: order.order_id,
      UserUserid: req.user.id,
      razorpayOrderId: razorpayOrder.id,
      gateway: 'razorpay',
      gatewayReference: razorpayOrder.id,
      paidAmount: 0,
      remainingAmount: amount,
      currency: currency || 'INR',
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

    const payment = await Payment.findOne({ where: { razorpayOrderId, orderOrderId: orderId } });
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

    const previousRemaining = Number(payment.remainingAmount);
    await payment.update({
      paymentId: razorpayPaymentId,
      gateway: 'razorpay',
      gatewayReference: razorpayPaymentId,
      paidAmount,
      remainingAmount: Math.max(0, previousRemaining - Number(paidAmount)),
      currency,
      status: 'completed',
    });

    const order = await Order.findByPk(orderId);
    if (order) {
      if (Number(paidAmount) >= previousRemaining && order.payment_status === 'pending') {
        await order.update({ payment_status: 'paid' });
      }
      // When payment terms dictate a balance due on delivery, log it as a COD record
      const grandTotal = Number(order.grand_total);
      const balanceDue = grandTotal - Number(paidAmount);
      if (balanceDue > 0) {
        await Payment.create({
          orderOrderId: order.order_id,
          UserUserid: order.user_id,
          gateway: 'cod',
          gatewayReference: `balance_after_razorpay_${razorpayPaymentId}`,
          paidAmount: 0,
          remainingAmount: balanceDue,
          currency: currency || 'INR',
          status: 'pending',
        });
      }
    }

    return res.status(200).json({ message: 'Payment verified', payment });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};

// Admin-only: confirm cheque payment after manual verification; updates order and payment record
const approveChequePayment = async (req, res) => {
  try {
    const orderId = Number(req.body?.orderId);
    if (!orderId && orderId !== 0) {
      return res.status(400).json({ error: 'orderId is required' });
    }

    const order = await Order.findByPk(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.payment_status === 'paid') {
      return res.status(400).json({ error: 'Order is already marked as paid' });
    }

    const grandTotal = Number(order.grand_total);

    // Create or update cheque payment record for audit trail
    let payment = await Payment.findOne({
      where: { orderOrderId: orderId, gateway: 'cheque' },
    });
    if (payment) {
      await payment.update({
        paidAmount: grandTotal,
        remainingAmount: 0,
        status: 'completed',
        gatewayReference: payment.gatewayReference || `approved_${Date.now()}`,
      });
    } else {
      payment = await Payment.create({
        orderOrderId: order.order_id,
        UserUserid: order.user_id,
        gateway: 'cheque',
        gatewayReference: `approved_${Date.now()}`,
        paidAmount: grandTotal,
        remainingAmount: 0,
        currency: 'INR',
        status: 'completed',
      });
    }

    await order.update({ payment_status: 'paid' });

    return res.status(200).json({
      message: 'Cheque payment approved',
      order: { order_id: orderId, payment_status: 'paid' },
      payment: { id: payment.id, gateway: payment.gateway, status: payment.status },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};

module.exports = {
  createPaymentOrder,
  verifyPayment,
  approveChequePayment,
};


const crypto = require('crypto');

const razorpayOrderId  = 'order_SI0oE2Ns6cYWt3';  // from your response
const razorpayPaymentId = 'pay_TEST123456789';       // fake test payment id
const keySecret = '5eQSw2656z2RFse8eREEK3Rt';        // from your .env

const sig = crypto
  .createHmac('sha256', keySecret)
  .update(`${razorpayOrderId}|${razorpayPaymentId}`)
  .digest('hex');

console.log(sig);

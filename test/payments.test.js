const request = require('supertest');
const app = require('../app');
const db = require('../db');
const { User } = require('../src/users/models');
const { Product } = require('../src/products/models');
const { Order } = require('../src/orders/models');
const { Payment } = require('../src/payments/models');
const { Address } = require('../src/models/Addresses');
const crypto = require('crypto');

describe('Payment Flow', () => {
  let user;
  let product;
  let address;
  let order;
  let token;

  beforeAll(async () => {
    await db.sync({ force: true });

    user = await User.create({
      fname: 'test',
      lname: 'user',
      email: 'test@example.com',
      password: 'password',
      usertype: 'customer',
    });

    token = user.generateToken();

    product = await Product.create({
      product_id: 1,
      name: 'Test Product',
      price: 100,
      description: 'A product for testing',
      stock: 10,
    });

    address = await Address.create({
      user_id: user.userid,
      address_line1: '123 Test St',
      city: 'Testville',
      state: 'Testland',
      postal_code: '12345',
      country: 'Testonia',
    });
  });

  afterAll(async () => {
    await db.close();
  });

  test('should create an order, create a payment, and verify it', async () => {
    // 1. Create an order
    const orderData = {
      billing_address_id: address.address_id,
      shipping_address_id: address.address_id,
      order_items: [
        {
          product_id: product.product_id,
          quantity: 1,
          unit_price: 100,
          tax_amount: 10,
        },
      ],
      shipping_total: 20,
      discount_total: 5,
    };

    const orderRes = await request(app)
      .post('/orders/save')
      .send(orderData)
      .set('Authorization', `Bearer ${token}`);

    expect(orderRes.statusCode).toEqual(201);
    order = orderRes.body;
    expect(order.payment_status).toEqual('pending');
    expect(order.grand_total).toEqual('125.00');

    // 2. Create a payment order
    const paymentOrderData = {
      orderId: order.order_id,
      amount: order.grand_total,
      currency: 'INR',
    };

    const paymentOrderRes = await request(app)
      .post('/payments/create')
      .send(paymentOrderData);

    expect(paymentOrderRes.statusCode).toEqual(201);
    const { razorpayOrder, paymentId } = paymentOrderRes.body;
    expect(razorpayOrder).toBeDefined();
    expect(paymentId).toBeDefined();

    // 3. Verify the payment
    const razorpayPaymentId = 'pay_mock_payment_id';
    const razorpaySignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrder.id}|${razorpayPaymentId}`)
      .digest('hex');

    const verificationData = {
      orderId: order.order_id,
      razorpayOrderId: razorpayOrder.id,
      razorpayPaymentId,
      razorpaySignature,
      paidAmount: order.grand_total,
      currency: 'INR',
    };

    const verifyRes = await request(app)
      .post('/payments/verify')
      .send(verificationData);

    expect(verifyRes.statusCode).toEqual(200);
    expect(verifyRes.body.message).toEqual('Payment verified');

    const updatedOrder = await Order.findByPk(order.order_id);
    expect(updatedOrder.payment_status).toEqual('paid');

    const payment = await Payment.findByPk(paymentId);
    expect(payment.status).toEqual('completed');
    expect(payment.paidAmount).toEqual(order.grand_total);
    expect(payment.remainingAmount).toEqual('0.00');
  });

  test('should handle partial payment and create a COD payment for the balance', async () => {
    // 1. Create another order
    const orderData = {
        billing_address_id: address.address_id,
        shipping_address_id: address.address_id,
        order_items: [
          {
            product_id: product.product_id,
            quantity: 2,
            unit_price: 100,
            tax_amount: 20,
          },
        ],
        shipping_total: 20,
        discount_total: 10,
      };
  
      const orderRes = await request(app)
        .post('/orders/save')
        .send(orderData)
        .set('Authorization', `Bearer ${token}`);
  
      expect(orderRes.statusCode).toEqual(201);
      order = orderRes.body;
      expect(order.payment_status).toEqual('pending');
      expect(order.grand_total).toEqual('230.00');
  
      // 2. Create a payment order for a partial amount
      const partialAmount = 100;
      const paymentOrderData = {
        orderId: order.order_id,
        amount: order.grand_total, // The initial razorpay order is for the full amount
        currency: 'INR',
      };
  
      const paymentOrderRes = await request(app)
        .post('/payments/create')
        .send(paymentOrderData);
  
      expect(paymentOrderRes.statusCode).toEqual(201);
      const { razorpayOrder, paymentId } = paymentOrderRes.body;
  
      // 3. Verify the partial payment
      const razorpayPaymentId = 'pay_mock_partial_payment_id';
      const razorpaySignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(`${razorpayOrder.id}|${razorpayPaymentId}`)
        .digest('hex');
  
      const verificationData = {
        orderId: order.order_id,
        razorpayOrderId: razorpayOrder.id,
        razorpayPaymentId,
        razorpaySignature,
        paidAmount: partialAmount,
        currency: 'INR',
      };
  
      const verifyRes = await request(app)
        .post('/payments/verify')
        .send(verificationData);
  
      expect(verifyRes.statusCode).toEqual(200);
  
      const updatedOrder = await Order.findByPk(order.order_id);
      expect(updatedOrder.payment_status).toEqual('pending'); // Still pending as it's a partial payment
  
      const payments = await Payment.findAll({ where: { orderOrderId: order.order_id } });
      expect(payments.length).toEqual(2);
  
      const razorpayPayment = payments.find(p => p.gateway === 'razorpay');
      expect(razorpayPayment.status).toEqual('completed');
      expect(razorpayPayment.paidAmount).toEqual('100.00');
  
      const codPayment = payments.find(p => p.gateway === 'cod');
      expect(codPayment).toBeDefined();
      expect(codPayment.status).toEqual('pending');
      expect(codPayment.remainingAmount).toEqual('130.00');
  });

  // ─── Payment Terms Tests ──────────────────────────────────────────────────

  test('product-level advance_percentage sets advance_amount_due on order', async () => {
    // Product with 50% advance required
    const advProduct = await Product.create({
      product_name: 'Advance Product',
      advance_percentage: 50,
    });

    const orderData = {
      billing_address_id: address.address_id,
      shipping_address_id: address.address_id,
      order_items: [
        {
          product_id: advProduct.product_id,
          quantity: 2,
          unit_price: 200,
          tax_amount: 0,
        },
      ],
      shipping_total: 0,
      discount_total: 0,
    };

    const orderRes = await request(app)
      .post('/orders/save')
      .send(orderData)
      .set('Authorization', `Bearer ${token}`);

    expect(orderRes.statusCode).toEqual(201);
    // subtotal = 400, 50% advance = 200
    expect(parseFloat(orderRes.body.advance_amount_due)).toEqual(200);
  });

  test('user-level terms apply when product has no advance_percentage', async () => {
    // User with advance_payment = true, advance_amount = 150
    await user.update({ advance_payment: true, advance_amount: 150 });

    const plainProduct = await Product.create({
      product_name: 'Plain Product',
      advance_percentage: null,
    });

    const orderData = {
      billing_address_id: address.address_id,
      shipping_address_id: address.address_id,
      order_items: [
        {
          product_id: plainProduct.product_id,
          quantity: 1,
          unit_price: 500,
          tax_amount: 0,
        },
      ],
      shipping_total: 0,
      discount_total: 0,
    };

    const orderRes = await request(app)
      .post('/orders/save')
      .send(orderData)
      .set('Authorization', `Bearer ${token}`);

    expect(orderRes.statusCode).toEqual(201);
    expect(parseFloat(orderRes.body.advance_amount_due)).toEqual(150);

    // Reset user terms
    await user.update({ advance_payment: false, advance_amount: null });
  });

  test('product terms override user payment terms', async () => {
    // User has large advance_amount, but product dictates 25%
    await user.update({ advance_payment: true, advance_amount: 9999 });

    const pctProduct = await Product.create({
      product_name: 'Percent Product',
      advance_percentage: 25,
    });

    const orderData = {
      billing_address_id: address.address_id,
      shipping_address_id: address.address_id,
      order_items: [
        {
          product_id: pctProduct.product_id,
          quantity: 1,
          unit_price: 400,
          tax_amount: 0,
        },
      ],
      shipping_total: 0,
      discount_total: 0,
    };

    const orderRes = await request(app)
      .post('/orders/save')
      .send(orderData)
      .set('Authorization', `Bearer ${token}`);

    expect(orderRes.statusCode).toEqual(201);
    // 25% of 400 = 100, NOT 9999
    expect(parseFloat(orderRes.body.advance_amount_due)).toEqual(100);

    await user.update({ advance_payment: false, advance_amount: null });
  });

  test('POST /payments/create rejects amount that does not match advance_amount_due', async () => {
    const advProd = await Product.create({
      product_name: 'Adv Guard Product',
      advance_percentage: 50,
    });

    const orderRes = await request(app)
      .post('/orders/save')
      .send({
        billing_address_id: address.address_id,
        shipping_address_id: address.address_id,
        order_items: [{ product_id: advProd.product_id, quantity: 1, unit_price: 300, tax_amount: 0 }],
        shipping_total: 0,
        discount_total: 0,
      })
      .set('Authorization', `Bearer ${token}`);

    expect(orderRes.statusCode).toEqual(201);
    const advOrder = orderRes.body;
    // advance_amount_due = 150 (50% of 300)

    // Attempt to pay the full grand_total instead of the advance
    const badPaymentRes = await request(app)
      .post('/payments/create')
      .send({ orderId: advOrder.order_id, amount: 300, currency: 'INR' })
      .set('Authorization', `Bearer ${token}`);

    expect(badPaymentRes.statusCode).toEqual(400);
    expect(badPaymentRes.body.advance_amount_due).toEqual(150);
  });

  // ─────────────────────────────────────────────────────────────────────────

  test('should approve a cheque payment', async () => {
    // 1. Create an order
    const orderData = {
      billing_address_id: address.address_id,
      shipping_address_id: address.address_id,
      order_items: [
        {
          product_id: product.product_id,
          quantity: 1,
          unit_price: 50,
        },
      ],
    };

    const orderRes = await request(app)
      .post('/orders/save')
      .send(orderData)
      .set('Authorization', `Bearer ${token}`);

    expect(orderRes.statusCode).toEqual(201);
    order = orderRes.body;
    expect(order.payment_status).toEqual('pending');

    // 2. Approve cheque payment (as an admin)
    const adminUser = await User.create({
        fname: 'admin',
        lname: 'user',
        email: 'admin@example.com',
        password: 'password',
        usertype: 'admin',
      });
    const adminToken = adminUser.generateToken();

    const approveRes = await request(app)
      .post(`/payments/approve-cheque`)
      .send({ orderId: order.order_id})
      .set('Authorization', `Bearer ${adminToken}`);

    expect(approveRes.statusCode).toEqual(200);
    expect(approveRes.body.message).toEqual('Cheque payment approved');

    const updatedOrder = await Order.findByPk(order.order_id);
    expect(updatedOrder.payment_status).toEqual('paid');

    const payment = await Payment.findOne({ where: { orderOrderId: order.order_id, gateway: 'cheque' } });
    expect(payment).toBeDefined();
    expect(payment.status).toEqual('completed');
  });
});

require('dotenv').config();
const db = require('./db');
const { User } = require('./src/users/models');
const { Product, Category } = require('./src/products/models');
const { Order, OrderItem, OrderStatusHistory } = require('./src/orders/models');
const { Payment } = require('./src/payments/models');
const bcrypt = require('bcrypt');

async function seed() {
  try {
    console.log('Syncing database...');
    await db.sync({ alter: true });

    console.log('Seeding users...');
    const superAdmin = await User.create({
      name: 'Super Admin',
      email: 'superadmin@example.com',
      password: bcrypt.hashSync('SuperAdmin@123', 10),
      gstNumber: '11AAAAA0000A1Z5',
      billingAddress: 'Super Admin Billing Address, City, State, 111111',
      shippingAddress: 'Super Admin Shipping Address, City, State, 111111',
      paymentTerms: '100% advance',
      role: 'super_admin',
    });

    const admin = await User.create({
      name: 'Admin User',
      email: 'admin@example.com',
      password: bcrypt.hashSync('Admin@123', 10),
      gstNumber: '22AAAAA0000A1Z5',
      billingAddress: 'Admin Billing Address, City, State, 123456',
      shippingAddress: 'Admin Shipping Address, City, State, 123456',
      paymentTerms: '100% advance',
      role: 'admin',
    });

    const bdManager = await User.create({
      name: 'BD Manager',
      email: 'bdmanager@example.com',
      password: bcrypt.hashSync('BDManager@123', 10),
      gstNumber: '33AAAAA0000A1Z5',
      billingAddress: 'BD Manager Billing Address, City, State, 333333',
      shippingAddress: 'BD Manager Shipping Address, City, State, 333333',
      paymentTerms: 'Net 30 days',
      role: 'bd_manager',
    });

    const client1 = await User.create({
      name: 'Client One',
      email: 'client1@example.com',
      password: bcrypt.hashSync('Client1@123', 10),
      gstNumber: '27BBBBB1111B2Z6',
      billingAddress: 'Client1 Billing, Mumbai, MH, 400001',
      shippingAddress: 'Client1 Shipping, Mumbai, MH, 400002',
      paymentTerms: '50% advance / 50% on delivery',
      role: 'customer',
    });

    const client2 = await User.create({
      name: 'Client Two',
      email: 'client2@example.com',
      password: bcrypt.hashSync('Client2@123', 10),
      gstNumber: '29CCCCC2222C3Z7',
      billingAddress: 'Client2 Billing, Bengaluru, KA, 560001',
      shippingAddress: 'Client2 Shipping, Bengaluru, KA, 560002',
      paymentTerms: 'Net 30 days',
      role: 'customer',
    });

    console.log('Seeding categories and products...');
    const catChem = await Category.create({ name: 'Chemicals' });
    const catServices = await Category.create({ name: 'Custom Processes' });

    const productA = await Product.create({
      name: 'Product A',
      description: 'Standard product with full advance payment.',
      price: 1000.0,
      stock: 100,
      categoryId: catChem.id,
    });

    const productB = await Product.create({
      name: 'Product B',
      description: 'Bulk product, shipped via logistics partner.',
      price: 5000.0,
      stock: 50,
      categoryId: catChem.id,
    });

    const processCustom = await Product.create({
      name: 'Custom Process X',
      description: 'Customized processing service (process order).',
      price: 20000.0,
      stock: 9999,
      categoryId: catServices.id,
    });

    console.log('Seeding orders (product and process)...');
    // Product order: full advance, fully paid
    const orderProduct = await Order.create(
      {
        userId: client1.id,
        shippingAddress: client1.shippingAddress,
        shippingCity: 'Mumbai',
        shippingState: 'MH',
        shippingZip: '400002',
        total: 1000.0,
        status: 'shipped',
        paymentStatus: 'paid',
        orderType: 'product',
        customRequirements: null,
        rdStatus: null,
        rdNotes: null,
        orderItems: [
          {
            productId: productA.id,
            quantity: 1,
            price: 1000.0,
          },
        ],
      },
      { include: 'orderItems' }
    );

    await OrderStatusHistory.bulkCreate([
      {
        orderId: orderProduct.id,
        status: 'pending',
        step: 'CREATED',
        note: 'Product order created, awaiting payment.',
      },
      {
        orderId: orderProduct.id,
        status: 'paid',
        step: 'INVOICED',
        note: 'Invoice generated and payment received.',
      },
      {
        orderId: orderProduct.id,
        status: 'shipped',
        step: 'SHIPPED',
        note: 'Shipped via Shiprocket.',
      },
    ]);

    // Process order: based on payment terms with customization + R&D workflow
    const orderProcess = await Order.create(
      {
        userId: client2.id,
        shippingAddress: client2.shippingAddress,
        shippingCity: 'Bengaluru',
        shippingState: 'KA',
        shippingZip: '560002',
        total: 20000.0,
        status: 'processing',
        paymentStatus: 'pending',
        orderType: 'process',
        customRequirements:
          'Customize Product X with fragrance-free base, sensitive-skin compliant ingredients, and matte finish.',
        rdStatus: 'under_review',
        rdNotes: 'Initial requirements received; R&D evaluating feasibility and stability.',
        orderItems: [
          {
            productId: processCustom.id,
            quantity: 1,
            price: 20000.0,
          },
        ],
      },
      { include: 'orderItems' }
    );

    await OrderStatusHistory.bulkCreate([
      {
        orderId: orderProcess.id,
        status: 'pending',
        step: 'PI',
        note: 'Purchase Indent raised.',
      },
      {
        orderId: orderProcess.id,
        status: 'pending',
        step: 'PO',
        note: 'Purchase Order created.',
      },
      {
        orderId: orderProcess.id,
        status: 'pending',
        step: 'SO',
        note: 'Sales Order generated.',
      },
      {
        orderId: orderProcess.id,
        status: 'processing',
        step: 'MANUFACTURING',
        note: 'Manufacturing in progress.',
      },
      {
        orderId: orderProcess.id,
        status: 'processing',
        step: 'GR',
        note: 'Goods Receipt recorded internally.',
      },
    ]);

    console.log('Seeding payments (Razorpay confirmed/denied, cheque)...');
    // Mock Razorpay confirmed payment
    await Payment.create({
      orderId: orderProduct.id,
      userId: client1.id,
      paymentId: 'pay_mock_confirmed_123',
      razorpayOrderId: 'order_mock_123',
      gateway: 'razorpay',
      gatewayReference: 'order_mock_123',
      paidAmount: 1000.0,
      remainingAmount: 0.0,
      currency: 'INR',
      status: 'completed',
    });

    // Mock Razorpay denied/failed payment
    await Payment.create({
      orderId: orderProduct.id,
      userId: client1.id,
      paymentId: 'pay_mock_failed_456',
      razorpayOrderId: 'order_mock_456',
      gateway: 'razorpay',
      gatewayReference: 'order_mock_456',
      paidAmount: 0.0,
      remainingAmount: 1000.0,
      currency: 'INR',
      status: 'failed',
    });

    // Mock cheque payment pending verification
    await Payment.create({
      orderId: orderProcess.id,
      userId: client2.id,
      paymentId: 'cheque_789',
      razorpayOrderId: null,
      gateway: 'cheque',
      gatewayReference: 'cheque_789',
      paidAmount: 10000.0,
      remainingAmount: 10000.0,
      currency: 'INR',
      status: 'pending',
    });

    console.log('Seeding complete.');
    process.exit(0);
  } catch (err) {
    console.error('Seeding failed:', err);
    process.exit(1);
  }
}

seed();


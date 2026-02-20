require('dotenv').config();
const db = require('./db');
const { User, RefreshToken, DoctorProfile } = require('./src/users/models');
const { Product } = require('./src/products/models');
const { Order, OrderItem } = require('./src/orders/models');
const { Payment } = require('./src/payments/models');
const Address = require('./src/models/Addresses');
const Appointment = require('./src/appointments/models');
const Newdevelopment = require('./src/newdevelopments/models');
const ProductCustomization = require('./src/customizations/models');
const bcrypt = require('bcrypt');

async function seed() {
  try {
    console.log('Syncing database...');
    await db.sync({ alter: true });

    console.log('Clearing existing seed data...');
    await ProductCustomization.destroy({ where: {} });
    await Newdevelopment.destroy({ where: {} });
    await Appointment.destroy({ where: {} });
    await Payment.destroy({ where: {} });
    await OrderItem.destroy({ where: {} });
    await Order.destroy({ where: {} });
    await Address.destroy({ where: {} });
    await Product.destroy({ where: {} });
    await RefreshToken.destroy({ where: {} });
    await DoctorProfile.destroy({ where: {} });
    await User.destroy({ where: {} });

    console.log('Seeding users...');
    const superAdmin = await User.create({
      fname: 'Super',
      lname: 'Admin',
      display_name: 'Super Admin',
      email: 'superadmin@example.com',
      mobile: '+919876543201',
      password: bcrypt.hashSync('SuperAdmin@123', 10),
      usertype: 'super_admin',
      advance_payment: true,
      advance_amount: 100,
    });

    const admin = await User.create({
      fname: 'Admin',
      lname: 'User',
      display_name: 'Admin User',
      email: 'admin@example.com',
      mobile: '+919876543202',
      password: bcrypt.hashSync('Admin@123', 10),
      usertype: 'admin',
      advance_payment: true,
      advance_amount: 100,
    });

    const bdManager = await User.create({
      fname: 'BD',
      lname: 'Manager',
      display_name: 'BD Manager',
      email: 'bdmanager@example.com',
      mobile: '+919876543203',
      password: bcrypt.hashSync('BDManager@123', 10),
      usertype: 'bd_manager',
      advance_payment: true,
      advance_amount: 50,
    });

    const client1 = await User.create({
      fname: 'Client',
      lname: 'One',
      display_name: 'Client One',
      email: 'client1@example.com',
      mobile: '+919876543211',
      password: bcrypt.hashSync('Client1@123', 10),
      usertype: 'customer',
      advance_payment: true,
      advance_amount: 50,
    });

    const client2 = await User.create({
      fname: 'Client',
      lname: 'Two',
      display_name: 'Client Two',
      email: 'client2@example.com',
      mobile: '+919876543212',
      password: bcrypt.hashSync('Client2@123', 10),
      usertype: 'customer',
      advance_payment: false,
      advance_amount: 0,
    });

    console.log('Seeding addresses...');
    const superAdminBilling = await Address.create({
      user_id: superAdmin.userid,
      address_type: 'billing',
      is_default_billing: true,
      first_name: 'Super',
      last_name: 'Admin',
      address_line1: 'Super Admin Billing Address, City, State, 111111',
      city_text: 'City',
      state_text: 'State',
      country_text: 'India',
      pincode: '111111',
    });
    const superAdminShipping = await Address.create({
      user_id: superAdmin.userid,
      address_type: 'shipping',
      is_default_shipping: true,
      first_name: 'Super',
      last_name: 'Admin',
      address_line1: 'Super Admin Shipping Address, City, State, 111111',
      city_text: 'City',
      state_text: 'State',
      country_text: 'India',
      pincode: '111111',
    });

    const adminBilling = await Address.create({
      user_id: admin.userid,
      address_type: 'billing',
      is_default_billing: true,
      first_name: 'Admin',
      last_name: 'User',
      address_line1: 'Admin Billing Address, City, State, 123456',
      city_text: 'City',
      state_text: 'State',
      country_text: 'India',
      pincode: '123456',
    });
    const adminShipping = await Address.create({
      user_id: admin.userid,
      address_type: 'shipping',
      is_default_shipping: true,
      first_name: 'Admin',
      last_name: 'User',
      address_line1: 'Admin Shipping Address, City, State, 123456',
      city_text: 'City',
      state_text: 'State',
      country_text: 'India',
      pincode: '123456',
    });

    const client1Billing = await Address.create({
      user_id: client1.userid,
      address_type: 'billing',
      is_default_billing: true,
      first_name: 'Client',
      last_name: 'One',
      address_line1: 'Client1 Billing, Mumbai, MH, 400001',
      city_text: 'Mumbai',
      state_text: 'MH',
      country_text: 'India',
      pincode: '400001',
    });
    const client1Shipping = await Address.create({
      user_id: client1.userid,
      address_type: 'shipping',
      is_default_shipping: true,
      first_name: 'Client',
      last_name: 'One',
      address_line1: 'Client1 Shipping, Mumbai, MH, 400002',
      city_text: 'Mumbai',
      state_text: 'MH',
      country_text: 'India',
      pincode: '400002',
    });

    const client2Billing = await Address.create({
      user_id: client2.userid,
      address_type: 'billing',
      is_default_billing: true,
      first_name: 'Client',
      last_name: 'Two',
      address_line1: 'Client2 Billing, Bengaluru, KA, 560001',
      city_text: 'Bengaluru',
      state_text: 'KA',
      country_text: 'India',
      pincode: '560001',
    });
    const client2Shipping = await Address.create({
      user_id: client2.userid,
      address_type: 'shipping',
      is_default_shipping: true,
      first_name: 'Client',
      last_name: 'Two',
      address_line1: 'Client2 Shipping, Bengaluru, KA, 560002',
      city_text: 'Bengaluru',
      state_text: 'KA',
      country_text: 'India',
      pincode: '560002',
    });

    console.log('Seeding categories and products...');
    const productA = await Product.create({
      product_name: 'Product A',
      product_description: 'Standard product with full advance payment.',
      mrp_price: 1000.0,
      buy_price: 900.0,
      category: 'Chemicals',
    });

    const productB = await Product.create({
      product_name: 'Product B',
      product_description: 'Bulk product, shipped via logistics partner.',
      mrp_price: 5000.0,
      buy_price: 4500.0,
      category: 'Chemicals',
    });

    const processCustom = await Product.create({
      product_name: 'Custom Process X',
      product_description: 'Customized processing service (process order).',
      mrp_price: 20000.0,
      buy_price: 18000.0,
      category: 'Custom Processes',
    });

    console.log('Seeding orders (product and process)...');
    const orderProduct = await Order.create({
      user_id: client1.userid,
      billing_address_id: client1Billing.address_id,
      shipping_address_id: client1Shipping.address_id,
      order_status: 'shipped',
      payment_status: 'paid',
      subtotal: 1000.0,
      discount_total: 0,
      tax_total: 0,
      shipping_total: 0,
      grand_total: 1000.0,
    });

    await OrderItem.create({
      order_id: orderProduct.order_id,
      product_id: productA.product_id,
      quantity: 1,
      unit_price: 1000.0,
      discount_amount: 0,
      tax_amount: 0,
      line_total: 1000.0,
    });

    const orderProcess = await Order.create({
      user_id: client2.userid,
      billing_address_id: client2Billing.address_id,
      shipping_address_id: client2Shipping.address_id,
      order_status: 'processing',
      payment_status: 'pending',
      subtotal: 20000.0,
      discount_total: 0,
      tax_total: 0,
      shipping_total: 0,
      grand_total: 20000.0,
    });

    await OrderItem.create({
      order_id: orderProcess.order_id,
      product_id: processCustom.product_id,
      quantity: 1,
      unit_price: 20000.0,
      discount_amount: 0,
      tax_amount: 0,
      line_total: 20000.0,
    });

    console.log('Seeding payments (Razorpay confirmed/denied, cheque)...');
    await Payment.create({
      orderOrderId: orderProduct.order_id,
      UserUserid: client1.userid,
      paymentId: 'pay_mock_confirmed_123',
      razorpayOrderId: 'order_mock_123',
      gateway: 'razorpay',
      gatewayReference: 'order_mock_123',
      paidAmount: 1000.0,
      remainingAmount: 0.0,
      currency: 'INR',
      status: 'completed',
    });

    await Payment.create({
      orderOrderId: orderProduct.order_id,
      UserUserid: client1.userid,
      paymentId: 'pay_mock_failed_456',
      razorpayOrderId: 'order_mock_456',
      gateway: 'razorpay',
      gatewayReference: 'order_mock_456',
      paidAmount: 0.0,
      remainingAmount: 1000.0,
      currency: 'INR',
      status: 'failed',
    });

    await Payment.create({
      orderOrderId: orderProcess.order_id,
      UserUserid: client2.userid,
      paymentId: 'cheque_789',
      razorpayOrderId: null,
      gateway: 'cheque',
      gatewayReference: 'cheque_789',
      paidAmount: 10000.0,
      remainingAmount: 10000.0,
      currency: 'INR',
      status: 'pending',
    });

    console.log('Seeding Appointments...');
    await Appointment.create({
      user_id: client1.userid,
      doctor_id: superAdmin.userid,
      clinic_name: 'Main Clinic',
      email: client1.email,
      phone: client1.mobile,
      address: '123 Client St',
      city: 'Mumbai',
      state: 'MH',
      pincode: '400001',
      reason: 'General consultation',
      mode: 'online',
      status: 'pending',
      lifecycle_status: 'active',
      slot1_date: '2026-03-01',
      slot1_time: '10:00',
      created_at: new Date(),
      updated_at: new Date()
    });

    console.log('Seeding New Developments...');
    await Newdevelopment.create({
      user_id: client1.userid,
      application_type: 'Skin Care',
      condition_type: 'Dry Skin',
      fragrance_preference: 'Lavender',
      ingredients_preference: 'Organic',
      ph_range: '5.5',
      product_category: 'Face Care',
      product_type: 'Cream',
      request_status: 'Pending',
      specifications: ['Sulphate Free', 'Paraben Free'],
      submitted_date: '20 Feb 2026',
      target_area: 'Face',
      created_at: new Date(),
      updated_at: new Date()
    });

    console.log('Seeding Product Customizations...');
    await ProductCustomization.create({
      product_id: productA.product_id,
      user_id: client1.userid,
      formulation: 'Customized Oil-based',
      packaging: 'Glass Bottle 50ml',
      product_category: 'Face Care',
      sub_category: 'Oil',
      sub_sub_category: 'Anti-aging',
      product_sku: 'PA-CUSTOM-001',
      product_description: 'Custom formulation for client 1',
      application_area: 'Face',
      skin_type: 'Combination',
      fragrance: 'Sandalwood',
      color: 'Clear',
      ph_range: '6.0',
      status: 'Pending',
      life_cycle_status: 'active',
      created_at: new Date(),
      updated_at: new Date()
    });

    console.log('Seeding complete.');
    process.exit(0);
  } catch (err) {
    console.error('Seeding failed:', err);
    process.exit(1);
  }
}

seed();

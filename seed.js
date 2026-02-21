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
    // Delete in order of dependency to avoid foreign key constraints
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

    const now = new Date();

    console.log('Seeding users...');
    
    // 1. Super Admin
    const superAdmin = await User.create({
      fname: 'Super',
      lname: 'Admin',
      display_name: 'Super Admin',
      email: 'superadmin@example.com',
      mobile: '+919876543201',
      password: bcrypt.hashSync('SuperAdmin@123', 10),
      usertype: 'super_admin',
      status: 'active',
      verify_status: 'verified',
      advance_payment: true,
      advance_amount: 100,
      created_at: now,
      updated_at: now
    });

    // 2. Admin (also acts as a doctor in some contexts)
    const admin = await User.create({
      fname: 'Admin',
      lname: 'User',
      display_name: 'Admin User',
      email: 'admin@example.com',
      mobile: '+919876543202',
      password: bcrypt.hashSync('Admin@123', 10),
      doctor_id_legacy: 'DOC-ADM-001',
      usertype: 'admin',
      status: 'active',
      verify_status: 'verified',
      advance_payment: true,
      advance_amount: 100,
      created_at: now,
      updated_at: now
    });

    // 3. Dedicated Doctor User
    const doctor = await User.create({
      fname: 'Sarah',
      lname: 'Smith',
      display_name: 'Dr. Sarah Smith',
      email: 'dr.sarah@example.com',
      mobile: '+919988776655',
      password: bcrypt.hashSync('Doctor@123', 10),
      doctor_id_legacy: 'DOC-SAR-101',
      usertype: 'doctor',
      status: 'active',
      verify_status: 'verified',
      advance_payment: true,
      advance_amount: 0,
      created_at: now,
      updated_at: now
    });

    // 4. Client User
    const client1 = await User.create({
      fname: 'Client',
      lname: 'One',
      display_name: 'Client One',
      email: 'client1@example.com',
      mobile: '+919876543211',
      password: bcrypt.hashSync('Client1@123', 10),
      usertype: 'customer',
      status: 'active',
      verify_status: 'verified',
      advance_payment: true,
      advance_amount: 50,
      created_at: now,
      updated_at: now
    });

    console.log('Seeding Doctor Profiles...');
    
    // Doctor Profile for Admin
    await DoctorProfile.create({
      user_id: admin.userid,
      doctor_id: 'DOC-ADM-001',
      clinic_name: 'Admin Central Clinic',
      clinic_address: '123 Admin Rd, Sector 1',
      city: 'Delhi',
      state: 'Delhi',
      country: 'India',
      pincode: '110001'
    });

    // Doctor Profile for Sarah Smith
    await DoctorProfile.create({
      user_id: doctor.userid,
      doctor_id: 'DOC-SAR-101',
      clinic_name: 'Wellness Dermatology',
      clinic_address: 'Suite 405, Health Plaza, Bandra West',
      city: 'Mumbai',
      state: 'Maharashtra',
      country: 'India',
      pincode: '400050'
    });

    console.log('Seeding addresses for all users...');

    const users = [
      { obj: superAdmin, city: 'Delhi', state: 'Delhi', zip: '110001' },
      { obj: admin, city: 'Delhi', state: 'Delhi', zip: '110001' },
      { obj: doctor, city: 'Mumbai', state: 'Maharashtra', zip: '400050' },
      { obj: client1, city: 'Mumbai', state: 'Maharashtra', zip: '400001' }
    ];

    for (const u of users) {
      // Billing Address
      await Address.create({
        user_id: u.obj.userid,
        address_type: 'billing',
        is_default_billing: true,
        first_name: u.obj.fname,
        last_name: u.obj.lname,
        address_line1: `${u.obj.fname} Billing St, ${u.city}`,
        city_text: u.city,
        state_text: u.state,
        country_text: 'India',
        pincode: u.zip,
        phone: u.obj.mobile,
        email: u.obj.email,
        updated_at: now
      });

      // Shipping Address
      await Address.create({
        user_id: u.obj.userid,
        address_type: 'shipping',
        is_default_shipping: true,
        first_name: u.obj.fname,
        last_name: u.obj.lname,
        address_line1: `${u.obj.fname} Shipping St, ${u.city}`,
        city_text: u.city,
        state_text: u.state,
        country_text: 'India',
        pincode: u.zip,
        phone: u.obj.mobile,
        email: u.obj.email,
        updated_at: now
      });
    }

    // Capture specific address IDs for order seeding
    const client1Billing = await Address.findOne({ where: { user_id: client1.userid, address_type: 'billing' } });
    const client1Shipping = await Address.findOne({ where: { user_id: client1.userid, address_type: 'shipping' } });

    console.log('Seeding categories and products...');
    const productA = await Product.create({
      product_name: 'Advanced Face Serum',
      product_description: 'A highly effective face serum for daily use.',
      product_code: 'SERUM-001',
      product_sku: 'SKU-SERUM-01',
      status: 'active',
      availability: 'in_stock',
      generic_name: 'Face Serum',
      brand_name: 'Health Glow',
      tax_rate: 18.00,
      mrp_price: 1500.00,
      buy_price: 1200.00,
      category: 'Skin Care',
      lifecycle_status: 'active',
      advance_percentage: 50.00,
      created_at: now,
      updated_at: now
    });

    console.log('Seeding orders...');
    const order1 = await Order.create({
      user_id: client1.userid,
      billing_address_id: client1Billing.address_id,
      shipping_address_id: client1Shipping.address_id,
      order_status: 'shipped',
      payment_status: 'paid',
      subtotal: 1500.00,
      discount_total: 0,
      tax_total: 270.00,
      shipping_total: 50.00,
      grand_total: 1820.00,
      advance_amount_due: 0,
      created_at: now
    });

    await OrderItem.create({
      order_id: order1.order_id,
      product_id: productA.product_id,
      item_type: 'product',
      quantity: 1,
      unit_price: 1500.00,
      discount_amount: 0,
      tax_amount: 270.00,
      line_total: 1770.00
    });

    console.log('Seeding payments...');
    await Payment.create({
      orderOrderId: order1.order_id,
      UserUserid: client1.userid,
      paymentId: 'pay_ABC123456',
      razorpayOrderId: 'order_XYZ987654',
      gateway: 'razorpay',
      gatewayReference: 'order_XYZ987654',
      paidAmount: 1820.00,
      remainingAmount: 0.00,
      currency: 'INR',
      status: 'completed'
    });

    console.log('Seeding Appointments...');
    // One appointment with the Admin and one with Dr. Sarah Smith
    await Appointment.create({
      user_id: client1.userid,
      doctor_id: admin.userid,
      clinic_name: 'Admin Central Clinic',
      email: client1.email,
      phone: client1.mobile,
      address: '123 Client Rd',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400001',
      reason: 'General Skin Checkup',
      mode: 'offline',
      status: 'confirmed',
      lifecycle_status: 'active',
      slot1_date: '2026-03-10',
      slot1_time: '11:00:00',
      created_at: now,
      updated_at: now
    });

    await Appointment.create({
      user_id: client1.userid,
      doctor_id: doctor.userid,
      clinic_name: 'Wellness Dermatology',
      email: client1.email,
      phone: client1.mobile,
      address: 'Suite 405, Health Plaza',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400050',
      reason: 'Acne Consultation',
      mode: 'offline',
      status: 'pending',
      lifecycle_status: 'active',
      slot1_date: '2026-03-15',
      slot1_time: '14:30:00',
      created_at: now,
      updated_at: now
    });

    console.log('Seeding New Developments...');
    await Newdevelopment.create({
      user_id: client1.userid,
      application_type: 'Cream',
      condition_type: 'Acne',
      fragrance_preference: 'None',
      ingredients_preference: 'Natural',
      ph_range: '5.5-6.0',
      product_category: 'Face',
      product_type: 'Night Cream',
      request_status: 'Pending',
      specifications: { text: 'Must be oil-free' },
      submitted_date: '2026-02-21',
      target_area: 'Face',
      created_at: now,
      updated_at: now
    });

    console.log('Seeding Product Customizations...');
    await ProductCustomization.create({
      product_id: productA.product_id,
      user_id: client1.userid,
      formulation: 'Custom Active Ingredient X',
      packaging: 'Pumper Bottle',
      product_category: 'Skin Care',
      sub_category: 'Serum',
      sub_sub_category: 'Anti-Acne',
      product_sku: 'CUSTOM-SKU-001',
      product_description: 'Modified Advanced Face Serum',
      application_area: 'Face',
      skin_type: 'Oily',
      fragrance: 'Rose',
      color: 'Light Pink',
      ph_range: '5.8',
      status: 'Pending',
      life_cycle_status: 'active',
      created_at: now,
      updated_at: now
    });

    console.log('Seeding complete.');
    process.exit(0);
  } catch (err) {
    console.error('Seeding failed:', err);
    process.exit(1);
  }
}

seed();

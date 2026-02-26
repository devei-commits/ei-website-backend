require('dotenv').config();
const db = require('./db');
const { User, RefreshToken, DoctorProfile } = require('./src/users/models');
const { Role } = require('./src/models/index');
const { Product } = require('./src/products/models');
const { Order, OrderItem } = require('./src/orders/models');
const { Payment } = require('./src/payments/models');
const Address = require('./src/models/Addresses');
const Appointment = require('./src/appointments/models');
const Newdevelopment = require('./src/newdevelopments/models');
const Customization = require('./src/customizations/models');
const ProductCustomization = require('./src/productCustomizations/models');
const Enquiry = require('./src/enquiries/models');
const { Item, excelRowToItem } = require('./src/items/models');
const itemsSeedDataRaw = require('./src/items/itemsSeedData');
const { Vendor, contactRowToVendor } = require('./src/vendors/models');
const contactsSeedDataRaw = require('./src/vendors/contactsSeedData');
const { Contact, customerRowToModel } = require('./src/Contacts/models');
const seedContactData = require('./src/Contacts/seedContact');
const { CompositeItem, compositeRowToModel } = require('./src/compositeItems/models');
const compositeItemsSeedData = require('./src/compositeItems/compositeItemsSeedData');
const { ModuleDefinition, Permission, RolePermission } = require('./src/models/index');
const { StaffProfile } = require('./src/roles/models');
const defaultModuleDef = require('./src/roles/defaultModuleDefinition');
const bcrypt = require('bcrypt');

const ROLES_TO_SEED = [
  { role_code: 'super_admin', role_name: 'Super Admin', level: 'admin' },
  { role_code: 'admin', role_name: 'Admin', level: 'admin' },
  { role_code: 'bd_manager', role_name: 'BD Manager', level: 'manager' },
  { role_code: 'doctor', role_name: 'Doctor', level: 'staff' },
  { role_code: 'customer', role_name: 'Customer', level: 'client' },
];

const MODULE_IDS = ['dashboard', 'user-management', 'role-management', 'order-management'];

const ROLE_PERMISSIONS_MAP = {
  super_admin: MODULE_IDS,
  admin: MODULE_IDS,
  bd_manager: ['dashboard', 'user-management', 'order-management'],
  doctor: ['dashboard'],
  customer: [],
};

/**
 * Drop entire public schema and recreate it so all tables (including unused/orphan ones)
 * are permanently removed. Then sync will create only current model tables.
 */
async function dropEntireDatabase() {
  const dialect = db.getDialect();
  if (dialect === 'postgres') {
    console.log('Dropping entire public schema (all tables)...');
    await db.query('DROP SCHEMA public CASCADE', { raw: true });
    await db.query('CREATE SCHEMA public', { raw: true });
    await db.query('GRANT ALL ON SCHEMA public TO public', { raw: true });
    console.log('Public schema recreated (empty).');
    return;
  }
  if (dialect === 'mysql') {
    await db.query('SET FOREIGN_KEY_CHECKS = 0', { raw: true });
    const [tables] = await db.query('SHOW TABLES', { raw: true });
    const key = Object.keys((tables && tables[0]) || {})[0] || 'Tables_in_db';
    for (const row of tables || []) {
      const name = row[key];
      if (name) await db.query(`DROP TABLE IF EXISTS \`${name}\``, { raw: true }).catch(() => {});
    }
    await db.query('SET FOREIGN_KEY_CHECKS = 1', { raw: true });
    console.log('All tables dropped.');
    return;
  }
  if (dialect === 'sqlite') {
    const [rows] = await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", { raw: true });
    for (const row of rows || []) {
      if (row.name) await db.query(`DROP TABLE IF EXISTS "${row.name}"`, { raw: true }).catch(() => {});
    }
    console.log('All tables dropped.');
    return;
  }
  console.log('Unknown dialect; sync will create/alter known tables only.');
}

async function seed() {
  try {
    await dropEntireDatabase();
    console.log('Syncing database...');
    await db.sync({ alter: true });

    // Ensure permissions.updated_at exists (model expects it for audit)
    await db.query(
      `ALTER TABLE permissions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NULL`,
      { raw: true }
    ).catch(() => {});

    console.log('Seeding module definitions (if empty)...');
    await ModuleDefinition.findOrCreate({
      where: { name: 'default' },
      defaults: { definition_json: defaultModuleDef },
    });

    console.log('Seeding roles and permissions...');
    await RolePermission.destroy({ where: {} });
    const roles = {};
    for (const r of ROLES_TO_SEED) {
      const [row] = await Role.findOrCreate({
        where: { role_code: r.role_code },
        defaults: { role_name: r.role_name, level: r.level, status: 'active' },
      });
      roles[r.role_code] = row;
    }
    const perms = {};
    for (const moduleId of MODULE_IDS) {
      const [row] = await Permission.findOrCreate({
        where: { resource: moduleId, action: 'view' },
        defaults: { resource: moduleId, action: 'view' },
      });
      perms[moduleId] = row;
    }
    for (const [roleCode, moduleIds] of Object.entries(ROLE_PERMISSIONS_MAP)) {
      const role = roles[roleCode];
      if (!role) continue;
      for (const moduleId of moduleIds) {
        const perm = perms[moduleId];
        if (!perm) continue;
        await RolePermission.findOrCreate({
          where: { role_id: role.role_id, permission_id: perm.permission_id },
          defaults: { role_id: role.role_id, permission_id: perm.permission_id },
        });
      }
    }

    const now = new Date();

    console.log('Seeding users...');
    // Test credentials (admin dashboard login):
    //   superadmin@example.com  / SuperAdmin@123  (Super Admin, Administration)
    //   admin@example.com       / Admin@123       (Admin, Administration)
    //   admin2@example.com      / Admin2@123      (Admin, Administration)
    //   bdmanager@example.com   / BDManager@123  (BD Manager, Business Development)
    //   dr.sarah@example.com    / Doctor@123      (Doctor)
    //   client1@example.com     / Client1@123     (Customer)
    //   client2@example.com     / Client2@123     (Customer)

    // 1. Super Admin
    const superAdmin = await User.create({
      fname: 'Super',
      lname: 'Admin',
      display_name: 'Super Admin',
      email: 'superadmin@example.com',
      mobile: '+919876543201',
      password: bcrypt.hashSync('SuperAdmin@123', 10),
      usertype: 'super_admin',
      department: 'Administration',
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
      department: 'Administration',
      status: 'active',
      verify_status: 'verified',
      advance_payment: true,
      advance_amount: 100,
      created_at: now,
      updated_at: now
    });

    // 3. BD Manager (staff – can access dashboard, User Management, etc.)
    const bdManager = await User.create({
      fname: 'Priya',
      lname: 'Sharma',
      display_name: 'Priya Sharma',
      email: 'bdmanager@example.com',
      mobile: '+919876543203',
      password: bcrypt.hashSync('BDManager@123', 10),
      usertype: 'bd_manager',
      department: 'Business Development',
      status: 'active',
      verify_status: 'verified',
      advance_payment: false,
      advance_amount: null,
      created_at: now,
      updated_at: now
    });

    // 4. Second Admin (for testing multiple admins)
    const admin2 = await User.create({
      fname: 'Vijay',
      lname: 'Kumar',
      display_name: 'Vijay Kumar',
      email: 'admin2@example.com',
      mobile: '+919876543204',
      password: bcrypt.hashSync('Admin2@123', 10),
      usertype: 'admin',
      department: 'Administration',
      status: 'active',
      verify_status: 'verified',
      advance_payment: true,
      advance_amount: 100,
      created_at: now,
      updated_at: now
    });

    // 5. Dedicated Doctor User
    const doctor = await User.create({
      fname: 'Sarah',
      lname: 'Smith',
      display_name: 'Dr. Sarah Smith',
      email: 'dr.sarah@example.com',
      mobile: '+919988776655',
      password: bcrypt.hashSync('Doctor@123', 10),
      doctor_id_legacy: 'DOC-SAR-101',
      usertype: 'doctor',
      department: null,
      status: 'active',
      verify_status: 'verified',
      advance_payment: true,
      advance_amount: 0,
      created_at: now,
      updated_at: now
    });

    // 6. Client / Customer users
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

    const client2 = await User.create({
      fname: 'Meera',
      lname: 'Nair',
      display_name: 'Meera Nair',
      email: 'client2@example.com',
      mobile: '+919876543212',
      password: bcrypt.hashSync('Client2@123', 10),
      usertype: 'customer',
      status: 'active',
      verify_status: 'verified',
      advance_payment: false,
      advance_amount: null,
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
      { obj: bdManager, city: 'Bangalore', state: 'Karnataka', zip: '560001' },
      { obj: admin2, city: 'Chennai', state: 'Tamil Nadu', zip: '600001' },
      { obj: doctor, city: 'Mumbai', state: 'Maharashtra', zip: '400050' },
      { obj: client1, city: 'Mumbai', state: 'Maharashtra', zip: '400001' },
      { obj: client2, city: 'Kochi', state: 'Kerala', zip: '682001' }
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
      incredients: 'Hyaluronic Acid, Niacinamide, Vitamin C, Aloe Vera, Green Tea Extract',
      how_to_use: 'Apply 2-3 drops to clean, dry skin morning and evening. Gently pat into face and neck. Follow with moisturizer and sunscreen during the day.',
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
      status: 'Pending',
      product_category: 'Face',
      product_description: 'Night cream for oily skin',
      product_sku: 'ND-SKU-001',
      application_area: 'Face',
      skin_type: 'Oily',
      phrange: '5.5-6.0',
      fragrance: 'None',
      created_at: now,
      updated_at: now
    });

    console.log('Seeding Customizations...');
    const customizationsSeedData = require('./src/customizations/seedData');
    await Customization.bulkCreate(customizationsSeedData);

    console.log('Seeding Items...');
    const itemsSeedData = itemsSeedDataRaw.map((row) => excelRowToItem(row));
    await Item.bulkCreate(itemsSeedData);

    console.log('Seeding Vendors...');
    const vendorsSeedData = contactsSeedDataRaw.map((row) => contactRowToVendor(row));
    await Vendor.bulkCreate(vendorsSeedData);

    console.log('Seeding Customers (contacts)...');
    const customersSeedData = seedContactData.map((row) => customerRowToModel(row));
    await Customer.bulkCreate(customersSeedData);

    console.log('Seeding Composite Items...');
    const compositeItemsData = compositeItemsSeedData.map((row) => compositeRowToModel(row));
    await CompositeItem.bulkCreate(compositeItemsData);

    console.log('Seeding Product Customizations...');
    await ProductCustomization.create({
      user_id: client1.userid,
      product_id: productA.product_id,
      category: 'Sun Protectant',
      formulation: {
        Active: 'Niacinamide 10%',
        Cleanser: 'Oil Cleanser',
        Moisturizer: 'Shea Butter Ultra',
        Others: 'Argan Oil',
        Serum: 'B5 Hydration',
        'Sun Protectant': 'Tinted Mineral'
      },
      formulationSummary: 'Niacinamide 10% - Oil Cleanser - Shea Butter Ultra - Argan Oil - B5 Hydration - Tinted Mineral',
      care: 'SKIN CARE',
      packagingType: 'standard',
      packaging_image: null,
      userNotes: 'Sample product customization notes',
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

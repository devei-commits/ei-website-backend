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
const { Contact, customerRowToModel } = require('./src/contacts/models');
const seedContactData = require('./src/contacts/seedContact');
const { CompositeItem, compositeRowToModel } = require('./src/compositeItems/models');
const compositeItemsSeedData = require('./src/compositeItems/compositeItemsSeedData');
const Packaging = require('./src/packaging/models');
const PackMaterial = require('./src/packMaterials/models');
const RawMaterial = require('./src/rawMaterials/models');
const BOM = require('./src/bom/models');
const ItemMaster = require('./src/itemsMaster/models');
const VendorClient = require('./src/vendorClient/models');
const SalesOrder = require('./src/salesOrders/models');
const PurchaseOrder = require('./src/purchaseOrders/models');
const UniversalSwapHistory = require('./src/universalSwap/models');
const ItemGroup = require('./src/itemGroups/models');
const { ItemsList, ItemListVendorRate, ItemListTier } = require('./src/itemsList/models');
const legacyAppointmentsSeedData = require('./src/appointments/legacySeedData');
const { ModuleDefinition, Permission, RolePermission } = require('./src/models/index');
const { StaffProfile } = require('./src/roles/models');
const defaultModuleDef = require('./src/roles/defaultModuleDefinition');
const bcrypt = require('bcrypt');

const ROLES_TO_SEED = [
  { role_code: 'super_admin', role_name: 'Super Admin', level: 'admin' },
  { role_code: 'admin', role_name: 'Admin', level: 'admin' },
  { role_code: 'bd_manager', role_name: 'BD Manager', level: 'manager' },
  { role_code: 'accounts_team', role_name: 'Accounts Team', level: 'manager' },
  { role_code: 'doctor', role_name: 'Doctor', level: 'staff' },
  { role_code: 'customer', role_name: 'Customer', level: 'client' },
];

const MODULE_IDS = ['dashboard', 'user-management', 'role-management', 'order-management', 'packaging-management', 'raw-materials-management', 'items-master', 'vendor-client', 'sales-purchase', 'universal-swap', 'item-groups'];

/** Admin has all modules (including vendor-client). */
const ADMIN_MODULE_IDS = [...MODULE_IDS];

const ROLE_PERMISSIONS_MAP = {
  super_admin: MODULE_IDS,
  admin: ADMIN_MODULE_IDS,
  bd_manager: ['dashboard', 'user-management', 'order-management', 'packaging-management', 'raw-materials-management', 'items-master', 'sales-purchase', 'universal-swap', 'item-groups'],
  accounts_team: ['dashboard', 'vendor-client'],
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
    //   accounts@example.com    / Accounts@123    (Accounts Team, vendor/client only)
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

    // 4b. Accounts Team (vendor/client master access only)
    const accountsTeam = await User.create({
      fname: 'Accounts',
      lname: 'User',
      display_name: 'Accounts User',
      email: 'accounts@example.com',
      mobile: '+919876543205',
      password: bcrypt.hashSync('Accounts@123', 10),
      usertype: 'accounts_team',
      department: 'Accounts',
      status: 'active',
      verify_status: 'verified',
      advance_payment: false,
      advance_amount: null,
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
      { obj: accountsTeam, city: 'Hyderabad', state: 'Telangana', zip: '500001' },
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

    // Legacy appointments imported from external system
    const nullIf = (value) => (value === 'NULL' || value === '' ? null : value);

    const parseLegacyDate = (value) => {
      const v = nullIf(value);
      if (!v) return null;
      const parts = v.includes('-') ? v.split('-') : v.split('/');
      if (parts.length !== 3) return null;
      let [d, m, y] = parts.map((p) => parseInt(p, 10));
      if (Number.isNaN(d) || Number.isNaN(m) || Number.isNaN(y)) return null;
      if (y < 100) y += 2000;
      const mm = String(m).padStart(2, '0');
      const dd = String(d).padStart(2, '0');
      return `${y}-${mm}-${dd}`;
    };

    const parseLegacyTime = (value) => {
      const v = nullIf(value);
      if (!v) return null;
      const match = v.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (!match) return null;
      let hour = parseInt(match[1], 10);
      const minute = match[2];
      const ampm = match[3].toUpperCase();
      if (ampm === 'PM' && hour !== 12) hour += 12;
      if (ampm === 'AM' && hour === 12) hour = 0;
      return `${String(hour).padStart(2, '0')}:${minute}:00`;
    };

    console.log('Seeding legacy Appointments...');
    const legacyAppointmentsData = legacyAppointmentsSeedData.map((row) => {
      const addressParts = [
        nullIf(row.app_address1),
        nullIf(row.app_address2),
        nullIf(row.app_other_address),
      ].filter(Boolean);

      return {
        app_id: row.app_id,
        app_type: nullIf(row.app_type),
        app_doc_name: nullIf(row.app_doc_name),
        app_doc_mobile: nullIf(row.app_doc_mobile),
        app_doc_email: nullIf(row.app_doc_email),
        app_clinic_name: nullIf(row.app_clinic_name),
        app_address1: nullIf(row.app_address1),
        app_address2: nullIf(row.app_address2),
        app_state: nullIf(row.app_state),
        app_city: nullIf(row.app_city),
        app_other_address: nullIf(row.app_other_address),
        app_pincode: nullIf(row.app_pincode),
        app_date1: nullIf(row.app_date1),
        app_date1_time_slot1: nullIf(row.app_date1_time_slot1),
        app_date2: nullIf(row.app_date2),
        app_date2_time_slot2: nullIf(row.app_date2_time_slot2),
        app_status: nullIf(row.app_status),
        app_remarks: nullIf(row.app_remarks),
        app_userid: nullIf(row.app_userid),
        confirm_appointment: nullIf(row.confirm_appointment),
        app_confirmation_status: nullIf(row.app_confirmation_status),
        meeting_status: nullIf(row.meeting_status),
        mom: nullIf(row.mom),
        assign_to: nullIf(row.assign_to),
        pex_id: nullIf(row.pex_id),
        adedon: nullIf(row.adedon),

        // Normalized fields
        user_id: null,
        doctor_id: null,
        clinic_name: nullIf(row.app_clinic_name),
        email: nullIf(row.app_doc_email),
        phone: nullIf(row.app_doc_mobile),
        address: addressParts.length ? addressParts.join(', ') : null,
        city: nullIf(row.app_city),
        state: nullIf(row.app_state),
        pincode: nullIf(row.app_pincode),
        reason: null,
        mode: nullIf(row.app_address1) === 'Online' ? 'online' : 'offline',
        status: nullIf(row.app_status),
        lifecycle_status: 'legacy',
        slot1_date: parseLegacyDate(row.app_date1),
        slot1_time: parseLegacyTime(row.app_date1_time_slot1),
        slot2_date: parseLegacyDate(row.app_date2),
        slot2_time: parseLegacyTime(row.app_date2_time_slot2),
        created_at: now,
        updated_at: now,
      };
    });

    await Appointment.bulkCreate(legacyAppointmentsData);

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
    await Contact.bulkCreate(customersSeedData);

    console.log('Seeding Composite Items...');
    const compositeItemsData = compositeItemsSeedData.map((row) => compositeRowToModel(row));
    await CompositeItem.bulkCreate(compositeItemsData);

    console.log('Seeding Packaging (Masters)...');
    await Packaging.destroy({ where: {} });
    await Packaging.bulkCreate([
      { package_code: 'PKG-BTL-001', package_name: '30ml Dropper Bottle', package_sku: 'SKU-DRP-30', bottom: 'round', cap_type: 'dropper', bottom_name: 'Amber Glass', bottom_material: 'glass', cap_name: 'Black Dropper', cap_material: 'plastic', bottom_color: 'Amber', cap_color: 'Black', bottom_weight: '45g', cap_weight: '8g', dispenser_volume: '30ml', minimum_order_quantity: '1000', budget: 'medium', comments: 'Standard serum bottle', status: 'active', created_at: now, updated_at: now },
      { package_code: 'PKG-JAR-001', package_name: '50ml Cream Jar', package_sku: 'SKU-JAR-50', bottom: 'flat', cap_type: 'screw', bottom_name: 'Frosted Glass', bottom_material: 'glass', cap_name: 'Gold Lid', cap_material: 'metal', bottom_color: 'Frosted White', cap_color: 'Gold', bottom_weight: '85g', cap_weight: '25g', dispenser_volume: '50ml', minimum_order_quantity: '500', budget: 'high', comments: 'Premium cream jar', status: 'active', created_at: now, updated_at: now },
      { package_code: 'PKG-PMP-001', package_name: '100ml Pump Bottle', package_sku: 'SKU-PMP-100', bottom: 'round', cap_type: 'pump', bottom_name: 'Clear PET', bottom_material: 'plastic', cap_name: 'White Pump', cap_material: 'plastic', bottom_color: 'Clear', cap_color: 'White', bottom_weight: '35g', cap_weight: '12g', dispenser_volume: '100ml', minimum_order_quantity: '2000', budget: 'low', comments: 'Economy lotion bottle', status: 'active', created_at: now, updated_at: now },
    ]);

    console.log('Seeding Pack Materials...');
    await PackMaterial.destroy({ where: {} });
    await PackMaterial.bulkCreate([
      { code: 'EI-PM-BOX-001', description: 'Sunscreen 50g Monocarton', type: 'Monocarton', level: 'Secondary', group: null, material: '300 GSM Duplex Board', size_spec: '52x52x35mm', price_per_pc: 2.8, moq: 5000, lead_time_days: 21, print_status: 'Approved', products: ['PR-002'], created_at: now, updated_at: now },
      { code: 'EI-PM-BOX-002', description: 'Facewash 150ml Monocarton', type: 'Monocarton', level: 'Secondary', group: null, material: '300 GSM Duplex Board', size_spec: '52x52x168mm', price_per_pc: 3.2, moq: 5000, lead_time_days: 21, print_status: 'Approved', products: ['PR-002'], created_at: now, updated_at: now },
      { code: 'EI-PM-BTL-001', description: '150ml Clear PET Pump Bottle', type: 'Bottle', level: 'Primary', group: 'Primary +1', material: 'PET (Food Grade)', size_spec: '150ml / 28/410', price_per_pc: 5.5, moq: 5000, lead_time_days: 21, print_status: 'Label awaited', products: ['PR-002'], created_at: now, updated_at: now },
      { code: 'EI-PM-CAP-001', description: 'Oval Flip-Top Cap for 25mm Tube', type: 'Closure', level: 'Primary', group: null, material: 'PP White', size_spec: '25mm neck', price_per_pc: 0.65, moq: 10000, lead_time_days: 14, print_status: 'N/A', products: ['PR-002'], created_at: now, updated_at: now },
      { code: 'EI-PM-LBL-001', description: 'Facewash Front Label 100×80mm', type: 'Label', level: 'Primary', group: 'Primary +1', material: 'BOPP Self Adhesive', size_spec: '100mm × 80mm', price_per_pc: 0.65, moq: 10000, lead_time_days: 14, print_status: 'Approved', products: ['PR-002'], created_at: now, updated_at: now },
      { code: 'EI-PM-PMP-001', description: '24/410 Lotion Pump White', type: 'Pump', level: 'Primary', group: null, material: 'PP/PE', size_spec: '24/410 / 33mm dia', price_per_pc: 2.2, moq: 5000, lead_time_days: 14, print_status: 'N/A', products: ['PR-002'], created_at: now, updated_at: now },
      { code: 'EI-PM-TUB-001', description: '50g Aluminium Laminated Tube', type: 'Tube', level: 'Primary', group: 'Primary +1', material: 'Aluminium/Plastic Laminate', size_spec: '50g / 82mm × 32mm', price_per_pc: 4.2, moq: 5000, lead_time_days: 21, print_status: 'Artwork approved', products: ['PR-002'], created_at: now, updated_at: now },
    ]);

    console.log('Seeding Raw Materials...');
    await RawMaterial.destroy({ where: {} });
    await RawMaterial.bulkCreate([
      { code: 'EI-RM-ACT-001', name: 'Glycerin', inci: 'Glycerin', category: 'ACTIVE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 55, gst: 12, shelf: '36M', status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-002', name: 'Niacinamide', inci: 'Niacinamide', category: 'ACTIVE', rm_type: 'Solid', uom: 'KG', price_per_kg: 1450, gst: 12, shelf: '24M', status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-003', name: 'Ascorbyl Glucoside', inci: 'Ascorbyl Glucoside', category: 'ACTIVE', rm_type: 'Solid', uom: 'KG', price_per_kg: 4800, gst: 12, shelf: '18M', status: 'Active', products: ['PR-001'], group: 'Primary', created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-004', name: 'Allantoin', inci: 'Allantoin', category: 'ACTIVE', rm_type: 'Solid', uom: 'KG', price_per_kg: 780, gst: 12, shelf: '36M', status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-005', name: 'Tocopheryl Acetate', inci: 'Tocopheryl Acetate', category: 'ACTIVE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 2200, gst: 12, shelf: '24M', status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-006', name: 'Aloe Vera Extract', inci: 'Aloe Barbadensis Leaf Juice', category: 'BOTANICAL', rm_type: 'Liquid', uom: 'KG', price_per_kg: 280, gst: 5, shelf: '18M', status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-BASE-001', name: 'Aqua (Purified Water)', inci: 'Aqua', category: 'BASE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 8.85, gst: 8, shelf: '24M', status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-EMUL-001', name: 'Cetearyl Alcohol', inci: 'Cetearyl Alcohol', category: 'EMULSIFIER', rm_type: 'Solid', uom: 'KG', price_per_kg: 185, gst: 12, shelf: '36M', status: 'Active', products: ['PR-001'], group: 'Primary +1', created_at: now, updated_at: now },
      { code: 'EI-RM-EMUL-002', name: 'Ceteareth-20', inci: 'Ceteareth-20', category: 'EMULSIFIER', rm_type: 'Solid', uom: 'KG', price_per_kg: 310, gst: 12, shelf: '24M', status: 'Active', products: ['PR-001'], group: 'Alt +1', created_at: now, updated_at: now },
      { code: 'EI-RM-EXCIP-001', name: 'Sodium Hydroxide (50%)', inci: 'Sodium Hydroxide', category: 'EXCIPIENT', rm_type: 'Liquid', uom: 'KG', price_per_kg: 45, gst: 18, shelf: '24M', status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-EXCIP-002', name: 'Citric Acid Monohydrate', inci: 'Citric Acid', category: 'EXCIPIENT', rm_type: 'Solid', uom: 'KG', price_per_kg: 85, gst: 12, shelf: '36M', status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-FRAG-001', name: 'Parfum — Solar Breeze', inci: 'Parfum', category: 'FRAGRANCE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 1500, gst: 18, shelf: '24M', status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-FRAG-002', name: 'Parfum — Jasmine Fresh', inci: 'Parfum', category: 'FRAGRANCE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 1600, gst: 18, shelf: '24M', status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-POLY-001', name: 'Carbomer 980', inci: 'Carbomer', category: 'POLYMER', rm_type: 'Solid', uom: 'KG', price_per_kg: 900, gst: 18, shelf: '36M', status: 'Active', products: ['PR-001'], group: 'Primary +1', created_at: now, updated_at: now },
      { code: 'EI-RM-POLY-002', name: 'Carbopol 940', inci: 'Carbomer', category: 'POLYMER', rm_type: 'Solid', uom: 'KG', price_per_kg: 850, gst: 18, shelf: '24M', status: 'Active', products: ['PR-002'], group: 'Alt +1', created_at: now, updated_at: now },
      { code: 'EI-RM-PRES-001', name: 'Phenoxyethanol', inci: 'Phenoxyethanol', category: 'PRESERVATIVE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 520, gst: 18, shelf: '36M', status: 'Active', products: ['PR-001', 'PR-002'], group: 'Primary', created_at: now, updated_at: now },
      { code: 'EI-RM-SURF-001', name: 'SLES 70%', inci: 'Sodium Laureth Sulfate', category: 'SURFACTANT', rm_type: 'Liquid', uom: 'KG', price_per_kg: 125, gst: 18, shelf: '24M', status: 'Active', products: ['PR-002'], group: 'Primary +1', created_at: now, updated_at: now },
      { code: 'EI-RM-SURF-002', name: 'Cocamidopropyl Betaine', inci: 'Cocamidopropyl Betaine', category: 'SURFACTANT', rm_type: 'Liquid', uom: 'KG', price_per_kg: 190, gst: 18, shelf: '24M', status: 'Active', products: ['PR-001'], group: 'Alt +1', created_at: now, updated_at: now },
      { code: 'EI-RM-SURF-003', name: 'Decyl Glucoside', inci: 'Decyl Glucoside', category: 'SURFACTANT', rm_type: 'Liquid', uom: 'KG', price_per_kg: 240, gst: 18, shelf: '18M', status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-UVF-001', name: 'Ethylhexyl Methoxycinnamate', inci: 'Ethylhexyl Methoxycinnamate', category: 'UV FILTER', rm_type: 'Liquid', uom: 'KG', price_per_kg: 1200, gst: 18, shelf: '24M', status: 'Active', products: ['PR-001'], group: 'Primary', created_at: now, updated_at: now },
      { code: 'EI-RM-UVF-002', name: 'Titanium Dioxide (nano)', inci: 'Titanium Dioxide', category: 'UV FILTER', rm_type: 'Solid', uom: 'KG', price_per_kg: 650, gst: 12, shelf: '36M', status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-UVF-003', name: 'Zinc Oxide (nano)', inci: 'Zinc Oxide', category: 'UV FILTER', rm_type: 'Solid', uom: 'KG', price_per_kg: 720, gst: 12, shelf: '36M', status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-UVF-004', name: 'Avobenzone', inci: 'Butyl Methoxydibenzoylmethane', category: 'UV FILTER', rm_type: 'Solid', uom: 'KG', price_per_kg: 980, gst: 18, shelf: '24M', status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
    ]);

    const bomRmLines1 = [
      { code: 'EI-RM-BASE-001', name: 'Aqua (Purified Water)', phase: 'A', func: 'Solvent', pct: 70, uom: 'GM', spec: 'BP/EP', notes: '' },
      { code: 'EI-RM-ACT-002', name: 'Niacinamide', phase: 'A', func: 'Active', pct: 5, uom: 'GM', spec: '98%', notes: '' },
      { code: 'EI-RM-ACT-003', name: 'Ascorbyl Glucoside', phase: 'A', func: 'Active', pct: 10, uom: 'GM', spec: '98%', notes: '' },
      { code: 'EI-RM-EMUL-001', name: 'Cetearyl Alcohol', phase: 'B', func: 'Emulsifier', pct: 2, uom: 'GM', spec: 'NF', notes: '' },
      { code: 'EI-RM-PRES-001', name: 'Phenoxyethanol', phase: 'C', func: 'Preservative', pct: 0.5, uom: 'GM', spec: 'EP', notes: '' },
    ];
    const bomPmLines1 = [
      { code: 'EI-PM-BTL-001', name: '30ml Amber Dropper Bottle', cat: 'Primary', qty: 1, uom: 'PCS', notes: '' },
      { code: 'EI-PM-CAP-001', name: 'Dropper Cap', cat: 'Closure', qty: 1, uom: 'PCS', notes: '' },
      { code: 'EI-PM-LBL-001', name: 'Front Label 50x80mm', cat: 'Label', qty: 1, uom: 'PCS', notes: '' },
    ];
    console.log('Seeding BOMs...');
    await BOM.destroy({ where: {} });
    await BOM.bulkCreate([
      {
        bom_code: 'BOM-FG-001', bom_sku: 'SKU-VC-SERUM-30', bom_category: 'Skincare', bom_unit: 'GM', bom_hsn: '330499', bom_tax_preference: 'Taxable', bom_returnable: false, bom_associate_items: 'Sample Sachet, Gift Box',
        type: 'FG', status: 'Draft', version: 'v1.0', client: 'Esthetic Insights', name: 'Vitamin C Serum 30ml', dosage: '10% w/w', pack_size: '30ml', site: 'Baddi Plant', category: 'FMCG',
        claims: 'Brightens skin, Reduces dark spots', project: 'Project Glow', market: 'India, USA', created_by: 'John Doe', reviewed_by: 'Jane Smith',
        desc: 'Vitamin C serum with niacinamide and ferulic acid. Oil-free, suitable for all skin types.',
        spec_bulk: 'Clear to slightly yellow liquid; pH 3.0–3.5.', spec_process: 'Cold process; add actives below 40°C.', spec_fg: 'pH 3.0–3.5; viscosity 2000–4000 cPs.', spec_pack: '30ml amber dropper bottle; batch code on bottom.', spec_tests: 'Stability 3M/6M; preservative efficacy.', spec_release: 'All tests pass; QA sign-off.',
        batch: '100 KG', yield_pct: '98', overage: '2', line: 'Line 1', notes: 'Store in cool place; avoid direct sunlight.', regulatory: 'EU Compliant; ISO 22716.', ph_range: '3.0 - 3.5', description: 'Vitamin C Serum BOM for 30ml pack',
        rm_lines: bomRmLines1, pm_lines: bomPmLines1, created_at: now, updated_at: now,
      },
      {
        bom_code: 'BOM-FG-002', bom_sku: 'SKU-FW-150', bom_category: 'Skincare', bom_unit: 'ML', bom_hsn: '330499', bom_tax_preference: 'Taxable', bom_returnable: false, bom_associate_items: '',
        type: 'FG', status: 'Approved', version: 'v1.0', client: 'Esthetic Insights', name: 'Face Wash 150ml', dosage: '5% w/w', pack_size: '150ml', site: 'Baddi Plant', category: 'FMCG',
        claims: 'Gentle cleanse, pH balanced', project: 'Project Glow', market: 'India', created_by: 'Jane Smith', reviewed_by: 'John Doe',
        desc: 'Daily use face wash with mild surfactants.',
        spec_bulk: 'Clear viscous liquid.', spec_process: 'Standard mixing.', spec_fg: 'pH 5.5–6.5.', spec_pack: '150ml PET pump bottle.', spec_tests: 'Stability; PE.', spec_release: 'QA sign-off.',
        batch: '200 KG', yield_pct: '97', overage: '1', line: 'Line 2', notes: '', regulatory: 'ISO 22716.', ph_range: '5.5 - 6.5', description: 'Face Wash BOM 150ml',
        rm_lines: [{ code: 'EI-RM-BASE-001', name: 'Aqua', phase: 'A', func: 'Solvent', pct: 85, uom: 'GM', spec: 'BP', notes: '' }, { code: 'EI-RM-SURF-001', name: 'SLES 70%', phase: 'B', func: 'Surfactant', pct: 8, uom: 'GM', spec: 'NF', notes: '' }],
        pm_lines: [{ code: 'EI-PM-BTL-001', name: '150ml PET Pump Bottle', cat: 'Primary', qty: 1, uom: 'PCS', notes: '' }],
        created_at: now, updated_at: now,
      },
    ]);

    console.log('Seeding Item Groups (RM/PM groups with member_ids from raw_materials/pack_materials)...');
    await ItemGroup.destroy({ where: {} });
    const rmByCode = await RawMaterial.findAll({ attributes: ['id', 'code'] }).then(rows => new Map(rows.map(r => [r.code, r.id])));
    const pmByCode = await PackMaterial.findAll({ attributes: ['id', 'code'] }).then(rows => new Map(rows.map(r => [r.code, r.id])));
    const igSeed = [
      { code: 'IG-001', icon: '💧', type: 'RM', name: 'Emulsion Base Water Phase', description: 'Purified water sources — mutually interchangeable at same %', purpose: 'Water phase for emulsions', status: 'Active', notes: 'Only one water source currently; group for future expansion', member_ids: [rmByCode.get('EI-RM-BASE-001')].filter(Boolean), proposed_alternates: [], created_at: now, updated_at: now },
      { code: 'IG-002', icon: '☀️', type: 'RM', name: 'Broad-Spectrum UV Filter Pack', description: 'UV filters approved for sunscreen formula', purpose: 'Sunscreen actives', status: 'Active', notes: 'SPF must be re-verified', member_ids: ['EI-RM-UVF-001', 'EI-RM-UVF-002', 'EI-RM-UVF-003', 'EI-RM-UVF-004'].map(c => rmByCode.get(c)).filter(Boolean), proposed_alternates: [], created_at: now, updated_at: now },
      { code: 'IG-003', icon: '🔄', type: 'RM', name: 'Emulsifiers', description: 'Oil & water phase binders — compatibility tested', purpose: 'Emulsion stabilizers', status: 'Active', notes: 'Both emulsifiers work as a pair', member_ids: ['EI-RM-EMUL-001', 'EI-RM-EMUL-002'].map(c => rmByCode.get(c)).filter(Boolean), proposed_alternates: [{ id: '1', name: 'Glyceryl Stearate SE', notes: 'Not yet approved — R&D trial pending', status: 'proposed' }], created_at: now, updated_at: now },
      { code: 'IG-004', icon: '🧊', type: 'RM', name: 'Carbomer Rheology Modifier', description: 'Carbomer 980 and Carbopol 940 interchangeable at same %', purpose: 'Viscosity adjusters', status: 'Active', notes: '980 preferred for sunscreen, 940 for facewash', member_ids: ['EI-RM-POLY-001', 'EI-RM-POLY-002'].map(c => rmByCode.get(c)).filter(Boolean), proposed_alternates: [], created_at: now, updated_at: now },
      { code: 'IG-005', icon: '🛡️', type: 'RM', name: 'Preservative System', description: 'Phenoxyethanol primary', purpose: 'Preservative actives', status: 'Active', notes: 'Primary preservative at 0.8%', member_ids: [rmByCode.get('EI-RM-PRES-001')].filter(Boolean), proposed_alternates: [{ id: '1', name: 'Phenoxyethanol + Ethylhexylglycerin', notes: 'Cosmos-approved alternative', status: 'proposed' }], created_at: now, updated_at: now },
      { code: 'IG-006', icon: '🍋', type: 'RM', name: 'Vitamin C Derivatives', description: 'Ascorbyl Glucoside and Sodium Ascorbyl Phosphate', purpose: 'Antioxidant actives', status: 'Active', notes: 'Use at same % if supply disrupted', member_ids: [rmByCode.get('EI-RM-ACT-003')].filter(Boolean), proposed_alternates: [{ id: '1', name: 'Sodium Ascorbyl Phosphate', notes: 'Stability assessment pending', status: 'proposed' }], created_at: now, updated_at: now },
      { code: 'IG-007', icon: '🫧', type: 'RM', name: 'Anionic Surfactant', description: 'Primary SLES; SCI can partially replace', purpose: 'Cleansing agents', status: 'Active', notes: 'SCI replaces SLES at 90% ratio', member_ids: ['EI-RM-SURF-001', 'EI-RM-SURF-003'].map(c => rmByCode.get(c)).filter(Boolean), proposed_alternates: [], created_at: now, updated_at: now },
      { code: 'IG-008', icon: '🫧', type: 'RM', name: 'Amphoteric Co-Surfactant', description: 'CAPB primary amphoteric', purpose: 'Conditioning agents', status: 'Active', notes: '1:1 swap possible', member_ids: [rmByCode.get('EI-RM-SURF-002')].filter(Boolean), proposed_alternates: [{ id: '1', name: 'Sodium Lauroamphoacetate', notes: 'Milder; trial batch needed', status: 'proposed' }], created_at: now, updated_at: now },
      { code: 'IG-PM-001', icon: '🧴', type: 'PM', name: '50g Sunscreen Primary Pack Tube', description: 'Tube options for 50g sunscreen', purpose: 'Primary packaging', status: 'Active', notes: 'Aluminium laminate preferred', member_ids: [pmByCode.get('EI-PM-TUB-001')].filter(Boolean), proposed_alternates: [{ id: '1', name: '50g HDPE Squeeze Tube', notes: 'Backup option; artwork re-approval needed', status: 'proposed' }], created_at: now, updated_at: now },
      { code: 'IG-PM-002', icon: '🍶', type: 'PM', name: '150ml Facewash Bottle', description: '150ml pump bottle — PET options', purpose: 'Primary packaging', status: 'Active', notes: 'PET transparent preferred', member_ids: [pmByCode.get('EI-PM-BTL-001')].filter(Boolean), proposed_alternates: [{ id: '1', name: '150ml HDPE Opaque Pump Bottle', notes: 'Backup vendor; same neck finish 28/410', status: 'proposed' }], created_at: now, updated_at: now },
    ];
    await ItemGroup.bulkCreate(igSeed);

    console.log('Seeding Items List (vendor pricing view: RM/PM in list with rates and tiers)...');
    await ItemListTier.destroy({ where: {} });
    await ItemListVendorRate.destroy({ where: {} });
    await ItemsList.destroy({ where: {} });
    const itemsListSeed = [];
    const codesFromFrontend = [
      'EI-RM-BASE-001', 'EI-RM-UVF-001', 'EI-RM-UVF-002', 'EI-RM-UVF-003', 'EI-RM-UVF-004', 'EI-RM-EMUL-001', 'EI-RM-EMUL-002',
      'EI-RM-ACT-001', 'EI-RM-ACT-002', 'EI-RM-ACT-003', 'EI-PM-TUB-001', 'EI-PM-BTL-001', 'EI-PM-LBL-001',
    ];
    for (const code of codesFromFrontend) {
      const rmId = rmByCode.get(code);
      const pmId = pmByCode.get(code);
      if (rmId) itemsListSeed.push({ type: 'RM', raw_material_id: rmId, pack_material_id: null, status: 'Active', created_at: now, updated_at: now });
      else if (pmId) itemsListSeed.push({ type: 'PM', raw_material_id: null, pack_material_id: pmId, status: 'Active', created_at: now, updated_at: now });
    }
    await ItemsList.bulkCreate(itemsListSeed);
    const vendors = await VendorClient.findAll({ where: { type: 'vendor' }, order: [['id']], attributes: ['id'] });
    const v1 = vendors[0]?.id;
    const v2 = vendors[1]?.id;
    const itemsListRows = await ItemsList.findAll({ order: [['id']] });
    const firstRm = itemsListRows.find(r => r.type === 'RM');
    const secondRm = itemsListRows.find((r, i) => r.type === 'RM' && i > 0);
    if (firstRm && v1) {
      const rate1 = await ItemListVendorRate.create({ items_list_id: firstRm.id, vendor_id: v1, default_rate: 1200, default_moq: 10, currency: 'INR', status: 'active', created_at: now, updated_at: now });
      await ItemListTier.bulkCreate([
        { item_list_vendor_rate_id: rate1.id, moq_min: 1, moq_max: 99, price_per_unit: 1250, created_at: now, updated_at: now },
        { item_list_vendor_rate_id: rate1.id, moq_min: 100, moq_max: 499, price_per_unit: 1200, created_at: now, updated_at: now },
        { item_list_vendor_rate_id: rate1.id, moq_min: 500, moq_max: null, price_per_unit: 1150, created_at: now, updated_at: now },
      ]);
    }
    if (secondRm && v2) {
      const rate2 = await ItemListVendorRate.create({ items_list_id: secondRm.id, vendor_id: v2, default_rate: 1450, default_moq: 5, currency: 'INR', status: 'active', created_at: now, updated_at: now });
      await ItemListTier.bulkCreate([
        { item_list_vendor_rate_id: rate2.id, moq_min: 1, moq_max: 49, price_per_unit: 1480, created_at: now, updated_at: now },
        { item_list_vendor_rate_id: rate2.id, moq_min: 50, moq_max: null, price_per_unit: 1450, created_at: now, updated_at: now },
      ]);
    }
    const firstPm = itemsListRows.find(r => r.type === 'PM');
    if (firstPm && v1) {
      const ratePm = await ItemListVendorRate.create({ items_list_id: firstPm.id, vendor_id: v1, default_rate: 4.2, default_moq: 5000, currency: 'INR', status: 'active', created_at: now, updated_at: now });
      await ItemListTier.bulkCreate([
        { item_list_vendor_rate_id: ratePm.id, moq_min: 1000, moq_max: 4999, price_per_unit: 4.5, created_at: now, updated_at: now },
        { item_list_vendor_rate_id: ratePm.id, moq_min: 5000, moq_max: null, price_per_unit: 4.2, created_at: now, updated_at: now },
      ]);
    }

    console.log('Seeding Items Master (linked BOMs, Raw Materials, Pack Materials as arrays)...');
    await ItemMaster.destroy({ where: {} });
    const bomsForItems = await BOM.findAll({ where: { bom_code: ['BOM-FG-001', 'BOM-FG-002'] }, order: [['bom_code']], attributes: ['id', 'bom_code', 'name'] });
    const pmsForItems = await PackMaterial.findAll({ where: { code: ['EI-PM-BTL-001', 'EI-PM-TUB-001'] }, order: [['code']], attributes: ['id', 'code', 'description'] });
    const rmsForItems = await RawMaterial.findAll({ where: { code: ['EI-RM-ACT-001', 'EI-RM-BASE-001'] }, order: [['code']], attributes: ['id', 'code', 'name'] });
    const b1 = bomsForItems[0]?.id ?? null;
    const b2 = bomsForItems[1]?.id ?? null;
    const p1 = pmsForItems[0]?.id ?? null;
    const p2 = pmsForItems[1]?.id ?? null;
    const r1 = rmsForItems[0]?.id ?? null;
    const r2 = rmsForItems[1]?.id ?? null;
    await ItemMaster.bulkCreate([
      { code: 'IM-PROD-001', name: 'Vitamin C Serum 30ml', type: 'product', status: 'Active', bom_ids: b1 ? [b1] : [], raw_material_ids: [], pack_material_ids: p1 ? [p1] : [], created_at: now, updated_at: now },
      { code: 'IM-PROD-002', name: 'Face Wash 150ml', type: 'product', status: 'Active', bom_ids: b2 ? [b2] : [], raw_material_ids: [], pack_material_ids: p1 ? [p1] : [], created_at: now, updated_at: now },
      { code: 'IM-PROD-003', name: 'Serum with multiple RMs', type: 'product', status: 'Active', bom_ids: b1 ? [b1] : [], raw_material_ids: [r1, r2].filter(Boolean), pack_material_ids: p1 && p2 ? [p1, p2] : (p1 ? [p1] : []), created_at: now, updated_at: now },
    ]);

    console.log('Seeding Vendor / Client master...');
    await VendorClient.destroy({ where: {} });
    const vendorClientSeed = [
      { entity_code: 'EI-VEN-00001', type: 'vendor', name: 'ELEMENTS BIOTECH', email: 'azad@elementsbiotech.com', phone: '+91-9004730372', location: 'Malad West', country: 'India', city: 'Mumbai Suburban', category: 'COGS-RAW MATERIAL', status: 'active', payment_terms: '—', notes: 'Wholesale business, GST registered', rating: 4, moq: '—', lead_time: '—', data: { setupType: 'VENDOR', setupPrefix: 'VEN', setupCategory: 'COGS-RAW MATERIAL', legalName: 'ELEMENTS BIOTECH', tradeName: 'ELEMENTS BIOTECH', primaryEmail: 'azad@elementsbiotech.com', primaryPhone: '+91-9004730372', billingAddress: 'Kemp Plaza, Chincholi Bunder Road, Malad West', shippingAddress: 'Kemp Plaza, Malad West', state: 'Maharashtra', country: 'India', gstin: '27AALFE7652H1Z3', documents: [], pocs: [], banks: [], vendorItems: [] }, created_at: now, updated_at: now },
      { entity_code: 'EI-VEN-00002', type: 'vendor', name: 'NUPLANET VENTURES INDIA PRIVATE LIMITED', email: 'shadab.khan@rawble.com', phone: '+91-93191 54361', location: 'New Delhi', country: 'India', city: 'South East Delhi', category: 'RAW MATERIAL', status: 'active', payment_terms: '—', notes: 'Raw material supplier, GST registered', rating: 4, moq: '—', lead_time: '—', data: { setupType: 'VENDOR', setupPrefix: 'VEN', setupCategory: 'RAW MATERIAL', legalName: 'NUPLANET VENTURES INDIA PRIVATE LIMITED', tradeName: 'NUPLANET VENTURES', primaryEmail: 'shadab.khan@rawble.com', primaryPhone: '+91-93191 54361', billingAddress: 'B-51, Okhla Industrial Phase 1, New Delhi', state: 'Delhi', country: 'India', gstin: '07AAFCN9850K1ZX', documents: [], pocs: [], banks: [], vendorItems: [] }, created_at: now, updated_at: now },
      { entity_code: 'EI-VEN-00003', type: 'vendor', name: 'VIVEKANANDA PRINTERS', email: 'Marketing@vivekanandaprinters.com', phone: '+91-9392083487', location: 'Hyderabad', country: 'India', city: 'Medchal Malkajgiri', category: 'PACKAGING', status: 'active', payment_terms: '—', notes: 'Secondary packaging supplier', rating: 4, moq: '—', lead_time: '—', data: { setupType: 'VENDOR', setupPrefix: 'VEN', setupCategory: 'PACKAGING', legalName: 'VIVEKANANDA PRINTERS', tradeName: 'VIVEKANANDA PRINTERS', primaryEmail: 'Marketing@vivekanandaprinters.com', primaryPhone: '+91-9392083487', billingAddress: '2-158/11, Suraram, Hyderabad', state: 'Telangana', country: 'India', gstin: '36AALFV4539Q1Z8', documents: [], pocs: [], banks: [], vendorItems: [] }, created_at: now, updated_at: now },
      { entity_code: 'EI-CLI-00001', type: 'client', name: 'Dr. SUVIDHA GANDRA', email: '', phone: '+91-7702693939', location: 'TS', country: 'India', city: '', category: 'BUSINESS', status: 'active', payment_terms: '60', notes: 'Customer CUS-00050', rating: 4, moq: '—', lead_time: '—', data: { setupType: 'CLIENT', setupPrefix: 'CLI', setupCategory: 'BUSINESS', legalName: 'Dr. SUVIDHA GANDRA', tradeName: 'Dr. SUVIDHA GANDRA', primaryPhone: '+91-7702693939', state: 'Telangana', country: 'India', gstin: '36CPYPG1900C1Z2', documents: [], pocs: [], banks: [], productInterests: [] }, created_at: now, updated_at: now },
      { entity_code: 'EI-CLI-00002', type: 'client', name: 'SCULPT PLASTIC SURGERY HYDERABAD LLP', email: '', phone: '+91-9700222661', location: 'Telangana', country: 'India', city: 'Hyderabad', category: 'BUSINESS', status: 'active', payment_terms: '0', notes: 'Customer CUS-00051', rating: 4, moq: '—', lead_time: '—', data: { setupType: 'CLIENT', setupPrefix: 'CLI', setupCategory: 'BUSINESS', legalName: 'SCULPT PLASTIC SURGERY HYDERABAD LLP', tradeName: 'SCULPT PLASTIC SURGERY', billingAddress: '7-1-69/1/25, Shobhanadri Apartment, Ameerpet', state: 'Telangana', country: 'India', gstin: '36AFDFS7869B1ZP', documents: [], pocs: [], banks: [], productInterests: [] }, created_at: now, updated_at: now },
    ];
    await VendorClient.bulkCreate(vendorClientSeed);

    console.log('Seeding Sales Orders and Purchase Orders...');
    await SalesOrder.destroy({ where: {} });
    await PurchaseOrder.destroy({ where: {} });
    await SalesOrder.bulkCreate([
      {
        order_id: 'SO-00001',
        customer_name: 'Customer 1',
        branch: 'Branch A',
        order_date: '2026-02-01',
        expected_shipment_date: '2026-02-15',
        reference: 'REF-SO-001',
        payment_terms: 'NET 30',
        status: 'Submitted',
        order_status: { orderStatus: 'processing', invoiced: 'pending', payment: 'pending', packed: 'pending', shipped: 'pending', deliveryMethod: 'road' },
        form_data: { customerName: 'Customer 1', branch: 'Branch A', orderId: 'SO-00001', reference: 'REF-SO-001', orderDate: '2026-02-01', expectedShipmentDate: '2026-02-15', paymentTerms: 'NET 30', discount: '0', shippingCharges: '0', roundOff: '0' },
        items: [{ itemName: 'Product A', batchNumber: 'B001', quantity: '10', rate: '100', tax: '18' }],
        created_at: now,
        updated_at: now,
      },
      {
        order_id: 'SO-00002',
        customer_name: 'Customer 2',
        branch: 'Branch B',
        order_date: '2026-02-10',
        expected_shipment_date: null,
        reference: '',
        payment_terms: 'NET 60',
        status: 'Draft',
        order_status: {},
        form_data: { customerName: 'Customer 2', branch: 'Branch B', orderId: 'SO-00002', orderDate: '2026-02-10', paymentTerms: 'NET 60' },
        items: [],
        created_at: now,
        updated_at: now,
      },
    ]);
    await PurchaseOrder.bulkCreate([
      {
        order_id: 'PO-00001',
        vendor_name: 'Vendor 1',
        branch: 'Branch A',
        order_date: '2026-02-05',
        expected_shipment_date: '2026-02-20',
        reference: 'REF-PO-001',
        payment_terms: 'NET 30',
        status: 'Submitted',
        order_status: { orderStatus: 'pending', invoiced: 'pending', payment: 'pending', packed: 'pending', shipped: 'pending', deliveryMethod: 'road' },
        form_data: { vendorName: 'Vendor 1', branch: 'Branch A', poNumber: 'PO-00001', orderId: 'PO-00001', orderDate: '2026-02-05', expectedShipmentDate: '2026-02-20', paymentTerms: 'NET 30', discount: '0', shippingCharges: '0', roundOff: '0' },
        items: [{ itemName: 'Raw Material X', batchNumber: 'B002', quantity: '50', rate: '200', tax: '12' }],
        created_at: now,
        updated_at: now,
      },
      {
        order_id: 'PO-00002',
        vendor_name: 'Vendor 2',
        branch: 'Branch B',
        order_date: '2026-02-12',
        expected_shipment_date: null,
        reference: '',
        payment_terms: 'COD',
        status: 'Draft',
        order_status: {},
        form_data: { vendorName: 'Vendor 2', branch: 'Branch B', poNumber: 'PO-00002', orderId: 'PO-00002', orderDate: '2026-02-12', paymentTerms: 'COD' },
        items: [],
        created_at: now,
        updated_at: now,
      },
    ]);

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

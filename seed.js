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
const { Vendor, contactRowToVendor } = require('./src/Vendors/models');
const contactsSeedDataRaw = require('./src/Vendors/contactsSeedData');
const { Contact, customerRowToModel } = require('./src/Contacts/models');
const seedContactData = require('./src/Contacts/seedContact');
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
const PlanningExtracted = require('./src/planningExtracted/models');
const ProcurementRequest = require('./src/procurementRequests/models');
const ProcurementQuotation = require('./src/procurementQuotations/models');
const PoTracking = require('./src/poTracking/models');
const UniversalSwapHistory = require('./src/universalSwap/models');
const ItemGroup = require('./src/itemGroups/models');
const WarehouseInventory = require('./src/warehouseInventory/models');
const warehouseSeedData = require('./src/warehouseInventory/warehouseSeedData');
const { WarehouseLocation, WarehouseRack, WarehouseRackItem } = require('./src/warehouseLocations/models');
const GoodsReceivedNote = require('./src/grn/models');
const MaterialRequestNote = require('./src/mrn/models');
const { ItemsList, ItemListVendorRate, ItemListTier } = require('./src/itemsList/models');
const legacyAppointmentsSeedData = require('./src/appointments/legacySeedData');
const { ProductionEquipment, ProductionTeamMember, ProductionBatch } = require('./src/production/models');
const { FulfillmentOrder, FulfillmentOrderItem, FulfillmentBatchSplit, Transporter, FulfillmentInvoice } = require('./src/fulfillment/models');
const { ClientQuery, ClientDevelopment, ClientOrder, ClientAppointment } = require('./src/clientHub/models');
const FacilityArea = require('./src/facilityAreas/models');
const { Department } = require('./src/departments/models');
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

    // 7. Account Managers (for Client Hub)
    const amPriya = await User.create({
      fname: 'Priya', lname: 'Mehta', display_name: 'Priya Mehta',
      email: 'priya.mehta@example.com', mobile: '+919876543220',
      password: bcrypt.hashSync('PriyaAM@123', 10),
      usertype: 'bd_manager', department: 'Business Development',
      status: 'active', verify_status: 'verified',
      advance_payment: false, advance_amount: null, created_at: now, updated_at: now
    });
    const amSuresh = await User.create({
      fname: 'Suresh', lname: 'Kumar', display_name: 'Suresh Kumar',
      email: 'suresh.kumar@example.com', mobile: '+919876543221',
      password: bcrypt.hashSync('SureshAM@123', 10),
      usertype: 'bd_manager', department: 'Business Development',
      status: 'active', verify_status: 'verified',
      advance_payment: false, advance_amount: null, created_at: now, updated_at: now
    });
    const amAnanya = await User.create({
      fname: 'Ananya', lname: 'Krishnan', display_name: 'Ananya Krishnan',
      email: 'ananya.krishnan@example.com', mobile: '+919876543222',
      password: bcrypt.hashSync('AnanyaAM@123', 10),
      usertype: 'bd_manager', department: 'Business Development',
      status: 'active', verify_status: 'verified',
      advance_payment: false, advance_amount: null, created_at: now, updated_at: now
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
    const [productA, productB] = await Product.bulkCreate([
      {
        product_name: 'EI Sunscreen Lotion SPF50+ PA++++',
        product_description: 'Sunscreen lotion/cream. Fill: 50g, Batch: 500 kg, Shelf: 24M.',
        product_code: 'EI-PR-00001',
        product_sku: 'EI-SUN-50G-001',
        status: 'Production Released',
        availability: 'in_stock',
        generic_name: 'Sunscreen Lotion',
        brand_name: 'EI',
        tax_rate: 18.00,
        mrp_price: 499.00,
        buy_price: null,
        category: 'Sunscreen',
        lifecycle_status: 'Production Released',
        form: 'Lotion/Cream',
        fill_size: '50g',
        batch_size_kg: 500,
        shelf_life_months: 24,
        version: 'v2.0',
        license_cml: 'CML-TG-2023-0042',
        theoretical_yield_pct: 98.50,
        pao_months: 12,
        manufacturing_location: 'EI Plant 1, Hyderabad',
        equipment_vessel: '500L SS Jacketed Mixer + Homogeniser',
        storage_conditions: 'Store 15-25C away from sunlight',
        approved_claims: 'Broad spectrum UVA+UVB - Niacinamide brightening - Vitamin C antioxidant - Non-greasy',
        ph_range: '6.0-7.0',
        viscosity_range: '15,000-25,000 cPs',
        spf_pa_rating: 'SPF50+ PA++++',
        appearance: 'White to off-white smooth lotion',
        odour: 'Light Solar Breeze fragrance',
        fill_weight_spec: '50 +/- 1g',
        stability_summary: 'Accelerated 6M: PASS - Long-term: Ongoing',
        created_at: now,
        updated_at: now
      },
      {
        product_name: 'EI Gentle Foaming Facewash 150ml',
        product_description: 'Face wash gel. Fill: 150ml, Batch: 500 kg, Shelf: 24M.',
        product_code: 'EI-PR-00002',
        product_sku: 'EI-FW-150ML-001',
        status: 'Production Released',
        availability: 'in_stock',
        generic_name: 'Face Wash',
        brand_name: 'EI',
        tax_rate: 18.00,
        mrp_price: 299.00,
        buy_price: null,
        category: 'Face Wash',
        lifecycle_status: 'Production Released',
        form: 'Gel',
        fill_size: '150ml',
        batch_size_kg: 500,
        shelf_life_months: 24,
        version: 'v2.0',
        license_cml: 'CML-TG-2023-0041',
        theoretical_yield_pct: 98.50,
        pao_months: 12,
        manufacturing_location: 'EI Plant 1, Hyderabad',
        equipment_vessel: '500L SS Jacketed Mixer + Homogeniser',
        storage_conditions: 'Store 15-25C away from sunlight',
        approved_claims: 'Gentle SLS-present formula - Niacinamide brightening - Aloe Vera soothing - pH balanced 5.5-6.5',
        ph_range: '5.5-6.5',
        viscosity_range: '4,000-8,000 cPs',
        spf_pa_rating: 'N/A',
        appearance: 'Clear to slightly hazy gel, no visible particles',
        odour: 'Jasmine Fresh fragrance',
        fill_weight_spec: '150 +/- 3g',
        stability_summary: 'Accelerated 6M: PASS - Long-term: Ongoing',
        created_at: now,
        updated_at: now
      }
    ]);

    // Planning (PR extracted) products — match HTML PRs Extracted (150ml · EI-FG-001 etc.)
    await Product.bulkCreate([
      { product_name: 'EI Gentle Foaming Facewash', product_code: 'EI-FG-001', status: 'Production Released', generic_name: 'Face Wash', category: 'Face Wash', lifecycle_status: 'Production Released', form: 'Gel', fill_size: '150ml', batch_size_kg: 500, created_at: now, updated_at: now },
      { product_name: 'EI Invisible Sunscreen SPF50', product_code: 'EI-FG-002', status: 'Production Ready', generic_name: 'Sunscreen', category: 'Sunscreen', lifecycle_status: 'Production Ready', form: 'Gel', fill_size: '50g', batch_size_kg: 300, created_at: now, updated_at: now },
      { product_name: 'EI Hydra-Boost Moisturiser', product_code: 'EI-FG-003', status: 'In Progress', generic_name: 'Moisturiser', category: 'Moisturiser', lifecycle_status: 'In Progress', form: 'Cream', fill_size: '50ml', batch_size_kg: 200, created_at: now, updated_at: now },
      { product_name: 'EI Keratin Repair Conditioner', product_code: 'EI-FG-004', status: 'Planned', generic_name: 'Conditioner', category: 'Conditioner', lifecycle_status: 'Planned', form: 'Lotion', fill_size: '200ml', batch_size_kg: null, created_at: now, updated_at: now },
    ]);

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
      { code: 'EI-PM-BOX-001', description: 'Sunscreen 50g Monocarton', type: 'Monocarton', level: 'Secondary', group: null, material: '300 GSM Duplex Board', size_spec: '52x52x35mm', price_per_pc: 2.8, moq: 5000, lead_time_days: 21, print_status: 'Approved', products: ['EI-PR-00001'], created_at: now, updated_at: now },
      { code: 'EI-PM-BOX-002', description: 'Facewash 150ml Monocarton', type: 'Monocarton', level: 'Secondary', group: null, material: '300 GSM Duplex Board', size_spec: '52x52x168mm', price_per_pc: 3.2, moq: 5000, lead_time_days: 21, print_status: 'Approved', products: ['EI-PR-00002'], created_at: now, updated_at: now },
      { code: 'EI-PM-BTL-001', description: '150ml Clear PET Pump Bottle', type: 'Bottle', level: 'Primary', group: 'Primary +1', material: 'PET (Food Grade)', size_spec: '150ml / 28/410', price_per_pc: 5.5, moq: 5000, lead_time_days: 21, print_status: 'Label awaited', products: ['EI-PR-00002'], created_at: now, updated_at: now },
      { code: 'EI-PM-CAP-001', description: 'Oval Flip-Top Cap for 25mm Tube', type: 'Closure', level: 'Primary', group: null, material: 'PP White', size_spec: '25mm neck', price_per_pc: 0.65, moq: 10000, lead_time_days: 14, print_status: 'N/A', products: ['EI-PR-00001'], created_at: now, updated_at: now },
      { code: 'EI-PM-LBL-001', description: 'Facewash Front Label 100×80mm', type: 'Label', level: 'Primary', group: 'Primary +1', material: 'BOPP Self Adhesive', size_spec: '100mm × 80mm', price_per_pc: 0.65, moq: 10000, lead_time_days: 14, print_status: 'Approved', products: ['EI-PR-00002'], created_at: now, updated_at: now },
      { code: 'EI-PM-PMP-001', description: '24/410 Lotion Pump White', type: 'Pump', level: 'Primary', group: null, material: 'PP/PE', size_spec: '24/410 / 33mm dia', price_per_pc: 2.2, moq: 5000, lead_time_days: 14, print_status: 'N/A', products: ['EI-PR-00002'], created_at: now, updated_at: now },
      { code: 'EI-PM-TUB-001', description: '50g Aluminium Laminated Tube', type: 'Tube', level: 'Primary', group: 'Primary +1', material: 'Aluminium/Plastic Laminate', size_spec: '50g / 82mm × 32mm', price_per_pc: 4.2, moq: 5000, lead_time_days: 21, print_status: 'Artwork approved', products: ['EI-PR-00001'], created_at: now, updated_at: now },
      // PMs from HTML (sunscreen / moisturiser / conditioner)
      { code: 'EI-PM-TUB-002', description: '50g Laminated Tube White Matte', type: 'Tube', level: 'Primary', group: null, material: 'Laminate', size_spec: '50g', price_per_pc: 4.5, moq: 5000, lead_time_days: 21, print_status: 'Approved', products: ['EI-PR-00001'], created_at: now, updated_at: now },
      { code: 'EI-PM-JAR-001', description: '50ml Acrylic PMMA Jar + Lid White', type: 'Jar', level: 'Primary', group: null, material: 'PMMA', size_spec: '50ml', price_per_pc: 8, moq: 3000, lead_time_days: 28, print_status: 'N/A', products: [], created_at: now, updated_at: now },
      { code: 'EI-PM-BOX-003', description: 'Moisturiser 50ml Monocarton Premium', type: 'Monocarton', level: 'Secondary', group: null, material: '300 GSM Duplex', size_spec: '52x52x60mm', price_per_pc: 3, moq: 5000, lead_time_days: 21, print_status: 'Approved', products: [], created_at: now, updated_at: now },
      { code: 'EI-PM-LBL-002', description: 'Product Insert / IFU Leaflet A5', type: 'Label', level: 'Primary', group: null, material: 'Paper', size_spec: 'A5', price_per_pc: 0.5, moq: 10000, lead_time_days: 14, print_status: 'Approved', products: [], created_at: now, updated_at: now },
      { code: 'EI-PM-BTL-002', description: '200ml HDPE Bottle White Oval', type: 'Bottle', level: 'Primary', group: null, material: 'HDPE', size_spec: '200ml', price_per_pc: 6, moq: 5000, lead_time_days: 21, print_status: 'N/A', products: [], created_at: now, updated_at: now },
      { code: 'EI-PM-CAP-002', description: '28/410 Disc Cap White', type: 'Closure', level: 'Primary', group: null, material: 'PP', size_spec: '28/410', price_per_pc: 1.2, moq: 10000, lead_time_days: 14, print_status: 'N/A', products: [], created_at: now, updated_at: now },
      { code: 'EI-PM-LBL-003', description: 'Conditioner 200ml Wrap Label 200×130mm', type: 'Label', level: 'Primary', group: null, material: 'BOPP', size_spec: '200×130mm', price_per_pc: 0.8, moq: 10000, lead_time_days: 14, print_status: 'Approved', products: [], created_at: now, updated_at: now },
      { code: 'EI-PM-BOX-004', description: '24-unit Shipper Master Carton', type: 'Shipper', level: 'Tertiary', group: null, material: 'Kraft', size_spec: 'Master', price_per_pc: 25, moq: 500, lead_time_days: 14, print_status: 'Approved', products: [], created_at: now, updated_at: now },
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
      { code: 'EI-RM-SURF-003', name: 'Sodium Cocoyl Isethionate', inci: 'Sodium Cocoyl Isethionate', category: 'SURFACTANT', rm_type: 'Solid', uom: 'KG', price_per_kg: 240, gst: 18, shelf: '18M', status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-UVF-001', name: 'Ethylhexyl Methoxycinnamate', inci: 'Ethylhexyl Methoxycinnamate', category: 'UV FILTER', rm_type: 'Liquid', uom: 'KG', price_per_kg: 1200, gst: 18, shelf: '24M', status: 'Active', products: ['PR-001'], group: 'Primary', created_at: now, updated_at: now },
      { code: 'EI-RM-UVF-002', name: 'Titanium Dioxide (nano)', inci: 'Titanium Dioxide', category: 'UV FILTER', rm_type: 'Solid', uom: 'KG', price_per_kg: 650, gst: 12, shelf: '36M', status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-UVF-003', name: 'Zinc Oxide (nano)', inci: 'Zinc Oxide', category: 'UV FILTER', rm_type: 'Solid', uom: 'KG', price_per_kg: 720, gst: 12, shelf: '36M', status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-UVF-004', name: 'Avobenzone', inci: 'Butyl Methoxydibenzoylmethane', category: 'UV FILTER', rm_type: 'Solid', uom: 'KG', price_per_kg: 980, gst: 18, shelf: '24M', status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      // RMs from HTML PRs Extracted (sunscreen / moisturiser / conditioner)
      { code: 'EI-RM-UVF-005', name: 'Homosalate', inci: 'Homosalate', category: 'UV FILTER', rm_type: 'Liquid', uom: 'KG', price_per_kg: 520, gst: 18, shelf: '24M', status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-UVF-006', name: 'Octocrylene', inci: 'Octocrylene', category: 'UV FILTER', rm_type: 'Liquid', uom: 'KG', price_per_kg: 590, gst: 18, shelf: '24M', status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-HUM-001', name: 'Butylene Glycol', inci: 'Butylene Glycol', category: 'HUMECTANT', rm_type: 'Liquid', uom: 'KG', price_per_kg: 180, gst: 18, shelf: '24M', status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-EMUL-003', name: 'Stearic Acid', inci: 'Stearic Acid', category: 'EMULSIFIER', rm_type: 'Solid', uom: 'KG', price_per_kg: 120, gst: 12, shelf: '36M', status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-EMUL-004', name: 'PEG-100 Stearate/Glyceryl Stearate', inci: 'PEG-100 Stearate', category: 'EMULSIFIER', rm_type: 'Solid', uom: 'KG', price_per_kg: 380, gst: 18, shelf: '24M', status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-SOLV-001', name: 'Isohexadecane', inci: 'Isohexadecane', category: 'SOLVENT', rm_type: 'Liquid', uom: 'KG', price_per_kg: 220, gst: 18, shelf: '24M', status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-SOLV-002', name: 'Cyclopentasiloxane', inci: 'Cyclopentasiloxane', category: 'SOLVENT', rm_type: 'Liquid', uom: 'KG', price_per_kg: 450, gst: 18, shelf: '24M', status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-PRES-002', name: 'Ethylhexylglycerin', inci: 'Ethylhexylglycerin', category: 'PRESERVATIVE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 1200, gst: 18, shelf: '24M', status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-SILI-001', name: 'Dimethicone', inci: 'Dimethicone', category: 'SILICONE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 680, gst: 18, shelf: '24M', status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-007', name: 'Sodium Hyaluronate', inci: 'Sodium Hyaluronate', category: 'ACTIVE', rm_type: 'Solid', uom: 'KG', price_per_kg: 8500, gst: 12, shelf: '24M', status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-008', name: 'Ceramide NP', inci: 'Ceramide NP', category: 'ACTIVE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 12000, gst: 12, shelf: '18M', status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-009', name: 'Panthenol', inci: 'Panthenol', category: 'ACTIVE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 420, gst: 12, shelf: '24M', status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-010', name: 'Centella Asiatica Extract', inci: 'Centella Asiatica Extract', category: 'BOTANICAL', rm_type: 'Liquid', uom: 'KG', price_per_kg: 1800, gst: 5, shelf: '18M', status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-COND-001', name: 'Cetrimonium Chloride', inci: 'Cetrimonium Chloride', category: 'CONDITIONER', rm_type: 'Solid', uom: 'KG', price_per_kg: 320, gst: 18, shelf: '24M', status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-COND-002', name: 'Guar Hydroxypropyltrimonium Chloride', inci: 'Guar Hydroxypropyltrimonium Chloride', category: 'CONDITIONER', rm_type: 'Solid', uom: 'KG', price_per_kg: 580, gst: 18, shelf: '24M', status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-COND-003', name: 'Behentrimonium Methosulfate/Cetearyl', inci: 'Behentrimonium Methosulfate', category: 'CONDITIONER', rm_type: 'Solid', uom: 'KG', price_per_kg: 420, gst: 18, shelf: '24M', status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-OIL-001', name: 'Cocos Nucifera Oil', inci: 'Cocos Nucifera Oil', category: 'OIL', rm_type: 'Liquid', uom: 'KG', price_per_kg: 180, gst: 5, shelf: '12M', status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-OIL-002', name: 'Argania Spinosa Kernel Oil', inci: 'Argania Spinosa Kernel Oil', category: 'OIL', rm_type: 'Liquid', uom: 'KG', price_per_kg: 3200, gst: 5, shelf: '12M', status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-SILI-002', name: 'Amodimethicone', inci: 'Amodimethicone', category: 'SILICONE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 920, gst: 18, shelf: '24M', status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-011', name: 'Hydrolyzed Keratin', inci: 'Hydrolyzed Keratin', category: 'ACTIVE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 1200, gst: 12, shelf: '18M', status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
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
      // PR product BOMs (linked to products table for products-master panel)
      {
        bom_code: 'PR-BOM-001', name: 'EI Sunscreen Lotion SPF50+ PA++++', product_id: productA.product_id,
        type: 'FG', status: 'Approved', version: 'v2.0', ph_range: '6.0-7.0', yield_pct: '98.5',
        rm_lines: [
          { phase: 'Phase A', inci_name: 'Aqua', rm_code: 'EI-RM-BASE-001', pct_w_w: 52.30, uom: 'kg' },
          { phase: 'Phase A', inci_name: 'Glycerin', rm_code: 'EI-RM-ACT-001', pct_w_w: 3.00, uom: 'kg' },
          { phase: 'Phase A', inci_name: 'Carbomer 980', rm_code: 'EI-RM-POLY-001', pct_w_w: 0.30, uom: 'kg' },
          { phase: 'Phase B (Oil)', inci_name: 'Homosalate', rm_code: 'EI-RM-UVF-001', pct_w_w: 10.00, uom: 'kg' },
          { phase: 'Phase B (Oil)', inci_name: 'Ethylhexyl Methoxycinnamate', rm_code: 'EI-RM-UVF-002', pct_w_w: 7.50, uom: 'kg' },
          { phase: 'Phase B (Oil)', inci_name: 'Octocrylene', rm_code: 'EI-RM-UVF-003', pct_w_w: 8.00, uom: 'kg' },
          { phase: 'Phase B (Oil)', inci_name: 'Butyl Methoxydibenzoylmethane', rm_code: 'EI-RM-UVF-004', pct_w_w: 3.00, uom: 'kg' },
          { phase: 'Phase B (Oil)', inci_name: 'Cetearyl Alcohol', rm_code: 'EI-RM-EMUL-001', pct_w_w: 3.00, uom: 'kg' },
          { phase: 'Phase B (Oil)', inci_name: 'Ceteareth-20', rm_code: 'EI-RM-EMUL-002', pct_w_w: 2.00, uom: 'kg' },
          { phase: 'Phase B (Oil)', inci_name: 'Tocopheryl Acetate', rm_code: 'EI-RM-ACT-005', pct_w_w: 0.50, uom: 'kg' },
          { phase: 'Phase C (Active)', inci_name: 'Niacinamide', rm_code: 'EI-RM-ACT-002', pct_w_w: 2.00, uom: 'kg' },
          { phase: 'Phase C (Active)', inci_name: 'Ascorbyl Glucoside', rm_code: 'EI-RM-ACT-003', pct_w_w: 1.00, uom: 'kg' },
          { phase: 'Phase C (Active)', inci_name: 'Allantoin', rm_code: 'EI-RM-ACT-004', pct_w_w: 0.20, uom: 'kg' },
          { phase: 'Phase C (Active)', inci_name: 'Parfum', rm_code: 'EI-RM-FRAG-001', pct_w_w: 0.30, uom: 'kg' },
          { phase: 'Phase D (Pres)', inci_name: 'Phenoxyethanol', rm_code: 'EI-RM-PRES-001', pct_w_w: 0.80, uom: 'kg' },
          { phase: 'Phase E (Adjust)', inci_name: 'Sodium Hydroxide', rm_code: 'EI-RM-EXCIP-001', pct_w_w: 0.40, uom: 'kg' },
        ],
        pm_lines: [
          { pm_code: 'EI-PM-TUB-001', description: '50g Aluminium Laminated Tube', pack_type: 'Primary', qty_per_unit: 1, uom: 'pc/unit' },
          { pm_code: 'EI-PM-CAP-001', description: 'Oval Flip-Top Cap', pack_type: 'Primary', qty_per_unit: 1, uom: 'pc/unit' },
          { pm_code: 'EI-PM-BOX-001', description: 'Sunscreen 50g Monocarton', pack_type: 'Secondary', qty_per_unit: 1, uom: 'pc/unit' },
        ],
        process_steps: [
          { step_number: 1, description: 'Weigh all raw materials per BOM; verify COA, pass QC release check', duration_minutes: 45 },
          { step_number: 2, description: 'Phase A: Charge Purified Water in main vessel; heat to 70-75C with slow agitation 100 RPM', duration_minutes: 20 },
          { step_number: 3, description: 'Phase A: Disperse Carbomer 980 in water; mix at 200 RPM until uniform', duration_minutes: 10 },
          { step_number: 4, description: 'Phase B: Blend all UV filters + emulsifiers + Tocopherol; heat to 75C', duration_minutes: 25 },
          { step_number: 5, description: 'Emulsification: Add Phase B to Phase A at 75C with homogeniser at 3000 RPM', duration_minutes: 15 },
          { step_number: 6, description: 'Cool to 40C with slow agitation; add Phase C actives (Niacinamide, Ascorbyl Glucoside, Allantoin, Fragrance)', duration_minutes: 30 },
          { step_number: 7, description: 'Add Phase D Phenoxyethanol; neutralise with NaOH to pH 6.0-7.0; adjust viscosity', duration_minutes: 20 },
          { step_number: 8, description: 'QC check: pH, viscosity, appearance, odour, SPF quick test; fill into tube after PASS', duration_minutes: 45 },
        ],
        stability_summary: 'Accelerated 6M: PASS - Long-term: Ongoing',
        created_at: now, updated_at: now,
      },
      {
        bom_code: 'PR-BOM-002', name: 'EI Gentle Foaming Facewash 150ml', product_id: productB.product_id,
        type: 'FG', status: 'Approved', version: 'v2.0', ph_range: '5.5-6.5', yield_pct: '98.5',
        rm_lines: [
          { phase: 'Phase A', inci_name: 'Aqua', rm_code: 'EI-RM-BASE-001', pct_w_w: 68.70, uom: 'kg' },
          { phase: 'Phase A', inci_name: 'Sodium Laureth Sulfate', rm_code: 'EI-RM-SURF-001', pct_w_w: 12.00, uom: 'kg' },
          { phase: 'Phase A', inci_name: 'Cocamidopropyl Betaine', rm_code: 'EI-RM-SURF-002', pct_w_w: 5.00, uom: 'kg' },
          { phase: 'Phase A', inci_name: 'Sodium Cocoyl Isethionate', rm_code: 'EI-RM-SURF-003', pct_w_w: 4.00, uom: 'kg' },
          { phase: 'Phase A', inci_name: 'Glycerin', rm_code: 'EI-RM-ACT-001', pct_w_w: 3.00, uom: 'kg' },
          { phase: 'Phase A', inci_name: 'Carbomer (Carbopol 940)', rm_code: 'EI-RM-POLY-002', pct_w_w: 0.30, uom: 'kg' },
          { phase: 'Phase C (Active)', inci_name: 'Aloe Barbadensis Leaf Juice', rm_code: 'EI-RM-ACT-006', pct_w_w: 2.00, uom: 'kg' },
          { phase: 'Phase C (Active)', inci_name: 'Niacinamide', rm_code: 'EI-RM-ACT-002', pct_w_w: 2.00, uom: 'kg' },
          { phase: 'Phase D (Pres)', inci_name: 'Phenoxyethanol', rm_code: 'EI-RM-PRES-001', pct_w_w: 0.80, uom: 'kg' },
          { phase: 'Phase E (Frag)', inci_name: 'Parfum', rm_code: 'EI-RM-FRAG-002', pct_w_w: 0.50, uom: 'kg' },
          { phase: 'Phase F (Adjust)', inci_name: 'Citric Acid', rm_code: 'EI-RM-EXCIP-002', pct_w_w: 0.20, uom: 'kg' },
          { phase: 'Phase F (Adjust)', inci_name: 'Sodium Hydroxide', rm_code: 'EI-RM-EXCIP-001', pct_w_w: 0.50, uom: 'kg' },
        ],
        pm_lines: [
          { pm_code: 'EI-PM-BTL-001', description: '150ml Clear PET Pump Bottle', pack_type: 'Primary', qty_per_unit: 1, uom: 'pc/unit' },
          { pm_code: 'EI-PM-PMP-001', description: '24/410 Lotion Pump White', pack_type: 'Primary', qty_per_unit: 1, uom: 'pc/unit' },
          { pm_code: 'EI-PM-LBL-001', description: 'Facewash Front Label 100x80mm', pack_type: 'Primary (Label)', qty_per_unit: 1, uom: 'pc/unit' },
          { pm_code: 'EI-PM-BOX-002', description: 'Facewash 150ml Monocarton', pack_type: 'Secondary', qty_per_unit: 1, uom: 'pc/unit' },
        ],
        process_steps: [
          { step_number: 1, description: 'Weigh all raw materials per BOM; verify COA, QC release check', duration_minutes: 30 },
          { step_number: 2, description: 'Phase A: Charge RO Water in main vessel; heat to 70-75C at 150 RPM', duration_minutes: 20 },
          { step_number: 3, description: 'Add SLES 70%, CAPB 35%, SCI slowly with gentle agitation at 200 RPM; mix uniform', duration_minutes: 15 },
          { step_number: 4, description: 'Disperse Carbopol 940 separately in small water portion; add to main vessel', duration_minutes: 10 },
          { step_number: 5, description: 'Add Glycerin; cool to 40C; add Phase C actives (Aloe Vera, Niacinamide)', duration_minutes: 25 },
          { step_number: 6, description: 'Add Phase D Phenoxyethanol; add Phase E Fragrance; mix 5 min', duration_minutes: 10 },
          { step_number: 7, description: 'Neutralise with NaOH to pH 5.5-6.5; adjust with Citric Acid if over-alkaline', duration_minutes: 20 },
          { step_number: 8, description: 'QC: pH, viscosity, appearance, foam test, micro sample; fill after PASS', duration_minutes: 40 },
        ],
        stability_summary: 'Accelerated 6M: PASS - Long-term: Ongoing',
        created_at: now, updated_at: now,
      },
    ]);

    console.log('Seeding Item Groups (RM/PM groups with member_ids from raw_materials/pack_materials)...');
    await ItemGroup.destroy({ where: {} });
    const rmByCode = await RawMaterial.findAll({ attributes: ['id', 'code'] }).then(rows => new Map(rows.map(r => [r.code, r.id])));
    const pmByCode = await PackMaterial.findAll({ attributes: ['id', 'code'] }).then(rows => new Map(rows.map(r => [r.code, r.id])));
    const igSeed = [
      { code: 'IG-001', icon: '', type: 'RM', name: 'Emulsion Base Water Phase', description: 'Purified water sources — mutually interchangeable at same %', purpose: 'Water phase for emulsions', status: 'Active', notes: 'Only one water source currently; group for future expansion', member_ids: [rmByCode.get('EI-RM-BASE-001')].filter(Boolean), proposed_alternates: [], created_at: now, updated_at: now },
      { code: 'IG-002', icon: '', type: 'RM', name: 'Broad-Spectrum UV Filter Pack', description: 'UV filters approved for sunscreen formula', purpose: 'Sunscreen actives', status: 'Active', notes: 'SPF must be re-verified', member_ids: ['EI-RM-UVF-001', 'EI-RM-UVF-002', 'EI-RM-UVF-003', 'EI-RM-UVF-004'].map(c => rmByCode.get(c)).filter(Boolean), proposed_alternates: [], created_at: now, updated_at: now },
      { code: 'IG-003', icon: '', type: 'RM', name: 'Emulsifiers', description: 'Oil & water phase binders — compatibility tested', purpose: 'Emulsion stabilizers', status: 'Active', notes: 'Both emulsifiers work as a pair', member_ids: ['EI-RM-EMUL-001', 'EI-RM-EMUL-002'].map(c => rmByCode.get(c)).filter(Boolean), proposed_alternates: [{ id: '1', name: 'Glyceryl Stearate SE', notes: 'Not yet approved — R&D trial pending', status: 'proposed' }], created_at: now, updated_at: now },
      { code: 'IG-004', icon: '', type: 'RM', name: 'Carbomer Rheology Modifier', description: 'Carbomer 980 and Carbopol 940 interchangeable at same %', purpose: 'Viscosity adjusters', status: 'Active', notes: '980 preferred for sunscreen, 940 for facewash', member_ids: ['EI-RM-POLY-001', 'EI-RM-POLY-002'].map(c => rmByCode.get(c)).filter(Boolean), proposed_alternates: [], created_at: now, updated_at: now },
      { code: 'IG-005', icon: '', type: 'RM', name: 'Preservative System', description: 'Phenoxyethanol primary', purpose: 'Preservative actives', status: 'Active', notes: 'Primary preservative at 0.8%', member_ids: [rmByCode.get('EI-RM-PRES-001')].filter(Boolean), proposed_alternates: [{ id: '1', name: 'Phenoxyethanol + Ethylhexylglycerin', notes: 'Cosmos-approved alternative', status: 'proposed' }], created_at: now, updated_at: now },
      { code: 'IG-006', icon: '', type: 'RM', name: 'Vitamin C Derivatives', description: 'Ascorbyl Glucoside and Sodium Ascorbyl Phosphate', purpose: 'Antioxidant actives', status: 'Active', notes: 'Use at same % if supply disrupted', member_ids: [rmByCode.get('EI-RM-ACT-003')].filter(Boolean), proposed_alternates: [{ id: '1', name: 'Sodium Ascorbyl Phosphate', notes: 'Stability assessment pending', status: 'proposed' }], created_at: now, updated_at: now },
      { code: 'IG-007', icon: '🫧', type: 'RM', name: 'Anionic Surfactant', description: 'Primary SLES; SCI can partially replace', purpose: 'Cleansing agents', status: 'Active', notes: 'SCI replaces SLES at 90% ratio', member_ids: ['EI-RM-SURF-001', 'EI-RM-SURF-003'].map(c => rmByCode.get(c)).filter(Boolean), proposed_alternates: [], created_at: now, updated_at: now },
      { code: 'IG-008', icon: '🫧', type: 'RM', name: 'Amphoteric Co-Surfactant', description: 'CAPB primary amphoteric', purpose: 'Conditioning agents', status: 'Active', notes: '1:1 swap possible', member_ids: [rmByCode.get('EI-RM-SURF-002')].filter(Boolean), proposed_alternates: [{ id: '1', name: 'Sodium Lauroamphoacetate', notes: 'Milder; trial batch needed', status: 'proposed' }], created_at: now, updated_at: now },
      { code: 'IG-PM-001', icon: '', type: 'PM', name: '50g Sunscreen Primary Pack Tube', description: 'Tube options for 50g sunscreen', purpose: 'Primary packaging', status: 'Active', notes: 'Aluminium laminate preferred', member_ids: [pmByCode.get('EI-PM-TUB-001')].filter(Boolean), proposed_alternates: [{ id: '1', name: '50g HDPE Squeeze Tube', notes: 'Backup option; artwork re-approval needed', status: 'proposed' }], created_at: now, updated_at: now },
      { code: 'IG-PM-002', icon: '', type: 'PM', name: '150ml Facewash Bottle', description: '150ml pump bottle — PET options', purpose: 'Primary packaging', status: 'Active', notes: 'PET transparent preferred', member_ids: [pmByCode.get('EI-PM-BTL-001')].filter(Boolean), proposed_alternates: [{ id: '1', name: '150ml HDPE Opaque Pump Bottle', notes: 'Backup vendor; same neck finish 28/410', status: 'proposed' }], created_at: now, updated_at: now },
    ];
    await ItemGroup.bulkCreate(igSeed);

    console.log('Seeding Warehouse Inventory (FK to RM/PM/PR, zone/rack/wh_stock/etc)...');
    await WarehouseInventory.destroy({ where: {} });
    for (const row of warehouseSeedData) {
      if (row.type === 'RM') {
        const rawMaterialId = rmByCode.get(row.code);
        if (rawMaterialId) {
          await WarehouseInventory.create({
            item_type: 'RM',
            raw_material_id: rawMaterialId,
            pack_material_id: null,
            product_id: null,
            zone: row.zone,
            rack: row.rack,
            wh_stock: row.whStock,
            wh_unit: row.whUnit || 'KG',
            ml1_stock: row.ml1Stock,
            ml2_stock: row.ml2Stock,
            stock_in_hand: row.stockInHand,
            reserved: row.reserved,
            in_transit: row.inTransit,
            reorder_pt: row.reorderPt,
            avg_mo: row.avgMo,
            qc_status: row.status || 'In Stock',
            created_at: now,
            updated_at: now,
          });
        }
      } else if (row.type === 'PM') {
        const packMaterialId = pmByCode.get(row.code);
        if (packMaterialId) {
          await WarehouseInventory.create({
            item_type: 'PM',
            raw_material_id: null,
            pack_material_id: packMaterialId,
            product_id: null,
            zone: row.zone,
            rack: row.rack,
            wh_stock: row.whStock,
            wh_unit: row.whUnit || 'PCS',
            ml1_stock: row.ml1Stock,
            ml2_stock: row.ml2Stock,
            stock_in_hand: row.stockInHand,
            reserved: row.reserved,
            in_transit: row.inTransit,
            reorder_pt: row.reorderPt,
            avg_mo: row.avgMo,
            qc_status: row.status || 'In Stock',
            created_at: now,
            updated_at: now,
          });
        }
      }
    }
    // Ensure every RM and PM has a warehouse_inventory row (for Items Involved WH BATCHES / backend links)
    const existingWhRm = await WarehouseInventory.findAll({ where: { item_type: 'RM' }, attributes: ['raw_material_id'] });
    const existingWhPm = await WarehouseInventory.findAll({ where: { item_type: 'PM' }, attributes: ['pack_material_id'] });
    const rmIdsWithWh = new Set(existingWhRm.map((r) => r.raw_material_id).filter(Boolean));
    const pmIdsWithWh = new Set(existingWhPm.map((p) => p.pack_material_id).filter(Boolean));
    const allRms = await RawMaterial.findAll({ attributes: ['id'] });
    const allPms = await PackMaterial.findAll({ attributes: ['id'] });
    for (const r of allRms) {
      if (!rmIdsWithWh.has(r.id)) {
        await WarehouseInventory.create({
          item_type: 'RM',
          raw_material_id: r.id,
          pack_material_id: null,
          product_id: null,
          zone: 'Zone A',
          rack: 'A1-L1-S1',
          wh_stock: 0,
          wh_unit: 'KG',
          ml1_stock: 0,
          ml2_stock: 0,
          stock_in_hand: 0,
          reserved: 0,
          in_transit: 0,
          reorder_pt: 0,
          avg_mo: 0,
          qc_status: 'In Stock',
          created_at: now,
          updated_at: now,
        });
      }
    }
    for (const p of allPms) {
      if (!pmIdsWithWh.has(p.id)) {
        await WarehouseInventory.create({
          item_type: 'PM',
          raw_material_id: null,
          pack_material_id: p.id,
          product_id: null,
          zone: 'Zone C',
          rack: 'C1-L1-S1',
          wh_stock: 0,
          wh_unit: 'PCS',
          ml1_stock: 0,
          ml2_stock: 0,
          stock_in_hand: 0,
          reserved: 0,
          in_transit: 0,
          reorder_pt: 0,
          avg_mo: 0,
          qc_status: 'In Stock',
          created_at: now,
          updated_at: now,
        });
      }
    }
    // One warehouse row per product (PR)
    const productsForWarehouse = await Product.findAll({ attributes: ['product_id', 'product_code'] });
    for (const p of productsForWarehouse) {
      await WarehouseInventory.create({
        item_type: 'PR',
        raw_material_id: null,
        pack_material_id: null,
        product_id: p.product_id,
        zone: 'Zone F',
        rack: 'F1-L1-S1',
        wh_stock: 500,
        wh_unit: 'PCS',
        ml1_stock: 100,
        ml2_stock: 50,
        stock_in_hand: 650,
        reserved: 200,
        in_transit: 300,
        reorder_pt: 400,
        avg_mo: 350,
        qc_status: 'In Stock',
        created_at: now,
        updated_at: now,
      });
    }

    // Assign batch_number (WH-2026-RM-001, WH-2026-PM-001, etc.) and expiry_date to each warehouse row
    const year = 2026;
    const whRowsToLabel = await WarehouseInventory.findAll({
      order: [['item_type', 'ASC'], ['raw_material_id', 'ASC'], ['pack_material_id', 'ASC'], ['product_id', 'ASC']],
      attributes: ['id', 'item_type', 'raw_material_id', 'pack_material_id', 'product_id'],
    });
    const rmShelfById = new Map(
      (await RawMaterial.findAll({ attributes: ['id', 'shelf'] })).map((r) => [r.id, r.shelf || '24M'])
    );
    const shelfMonths = (s) => {
      if (!s || typeof s !== 'string') return 24;
      const m = parseInt(s.replace(/\D/g, ''), 10);
      return Number.isNaN(m) ? 24 : m;
    };
    const addMonths = (date, months) => {
      const d = new Date(date);
      d.setMonth(d.getMonth() + months);
      return d.toISOString().slice(0, 10);
    };
    let rmSeq = 0;
    let pmSeq = 0;
    let prSeq = 0;
    for (const w of whRowsToLabel) {
      let batchNumber = null;
      let expiryDate = null;
      if (w.item_type === 'RM' && w.raw_material_id) {
        rmSeq += 1;
        batchNumber = `WH-${year}-RM-${String(rmSeq).padStart(3, '0')}`;
        const months = shelfMonths(rmShelfById.get(w.raw_material_id));
        expiryDate = addMonths(now, months);
      } else if (w.item_type === 'PM' && w.pack_material_id) {
        pmSeq += 1;
        batchNumber = `WH-${year}-PM-${String(pmSeq).padStart(3, '0')}`;
        expiryDate = addMonths(now, 24);
      } else if (w.item_type === 'PR' && w.product_id) {
        prSeq += 1;
        batchNumber = `WH-${year}-PR-${String(prSeq).padStart(3, '0')}`;
        expiryDate = addMonths(now, 36);
      }
      if (batchNumber) await WarehouseInventory.update({ batch_number: batchNumber, expiry_date: expiryDate }, { where: { id: w.id } });
    }

    /* ── Departments ── */
    console.log('Seeding Departments...');
    await Department.destroy({ where: {} });
    await Department.bulkCreate([
      { name: 'Business Development', code: 'business-development', is_active: true, created_at: now, updated_at: now },
      { name: 'Quality Assurance',    code: 'quality-assurance',    is_active: true, created_at: now, updated_at: now },
      { name: 'Research & Development', code: 'research-development', is_active: true, created_at: now, updated_at: now },
      { name: 'Sales',               code: 'sales',                is_active: true, created_at: now, updated_at: now },
      { name: 'Packaging',           code: 'packaging',            is_active: true, created_at: now, updated_at: now },
      { name: 'Design',              code: 'design',               is_active: true, created_at: now, updated_at: now },
      { name: 'Procurement',         code: 'procurement',          is_active: true, created_at: now, updated_at: now },
      { name: 'Manufacturing',       code: 'manufacturing',        is_active: true, created_at: now, updated_at: now },
      { name: 'Logistics',           code: 'logistics',            is_active: true, created_at: now, updated_at: now },
      { name: 'Administration',      code: 'administration',       is_active: true, created_at: now, updated_at: now },
      { name: 'Production',          code: 'production',           is_active: true, created_at: now, updated_at: now },
      { name: 'Filling',             code: 'filling',              is_active: true, created_at: now, updated_at: now },
      { name: 'Quality',             code: 'quality',              is_active: true, created_at: now, updated_at: now },
      { name: 'Human Resources',     code: 'human-resources',      is_active: true, created_at: now, updated_at: now },
      { name: 'Finance',             code: 'finance',              is_active: true, created_at: now, updated_at: now },
      { name: 'IT',                  code: 'it',                   is_active: true, created_at: now, updated_at: now },
    ]);

    console.log('Seeding Facility Areas...');
    await WarehouseRackItem.destroy({ where: {} });
    await WarehouseRack.destroy({ where: {} });
    await WarehouseLocation.destroy({ where: {} });
    await FacilityArea.destroy({ where: {} });

    const areaSeed = [
      { code: 'AREA-WH',   name: 'Main Warehouse',      area_type: 'warehouse',  icon: '', description: 'Central warehouse storage zones' },
      { code: 'AREA-MFG',  name: 'Manufacturing Floor',  area_type: 'production', icon: '', description: 'Manufacturing vessels and supporting tanks' },
      { code: 'AREA-DISP', name: 'Dispensing Room',       area_type: 'production', icon: '', description: 'RM weighing & dispensing area' },
      { code: 'AREA-FIL',  name: 'Filling Hall',         area_type: 'production', icon: '', description: 'Filling lines FL-01 to FL-04' },
      { code: 'AREA-PKG',  name: 'Packaging Bay',        area_type: 'production', icon: '', description: 'Packaging lines, shrink wrap station' },
      { code: 'AREA-QC',   name: 'QC Lab',               area_type: 'production', icon: '', description: 'Quality control & in-process testing' },
    ];
    const createdAreas = await FacilityArea.bulkCreate(
      areaSeed.map((a) => ({ ...a, created_at: now, updated_at: now }))
    );
    const areaByCode = new Map(createdAreas.map((a) => [a.code, a.id]));

    console.log('Seeding Warehouse Locations & Racks...');
    const allWhInv = await WarehouseInventory.findAll({ order: [['id', 'ASC']] });
    const whInvIds = allWhInv.map((r) => r.id);
    const productRows = await Product.findAll({ where: {}, attributes: ['product_id', 'product_code'] });
    const prWhInv = await WarehouseInventory.findAll({ where: { item_type: 'PR' } });
    const prCodeToId = new Map();
    for (const w of prWhInv) {
      const p = productRows.find((pr) => pr.product_id === w.product_id);
      if (p && p.product_code) prCodeToId.set(p.product_code, w.id);
    }
    const tagToWhInvId = (tag) => {
      const t = String(tag).trim();
      if (t === '00001') return prCodeToId.get('EI-PR-00001');
      if (t === '00002') return prCodeToId.get('EI-PR-00002');
      const idx = parseInt(t, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= whInvIds.length) return whInvIds[idx - 1];
      return null;
    };

    const WH = areaByCode.get('AREA-WH');
    const MFG = areaByCode.get('AREA-MFG');
    const DISP = areaByCode.get('AREA-DISP');
    const FIL = areaByCode.get('AREA-FIL');
    const PKG = areaByCode.get('AREA-PKG');
    const QC = areaByCode.get('AREA-QC');

    const locationSeed = [
      // Main Warehouse zones
      { code: 'LOC-RM',  name: 'RM Store',            area_id: WH,  location_type: 'warehouse', zone_label: 'Zone A', icon: '', area_sqm: 380, description: 'Ambient + Cool + Cold zones', utilisation_pct: 68 },
      { code: 'LOC-ACT', name: 'Actives Store',       area_id: WH,  location_type: 'warehouse', zone_label: 'Zone B', icon: '', area_sqm: 120, description: 'Cool <25 C / Climate controlled', utilisation_pct: 78 },
      { code: 'LOC-PPM', name: 'Primary Pack Store',  area_id: WH,  location_type: 'warehouse', zone_label: 'Zone C', icon: '', area_sqm: 220, description: 'Ambient', utilisation_pct: 53 },
      { code: 'LOC-LBL', name: 'Labels Store',        area_id: WH,  location_type: 'warehouse', zone_label: 'Zone D', icon: '', area_sqm: 80,  description: 'Ambient humidity-controlled', utilisation_pct: 48 },
      { code: 'LOC-SPM', name: 'Secondary Pack Store', area_id: WH, location_type: 'warehouse', zone_label: 'Zone E', icon: '', area_sqm: 280, description: 'Ambient', utilisation_pct: 47 },
      { code: 'LOC-FG',  name: 'Finished Goods Store', area_id: WH, location_type: 'warehouse', zone_label: 'Zone F', icon: '', area_sqm: 300, description: 'Cool dry <25 C', utilisation_pct: 29 },
      // Manufacturing Floor zones
      { code: 'LOC-MV01', name: 'MV-01 Bay',          area_id: MFG, location_type: 'production', zone_label: 'Manufacturing', icon: '', area_sqm: 120, description: 'Main vessel MV-01 (2000L)', utilisation_pct: null },
      { code: 'LOC-MV02', name: 'MV-02 Bay',          area_id: MFG, location_type: 'production', zone_label: 'Manufacturing', icon: '', area_sqm: 120, description: 'Main vessel MV-02 (1000L)', utilisation_pct: null },
      { code: 'LOC-MV03', name: 'MV-03 Bay',          area_id: MFG, location_type: 'production', zone_label: 'Manufacturing', icon: '', area_sqm: 100, description: 'Main vessel MV-03 (500L)', utilisation_pct: null },
      { code: 'LOC-STANK', name: 'Supporting Tanks Bay', area_id: MFG, location_type: 'production', zone_label: 'Manufacturing', icon: '', area_sqm: 110, description: 'Supporting tanks ST-01 to ST-04', utilisation_pct: null },
      // Dispensing Room zones
      { code: 'LOC-DISP1', name: 'Dispensing Bay 1',  area_id: DISP, location_type: 'production', zone_label: 'Dispensing', icon: '', area_sqm: 40, description: 'Primary dispensing station', utilisation_pct: null },
      { code: 'LOC-DISP2', name: 'Dispensing Bay 2',  area_id: DISP, location_type: 'production', zone_label: 'Dispensing', icon: '', area_sqm: 40, description: 'Secondary dispensing station', utilisation_pct: null },
      // Filling Hall zones
      { code: 'LOC-FL01', name: 'Filling Line 1 Zone', area_id: FIL, location_type: 'production', zone_label: 'Filling', icon: '', area_sqm: 75, description: 'FL-01 Automatic filling line', utilisation_pct: null },
      { code: 'LOC-FL02', name: 'Filling Line 2 Zone', area_id: FIL, location_type: 'production', zone_label: 'Filling', icon: '', area_sqm: 75, description: 'FL-02 Automatic filling line', utilisation_pct: null },
      { code: 'LOC-FL03', name: 'Filling Line 3 Zone', area_id: FIL, location_type: 'production', zone_label: 'Filling', icon: '', area_sqm: 75, description: 'FL-03 Automatic filling line', utilisation_pct: null },
      { code: 'LOC-FL04', name: 'Filling Line 4 Zone (Manual)', area_id: FIL, location_type: 'production', zone_label: 'Filling', icon: '', area_sqm: 75, description: 'FL-04 Manual filling line', utilisation_pct: null },
      // Packaging Bay zones
      { code: 'LOC-PL01', name: 'Packaging Line 1 Zone', area_id: PKG, location_type: 'production', zone_label: 'Packaging', icon: '', area_sqm: 140, description: 'PL-01 primary packaging line', utilisation_pct: null },
      { code: 'LOC-PL02', name: 'Packaging Line 2 Zone', area_id: PKG, location_type: 'production', zone_label: 'Packaging', icon: '', area_sqm: 140, description: 'PL-02 secondary packaging line', utilisation_pct: null },
      { code: 'LOC-SHRINK', name: 'Shrink Wrap Station', area_id: PKG, location_type: 'production', zone_label: 'Packaging', icon: '', area_sqm: 70, description: 'Shrink wrap / heat tunnel station', utilisation_pct: null },
      // QC Lab zones
      { code: 'LOC-QCIPT', name: 'In-Process Testing',  area_id: QC, location_type: 'production', zone_label: 'QC', icon: '', area_sqm: 25, description: 'In-process QC testing bench', utilisation_pct: null },
      { code: 'LOC-QCBLK', name: 'Bulk QC Station',     area_id: QC, location_type: 'production', zone_label: 'QC', icon: '', area_sqm: 20, description: 'Bulk QC sampling & testing', utilisation_pct: null },
      { code: 'LOC-QCFR',  name: 'Final Release',       area_id: QC, location_type: 'production', zone_label: 'QC', icon: '', area_sqm: 15, description: 'Final release QC review', utilisation_pct: null },
    ];
    const createdLocations = await WarehouseLocation.bulkCreate(
      locationSeed.map((l) => ({ ...l, created_at: now, updated_at: now }))
    );
    const locByCode = new Map(createdLocations.map((c) => [c.code, c.id]));

    const rackSeed = [
      { locCode: 'LOC-RM', code: 'A1', name: 'A1', description: 'Ambient Row 1', levels: 4, slots_total: 16, tags: ['001', '001'] },
      { locCode: 'LOC-RM', code: 'A2', name: 'A2', description: 'Ambient Row 2', levels: 4, slots_total: 16, tags: ['001', '002', '001', '002', '002'] },
      { locCode: 'LOC-RM', code: 'A3', name: 'A3', description: 'Ambient Row 3', levels: 4, slots_total: 16, tags: ['001', '002'] },
      { locCode: 'LOC-RM', code: 'A4', name: 'A4', description: 'Ambient Row 4', levels: 4, slots_total: 16, tags: [] },
      { locCode: 'LOC-RM', code: 'B1', name: 'B1', description: 'Cool Store <25°C', levels: 3, slots_total: 12, tags: ['001', '002'] },
      { locCode: 'LOC-RM', code: 'B2', name: 'B2', description: 'Cool Store <25°C', levels: 3, slots_total: 12, tags: ['001', '001', '002'] },
      { locCode: 'LOC-RM', code: 'C1', name: 'C1', description: 'Cold Store 2–8°C', levels: 2, slots_total: 8, tags: ['006'] },
      { locCode: 'LOC-ACT', code: 'B1', name: 'B1', description: 'Actives UV Filters', levels: 3, slots_total: 9, tags: ['001', '002', '003', '004'] },
      { locCode: 'LOC-ACT', code: 'B2', name: 'B2', description: 'Actives Vitamins/VC', levels: 3, slots_total: 9, tags: ['002', '003', '004', '005'] },
      { locCode: 'LOC-PPM', code: 'C1', name: 'C1', description: 'Pack Bottles', levels: 4, slots_total: 16, tags: ['001'] },
      { locCode: 'LOC-PPM', code: 'C2', name: 'C2', description: 'Pack Tubes/Caps', levels: 4, slots_total: 16, tags: ['001', '001'] },
      { locCode: 'LOC-PPM', code: 'C3', name: 'C3', description: 'Pack Pumps/Closures', levels: 4, slots_total: 16, tags: ['001'] },
      { locCode: 'LOC-PPM', code: 'C4', name: 'C4', description: 'Pack Reserve/Overflow', levels: 4, slots_total: 16, tags: [] },
      { locCode: 'LOC-LBL', code: 'D1', name: 'D1', description: 'Labels Self-Adhesive', levels: 3, slots_total: 12, tags: ['001'] },
      { locCode: 'LOC-LBL', code: 'D2', name: 'D2', description: 'Labels Printed Leaflets', levels: 3, slots_total: 12, tags: [] },
      { locCode: 'LOC-SPM', code: 'E1', name: 'E1', description: 'SPM Sunscreen Cartons', levels: 4, slots_total: 16, tags: ['001'] },
      { locCode: 'LOC-SPM', code: 'E2', name: 'E2', description: 'SPM Facewash Cartons', levels: 4, slots_total: 16, tags: ['002'] },
      { locCode: 'LOC-SPM', code: 'E3', name: 'E3', description: 'SPM Shippers/Master', levels: 3, slots_total: 12, tags: [] },
      { locCode: 'LOC-FG', code: 'F1', name: 'F1', description: 'FG Quarantine (Under QC)', levels: 3, slots_total: 12, tags: [] },
      { locCode: 'LOC-FG', code: 'F2', name: 'F2', description: 'FG QC Released / Approved', levels: 4, slots_total: 16, tags: ['00001', '00002'] },
      { locCode: 'LOC-FG', code: 'F3', name: 'F3', description: 'FG Dispatch Ready', levels: 4, slots_total: 16, tags: [] },
    ];

    const createdRacks = [];
    for (const r of rackSeed) {
      const locationId = locByCode.get(r.locCode);
      if (!locationId) continue;
      const rack = await WarehouseRack.create({
        location_id: locationId,
        code: r.code,
        name: r.name,
        description: r.description,
        levels: r.levels,
        slots_total: r.slots_total,
        created_at: now,
        updated_at: now,
      });
      createdRacks.push({ rack, tags: r.tags });
    }

    for (const { rack, tags } of createdRacks) {
      const rackId = rack.id;
      for (const tag of tags) {
        const invId = tagToWhInvId(tag);
        if (invId != null) {
          await WarehouseRackItem.create({
            rack_id: rackId,
            warehouse_inventory_id: invId,
            created_at: now,
            updated_at: now,
          });
        }
      }
    }

    console.log('Seeding Vendor / Client master (before Items List)...');
    await VendorClient.destroy({ where: {} });
    const vendorClientSeed = [
      { entity_code: 'EI-VEN-00001', type: 'vendor', name: 'Chemspec India', email: 'orders@chemspecindia.com', phone: '+91-9876543210', location: 'Mumbai', country: 'India', city: 'Mumbai', category: 'RAW MATERIAL', status: 'active', payment_terms: 'NET 30', notes: 'Reference VD-001', rating: 4, moq: '—', lead_time: '—', data: {}, created_at: now, updated_at: now },
      { entity_code: 'EI-VEN-00002', type: 'vendor', name: 'Sigma Chemicals', email: 'sales@sigmachemicals.com', phone: '+91-9876543211', location: 'Delhi', country: 'India', city: 'Delhi', category: 'RAW MATERIAL', status: 'active', payment_terms: 'NET 30', notes: 'Reference VD-ALT-001', rating: 4, moq: '—', lead_time: '—', data: {}, created_at: now, updated_at: now },
      { entity_code: 'EI-VEN-00003', type: 'vendor', name: 'Nutreco Exports', email: 'export@nutreco.com', phone: '+91-9876543212', location: 'Chennai', country: 'India', city: 'Chennai', category: 'RAW MATERIAL', status: 'active', payment_terms: 'NET 30', notes: 'Reference VD-ALT-002', rating: 4, moq: '—', lead_time: '—', data: {}, created_at: now, updated_at: now },
      { entity_code: 'EI-VEN-00004', type: 'vendor', name: 'Packwell Industries', email: 'pack@packwell.com', phone: '+91-9876543213', location: 'Pune', country: 'India', city: 'Pune', category: 'PACKAGING', status: 'active', payment_terms: 'NET 30', notes: 'Reference VD-002', rating: 4, moq: '—', lead_time: '—', data: {}, created_at: now, updated_at: now },
      { entity_code: 'EI-VEN-00005', type: 'vendor', name: 'PackStar India', email: 'info@packstar.in', phone: '+91-9876543214', location: 'Hyderabad', country: 'India', city: 'Hyderabad', category: 'PACKAGING', status: 'active', payment_terms: 'NET 30', notes: 'Reference VD-ALT-003', rating: 4, moq: '—', lead_time: '—', data: {}, created_at: now, updated_at: now },
      { entity_code: 'EI-CLI-00001', type: 'client', name: 'Luminos Skincare', email: 'bd@luminos.in', phone: '+91-9812345001', location: 'Maharashtra', country: 'India', city: 'Mumbai', category: 'CDMO', status: 'active', payment_terms: 'NET 45', notes: '', rating: 5, moq: '—', lead_time: '—', data: {}, priority: 'high', segment: 'Skin Care · Luxury — Since 2022', since_year: 2022, revenue_value: 4200000, avatar_color: 'orange', account_manager_id: amPriya.userid, contacts: [{ name: 'Rajeev Sharma', role: 'BD Head' }, { name: 'Nisha Patel', role: 'QA Lead' }], created_at: now, updated_at: now },
      { entity_code: 'EI-CLI-00002', type: 'client', name: 'HairVeda Pro', email: 'bd@hairveda.in', phone: '+91-9812345002', location: 'Karnataka', country: 'India', city: 'Bengaluru', category: 'CDMO', status: 'active', payment_terms: 'NET 30', notes: '', rating: 5, moq: '—', lead_time: '—', data: {}, priority: 'high', segment: 'Hair Care · Mass Market — Since 2021', since_year: 2021, revenue_value: 7800000, avatar_color: 'teal', account_manager_id: amSuresh.userid, contacts: [{ name: 'Mala Iyer', role: 'CEO' }, { name: 'Deepak Nair', role: 'Technical' }], created_at: now, updated_at: now },
      { entity_code: 'EI-CLI-00003', type: 'client', name: 'GlowNaturals', email: 'bd@glownaturals.in', phone: '+91-9812345003', location: 'Delhi', country: 'India', city: 'Delhi', category: 'CDMO', status: 'active', payment_terms: 'NET 30', notes: '', rating: 4, moq: '—', lead_time: '—', data: {}, priority: 'medium', segment: 'Organic Skin Care · DTC — Since 2023', since_year: 2023, revenue_value: 1800000, avatar_color: 'violet', account_manager_id: amAnanya.userid, contacts: [{ name: 'Shruti Jain', role: 'Founder' }, { name: 'Ravi Kapoor', role: 'Operations' }], created_at: now, updated_at: now },
      { entity_code: 'EI-CLI-00004', type: 'client', name: 'DermaClinix Rx', email: 'bd@dermaclinix.in', phone: '+91-9812345004', location: 'Maharashtra', country: 'India', city: 'Mumbai', category: 'CDMO', status: 'active', payment_terms: 'NET 60', notes: '', rating: 5, moq: '—', lead_time: '—', data: {}, priority: 'high', segment: 'Derma · Rx-to-OTC — Since 2020', since_year: 2020, revenue_value: 11000000, avatar_color: 'red', account_manager_id: amPriya.userid, contacts: [{ name: 'Dr. Anil Bose', role: 'Medical Affairs' }, { name: 'Shalini Roy', role: 'Regulatory' }], created_at: now, updated_at: now },
      { entity_code: 'EI-CLI-00005', type: 'client', name: 'SunShield India', email: 'bd@sunshield.in', phone: '+91-9812345005', location: 'Gujarat', country: 'India', city: 'Ahmedabad', category: 'CDMO', status: 'active', payment_terms: 'NET 30', notes: '', rating: 4, moq: '—', lead_time: '—', data: {}, priority: 'medium', segment: 'Sun Care · Sports & Outdoor — Since 2023', since_year: 2023, revenue_value: 3100000, avatar_color: 'amber', account_manager_id: amSuresh.userid, contacts: [{ name: 'Vikram Sethi', role: 'MD' }, { name: 'Pooja Agarwal', role: 'Product' }], created_at: now, updated_at: now },
      { entity_code: 'EI-CLI-00006', type: 'client', name: 'PureGlow Co.', email: 'bd@pureglow.in', phone: '+91-9812345006', location: 'Maharashtra', country: 'India', city: 'Pune', category: 'CDMO', status: 'active', payment_terms: 'Advance', notes: '', rating: 3, moq: '—', lead_time: '—', data: {}, priority: 'low', segment: 'Colour Cosmetics · D2C — Since 2024', since_year: 2024, revenue_value: 900000, avatar_color: 'pink', account_manager_id: amAnanya.userid, contacts: [{ name: 'Neha Saxena', role: 'CEO' }, { name: 'Rohit Verma', role: 'Creative' }], created_at: now, updated_at: now },
      { entity_code: 'EI-CLI-00007', type: 'client', name: 'MensEdge Grooming', email: 'bd@mensedge.in', phone: '+91-9812345007', location: 'Tamil Nadu', country: 'India', city: 'Chennai', category: 'CDMO', status: 'active', payment_terms: 'NET 30', notes: '', rating: 4, moq: '—', lead_time: '—', data: {}, priority: 'medium', segment: "Men's Care · Mass Premium — Since 2022", since_year: 2022, revenue_value: 5500000, avatar_color: 'blue', account_manager_id: amSuresh.userid, contacts: [{ name: 'Arjun Malik', role: 'Brand Head' }, { name: 'Shweta Das', role: 'Technical' }], created_at: now, updated_at: now },
      { entity_code: 'EI-CLI-00008', type: 'client', name: 'AquaFresh Wellness', email: 'bd@aquafresh.in', phone: '+91-9812345008', location: 'Telangana', country: 'India', city: 'Hyderabad', category: 'CDMO', status: 'active', payment_terms: 'NET 30', notes: '', rating: 4, moq: '—', lead_time: '—', data: {}, priority: 'low', segment: 'Body Care · Wellness — Since 2023', since_year: 2023, revenue_value: 2200000, avatar_color: 'cyan', account_manager_id: amPriya.userid, contacts: [{ name: 'Kavita Rao', role: 'Director' }, { name: 'Mohan Lal', role: 'QA' }], created_at: now, updated_at: now },
    ];
    await VendorClient.bulkCreate(vendorClientSeed);

    // ── Client Hub sub-entities ──
    console.log('Seeding Client Hub data (queries, developments, orders, appointments)...');
    await ClientAppointment.destroy({ where: {} });
    await ClientOrder.destroy({ where: {} });
    await ClientDevelopment.destroy({ where: {} });
    await ClientQuery.destroy({ where: {} });

    const hubClients = await VendorClient.findAll({ where: { type: 'client' }, order: [['entity_code', 'ASC']], attributes: ['id', 'entity_code'] });
    const cliId = {};
    for (const c of hubClients) { cliId[c.entity_code] = c.id; }
    const C1 = cliId['EI-CLI-00001'], C2 = cliId['EI-CLI-00002'], C3 = cliId['EI-CLI-00003'], C4 = cliId['EI-CLI-00004'];
    const C5 = cliId['EI-CLI-00005'], C6 = cliId['EI-CLI-00006'], C7 = cliId['EI-CLI-00007'], C8 = cliId['EI-CLI-00008'];

    await ClientQuery.bulkCreate([
      { client_id: C1, title: 'SPF 50 formulation pricing query — volume breaks', status: 'overdue', due_date: '2026-02-10', category: 'Pricing', notes: 'Client escalation — BD to respond immediately', created_at: now, updated_at: now },
      { client_id: C1, title: 'EU CPNP notification process — sunscreen product', status: 'pending', due_date: '2026-03-05', category: 'Regulatory', notes: 'RA team input awaited', created_at: now, updated_at: now },
      { client_id: C1, title: 'Stability protocol clarification for face cream', status: 'done', due_date: '2026-02-10', category: 'Technical', notes: 'Resolved — protocol doc shared', created_at: now, updated_at: now },
      { client_id: C2, title: 'Anti-hairfall shampoo — sulfate-free new brief', status: 'new', due_date: '2026-03-05', category: 'New Brief', notes: 'Feasibility assessment pending — assign R&D lead', created_at: now, updated_at: now },
      { client_id: C2, title: 'Conditioner scale-up — manufacturing slot query', status: 'overdue', due_date: '2026-02-20', category: 'Capacity', notes: 'Production planning team to respond urgently', created_at: now, updated_at: now },
      { client_id: C2, title: 'Updated CoA format requirements from client', status: 'pending', due_date: '2026-03-08', category: 'Documentation', notes: 'QC team to update format template', created_at: now, updated_at: now },
      { client_id: C3, title: 'COSMOS certification process for organic face cream', status: 'pending', due_date: '2026-03-12', category: 'Regulatory', notes: 'RA team assigned — timeline to be shared', created_at: now, updated_at: now },
      { client_id: C3, title: 'Fragrance allergen declaration requirements', status: 'done', due_date: '2026-02-12', category: 'Labelling', notes: 'Resolved — allergen list shared with client', created_at: now, updated_at: now },
      { client_id: C4, title: 'Sunscreen OTC classification India — regulatory status', status: 'overdue', due_date: '2026-02-19', category: 'Regulatory', notes: 'Client escalation — CRITICAL — RA director to handle', created_at: now, updated_at: now },
      { client_id: C4, title: 'CDSCO notification status update requested', status: 'overdue', due_date: '2026-02-21', category: 'Regulatory', notes: 'RA team to send update by EOD', created_at: now, updated_at: now },
      { client_id: C4, title: 'Annual contract pricing — 5-SKU derma range', status: 'pending', due_date: '2026-03-08', category: 'Pricing', notes: 'BD approval required before sharing', created_at: now, updated_at: now },
      { client_id: C5, title: 'SPF 50+ water resistant formula brief', status: 'new', due_date: '2026-03-10', category: 'New Brief', notes: 'Brief received — assigning R&D lead', created_at: now, updated_at: now },
      { client_id: C5, title: 'Eco-friendly laminate tube options query', status: 'pending', due_date: '2026-03-05', category: 'Packaging', notes: 'PM team to share eco-tube comparison', created_at: now, updated_at: now },
      { client_id: C6, title: 'Vegan certification process for lip gloss range', status: 'pending', due_date: '2026-03-15', category: 'Regulatory', notes: 'New client onboarding — RA to guide', created_at: now, updated_at: now },
      { client_id: C7, title: 'New brief — beard oil 3-variant range', status: 'new', due_date: '2026-03-12', category: 'New Brief', notes: 'Brief under internal review', created_at: now, updated_at: now },
      { client_id: C7, title: 'Anti-ageing face wash INCI list clarification', status: 'overdue', due_date: '2026-02-22', category: 'Labelling', notes: 'R&D to update INCI and share with client', created_at: now, updated_at: now },
      { client_id: C8, title: 'Body butter formula — cocoa butter new brief', status: 'pending', due_date: '2026-03-18', category: 'New Brief', notes: 'R&D review meeting scheduled', created_at: now, updated_at: now },
    ]);

    await ClientDevelopment.bulkCreate([
      { client_id: C1, pr_code: 'PR-SUN-0042', name: 'SPF 30 Sunscreen Lotion 50g Tube', stage: 'R&D Closure', status: 'overdue', due_date: '2026-02-15', phase: 'Formula Lock', created_at: now, updated_at: now },
      { client_id: C1, pr_code: 'PR-SKN-0088', name: 'Vitamin C Brightening Serum 15%', stage: 'Scale-up Trial', status: 'inprog', due_date: '2026-03-10', phase: 'Pilot Batch', created_at: now, updated_at: now },
      { client_id: C1, pr_code: 'PR-SKN-0091', name: 'Retinol Night Cream 0.3%', stage: 'R&D Stage', status: 'inprog', due_date: '2026-04-01', phase: 'Formula Dev', created_at: now, updated_at: now },
      { client_id: C2, pr_code: 'PR-HAR-0031', name: 'Keratin Smoothing Shampoo 500mL', stage: 'BMR Ready', status: 'done', due_date: '2026-02-01', phase: 'Production Ready', created_at: now, updated_at: now },
      { client_id: C2, pr_code: 'PR-HAR-0055', name: 'Scalp Care Caffeine Serum 100mL', stage: 'R&D Stage', status: 'inprog', due_date: '2026-04-15', phase: 'Trial 2', created_at: now, updated_at: now },
      { client_id: C2, pr_code: 'PR-HAR-0061', name: 'Anti-Hairfall Shampoo SF', stage: 'Brief Review', status: 'new', due_date: '2026-03-30', phase: 'Concept Stage', created_at: now, updated_at: now },
      { client_id: C3, pr_code: 'PR-ORG-0017', name: 'COSMOS Certified Hydrating Face Cream', stage: 'R&D Closure', status: 'inprog', due_date: '2026-03-20', phase: 'Stability Initiated', created_at: now, updated_at: now },
      { client_id: C3, pr_code: 'PR-ORG-0022', name: 'Natural SPF 20 Tinted Moisturiser', stage: 'R&D Stage', status: 'inprog', due_date: '2026-04-30', phase: 'Trial 1', created_at: now, updated_at: now },
      { client_id: C4, pr_code: 'PR-DRM-0009', name: 'Azelaic Acid 15% Gel', stage: 'Scale-up', status: 'inprog', due_date: '2026-03-12', phase: 'Pilot Batch', created_at: now, updated_at: now },
      { client_id: C4, pr_code: 'PR-DRM-0014', name: 'Niacinamide 10% Barrier Cream', stage: 'BMR Ready', status: 'inprog', due_date: '2026-03-05', phase: 'Production Slot', created_at: now, updated_at: now },
      { client_id: C4, pr_code: 'PR-DRM-0018', name: 'Salicylic Acid 2% Face Cleanser', stage: 'R&D Stage', status: 'pending', due_date: '2026-04-10', phase: 'Formula Dev', created_at: now, updated_at: now },
      { client_id: C5, pr_code: 'PR-SUN-0058', name: 'SPF 50+ Water Resistant Sports Spray', stage: 'R&D Stage', status: 'new', due_date: '2026-05-01', phase: 'Brief Review', created_at: now, updated_at: now },
      { client_id: C5, pr_code: 'PR-SUN-0063', name: 'Kids SPF 50 Gentle Lotion', stage: 'R&D Closure', status: 'inprog', due_date: '2026-03-25', phase: 'PR Preparation', created_at: now, updated_at: now },
      { client_id: C6, pr_code: 'PR-CLR-0003', name: 'Vegan Lip Gloss — 8 Shades', stage: 'R&D Stage', status: 'inprog', due_date: '2026-05-15', phase: 'Shade Development', created_at: now, updated_at: now },
      { client_id: C6, pr_code: 'PR-CLR-0007', name: 'Tinted BB Cream SPF 20', stage: 'Brief', status: 'new', due_date: '2026-06-01', phase: 'Brief Review', created_at: now, updated_at: now },
      { client_id: C7, pr_code: 'PR-MEN-0024', name: 'Activated Charcoal Face Wash', stage: 'BMR Ready', status: 'done', due_date: '2026-02-01', phase: 'Production', created_at: now, updated_at: now },
      { client_id: C7, pr_code: 'PR-MEN-0029', name: 'Beard Oil 3-Variant Range', stage: 'Brief', status: 'new', due_date: '2026-05-30', phase: 'Brief Review', created_at: now, updated_at: now },
      { client_id: C7, pr_code: 'PR-MEN-0031', name: 'SPF 20 Daily Moisturiser', stage: 'R&D Stage', status: 'inprog', due_date: '2026-04-20', phase: 'Trial 3', created_at: now, updated_at: now },
      { client_id: C8, pr_code: 'PR-BDY-0012', name: 'Shea Butter Body Lotion 200mL', stage: 'Scale-up', status: 'inprog', due_date: '2026-03-28', phase: 'Pilot Batch', created_at: now, updated_at: now },
      { client_id: C8, pr_code: 'PR-BDY-0015', name: 'Coffee Exfoliating Body Scrub', stage: 'R&D Stage', status: 'inprog', due_date: '2026-04-25', phase: 'Trial 2', created_at: now, updated_at: now },
      { client_id: C8, pr_code: 'PR-BDY-0019', name: 'Cocoa Butter Rich Body Butter', stage: 'Brief', status: 'new', due_date: '2026-05-20', phase: 'Brief Review', created_at: now, updated_at: now },
    ]);

    await ClientOrder.bulkCreate([
      { client_id: C1, product_name: 'SPF 30 Lotion 50g Tube', quantity: '50,000 units', status: 'inprog', due_date: '2026-03-05', batch_code: 'BT-2026-0301', created_at: now, updated_at: now },
      { client_id: C1, product_name: 'Vitamin C Serum 30mL', quantity: '20,000 units', status: 'pending', due_date: '2026-03-20', batch_code: 'TBD', created_at: now, updated_at: now },
      { client_id: C1, product_name: 'Moisturiser SPF15 100g', quantity: '30,000 units', status: 'done', due_date: '2026-02-01', batch_code: 'BT-2026-0188', created_at: now, updated_at: now },
      { client_id: C2, product_name: 'Keratin Shampoo 500mL', quantity: '1,00,000 units', status: 'inprog', due_date: '2026-03-15', batch_code: 'BT-2026-0312', created_at: now, updated_at: now },
      { client_id: C2, product_name: 'Conditioner 300mL', quantity: '50,000 units', status: 'overdue', due_date: '2026-02-22', batch_code: 'BT-2026-0215', created_at: now, updated_at: now },
      { client_id: C3, product_name: 'Aloe Vera Soothing Gel 150g', quantity: '15,000 units', status: 'done', due_date: '2026-01-30', batch_code: 'BT-2026-0142', created_at: now, updated_at: now },
      { client_id: C3, product_name: 'Rose Water Balancing Toner', quantity: '10,000 units', status: 'pending', due_date: '2026-03-25', batch_code: 'TBD', created_at: now, updated_at: now },
      { client_id: C4, product_name: 'Niacinamide Cream 50g', quantity: '25,000 units', status: 'inprog', due_date: '2026-03-08', batch_code: 'BT-2026-0318', created_at: now, updated_at: now },
      { client_id: C4, product_name: 'Moisturiser SPF 30 75g', quantity: '20,000 units', status: 'overdue', due_date: '2026-02-20', batch_code: 'BT-2026-0201', created_at: now, updated_at: now },
      { client_id: C4, product_name: 'Gentle Cleanser 100mL', quantity: '30,000 units', status: 'inprog', due_date: '2026-03-18', batch_code: 'BT-2026-0319', created_at: now, updated_at: now },
      { client_id: C5, product_name: 'SPF 30 Daily Lotion 100g', quantity: '40,000 units', status: 'done', due_date: '2026-02-05', batch_code: 'BT-2026-0198', created_at: now, updated_at: now },
      { client_id: C5, product_name: 'After-Sun Cooling Gel 150g', quantity: '20,000 units', status: 'inprog', due_date: '2026-03-22', batch_code: 'BT-2026-0322', created_at: now, updated_at: now },
      { client_id: C6, product_name: 'Matte Lipstick 6 shades', quantity: '8,000 units', status: 'done', due_date: '2026-01-25', batch_code: 'BT-2026-0128', created_at: now, updated_at: now },
      { client_id: C7, product_name: 'Charcoal Face Wash 100mL', quantity: '60,000 units', status: 'inprog', due_date: '2026-03-10', batch_code: 'BT-2026-0310', created_at: now, updated_at: now },
      { client_id: C8, product_name: 'Shea Butter Lotion 200mL', quantity: '25,000 units', status: 'inprog', due_date: '2026-03-30', batch_code: 'BT-2026-0330', created_at: now, updated_at: now },
      { client_id: C8, product_name: 'Coffee Body Scrub 200g', quantity: '15,000 units', status: 'pending', due_date: '2026-04-10', batch_code: 'TBD', created_at: now, updated_at: now },
    ]);

    await ClientAppointment.bulkCreate([
      { client_id: C1, title: 'Q2 Planning & Roadmap Call', appointment_date: '2026-03-03', appointment_time: '10:00 AM', type: 'Video Call', with_person: 'Rajeev Sharma', created_at: now, updated_at: now },
      { client_id: C1, title: 'SPF 50 Development Review', appointment_date: '2026-03-10', appointment_time: '3:00 PM', type: 'In-person', with_person: 'Nisha Patel + R&D', created_at: now, updated_at: now },
      { client_id: C2, title: 'Q1 Review & Q2 Forecast', appointment_date: '2026-03-01', appointment_time: '11:00 AM', type: 'Video Call', with_person: 'Mala Iyer', created_at: now, updated_at: now },
      { client_id: C2, title: 'Shampoo Formula Finalisation', appointment_date: '2026-03-12', appointment_time: '2:00 PM', type: 'In-person', with_person: 'Deepak Nair + R&D', created_at: now, updated_at: now },
      { client_id: C3, title: 'COSMOS Project Kickoff Call', appointment_date: '2026-03-05', appointment_time: '4:00 PM', type: 'Video Call', with_person: 'Shruti Jain', created_at: now, updated_at: now },
      { client_id: C4, title: 'Regulatory Escalation Call', appointment_date: '2026-03-01', appointment_time: '5:00 PM', type: 'Video Call', with_person: 'Dr. Anil Bose + Shalini Roy', created_at: now, updated_at: now },
      { client_id: C4, title: 'Annual Contract Negotiation', appointment_date: '2026-03-15', appointment_time: '10:30 AM', type: 'In-person', with_person: 'Dr. Anil Bose', created_at: now, updated_at: now },
      { client_id: C5, title: 'SPF 50+ Brief Discussion', appointment_date: '2026-03-04', appointment_time: '2:00 PM', type: 'Video Call', with_person: 'Vikram Sethi', created_at: now, updated_at: now },
      { client_id: C6, title: 'Onboarding & Lip Gloss Brief', appointment_date: '2026-03-02', appointment_time: '11:30 AM', type: 'Video Call', with_person: 'Neha Saxena', created_at: now, updated_at: now },
      { client_id: C7, title: 'Q2 Portfolio Planning Review', appointment_date: '2026-03-07', appointment_time: '3:30 PM', type: 'In-person', with_person: 'Arjun Malik', created_at: now, updated_at: now },
      { client_id: C8, title: 'Body Butter Brief Meeting', appointment_date: '2026-03-09', appointment_time: '10:00 AM', type: 'Video Call', with_person: 'Kavita Rao', created_at: now, updated_at: now },
    ]);

    console.log('Client Hub seed complete.');

    console.log('Seeding Items List (vendor pricing view: RM/PM in list with rates and tiers)...');
    await ItemListTier.destroy({ where: {} });
    await ItemListVendorRate.destroy({ where: {} });
    await ItemsList.destroy({ where: {} });
    const allRmCodes = (await RawMaterial.findAll({ attributes: ['code'], order: [['code']] })).map(r => r.code);
    const allPmCodes = (await PackMaterial.findAll({ attributes: ['code'], order: [['code']] })).map(p => p.code);
    const itemsListSeed = [];
    for (const code of allRmCodes) {
      const rmId = rmByCode.get(code);
      if (rmId) itemsListSeed.push({ type: 'RM', raw_material_id: rmId, pack_material_id: null, status: 'Active', created_at: now, updated_at: now });
    }
    for (const code of allPmCodes) {
      const pmId = pmByCode.get(code);
      if (pmId) itemsListSeed.push({ type: 'PM', raw_material_id: null, pack_material_id: pmId, status: 'Active', created_at: now, updated_at: now });
    }
    await ItemsList.bulkCreate(itemsListSeed);
    const vendors = await VendorClient.findAll({ where: { type: 'vendor' }, order: [['id']], attributes: ['id'] });
    const v1 = vendors[0]?.id;
    const v2 = vendors[1]?.id;
    const v3 = vendors[2]?.id;
    const v4 = vendors[3]?.id;
    const rmIdToCode = new Map((await RawMaterial.findAll({ attributes: ['id', 'code'] })).map(r => [r.id, r.code]));
    const pmIdToCode = new Map((await PackMaterial.findAll({ attributes: ['id', 'code'] })).map(p => [p.id, p.code]));
    const itemsListRows = await ItemsList.findAll({ order: [['id']] });
    const ilByCode = new Map();
    itemsListRows.forEach((r) => {
      const code = r.raw_material_id ? rmIdToCode.get(r.raw_material_id) : (r.pack_material_id ? pmIdToCode.get(r.pack_material_id) : null);
      if (code) ilByCode.set(code, r);
    });
    const getIl = (code) => ilByCode.get(code);
    const validTill = '2026-03-31';
    const validTill2 = '2026-06-30';
    if (v1) {
      const ilUVF1 = getIl('EI-RM-UVF-001');
      if (ilUVF1) {
        const rate = await ItemListVendorRate.create({ items_list_id: ilUVF1.id, vendor_id: v1, default_rate: 520, default_moq: 1, currency: 'INR', status: 'active', created_at: now, updated_at: now });
        await ItemListTier.bulkCreate([
          { item_list_vendor_rate_id: rate.id, moq_min: 1, moq_max: null, price_per_unit: 520, valid_till: validTill, note: 'List price', created_at: now, updated_at: now },
          { item_list_vendor_rate_id: rate.id, moq_min: 25, moq_max: null, price_per_unit: 495, valid_till: validTill, note: 'Standard order', created_at: now, updated_at: now },
          { item_list_vendor_rate_id: rate.id, moq_min: 50, moq_max: null, price_per_unit: 475, valid_till: validTill, note: 'Bulk order', created_at: now, updated_at: now },
          { item_list_vendor_rate_id: rate.id, moq_min: 100, moq_max: null, price_per_unit: 455, valid_till: validTill, note: 'Contract price', created_at: now, updated_at: now },
        ]);
      }
      if (v2) {
        const ilUVF1Alt = getIl('EI-RM-UVF-001');
        if (ilUVF1Alt) {
          const rate2 = await ItemListVendorRate.create({ items_list_id: ilUVF1Alt.id, vendor_id: v2, default_rate: 510, default_moq: 25, currency: 'INR', status: 'active', created_at: now, updated_at: now });
          await ItemListTier.bulkCreate([
            { item_list_vendor_rate_id: rate2.id, moq_min: 25, moq_max: null, price_per_unit: 510, valid_till: validTill2, note: 'Alternate vendor', created_at: now, updated_at: now },
            { item_list_vendor_rate_id: rate2.id, moq_min: 50, moq_max: null, price_per_unit: 490, valid_till: validTill2, note: '', created_at: now, updated_at: now },
          ]);
        }
      }
      const ilACT2 = getIl('EI-RM-ACT-002');
      if (ilACT2) {
        const rate = await ItemListVendorRate.create({ items_list_id: ilACT2.id, vendor_id: v1, default_rate: 1450, default_moq: 1, currency: 'INR', status: 'active', created_at: now, updated_at: now });
        await ItemListTier.bulkCreate([
          { item_list_vendor_rate_id: rate.id, moq_min: 1, moq_max: null, price_per_unit: 1450, valid_till: validTill, note: 'List price', created_at: now, updated_at: now },
          { item_list_vendor_rate_id: rate.id, moq_min: 25, moq_max: null, price_per_unit: 1380, valid_till: validTill, note: 'Standard', created_at: now, updated_at: now },
          { item_list_vendor_rate_id: rate.id, moq_min: 50, moq_max: null, price_per_unit: 1300, valid_till: validTill, note: 'Bulk', created_at: now, updated_at: now },
        ]);
      }
      if (v3 && ilACT2) {
        const rate3 = await ItemListVendorRate.create({ items_list_id: ilACT2.id, vendor_id: v3, default_rate: 1420, default_moq: 10, currency: 'INR', status: 'active', created_at: now, updated_at: now });
        await ItemListTier.bulkCreate([
          { item_list_vendor_rate_id: rate3.id, moq_min: 10, moq_max: null, price_per_unit: 1420, valid_till: validTill2, note: 'Alternate vendor — China origin', created_at: now, updated_at: now },
          { item_list_vendor_rate_id: rate3.id, moq_min: 50, moq_max: null, price_per_unit: 1350, valid_till: validTill2, note: '', created_at: now, updated_at: now },
        ]);
      }
      const ilSURF1 = getIl('EI-RM-SURF-001');
      if (ilSURF1) {
        const rate = await ItemListVendorRate.create({ items_list_id: ilSURF1.id, vendor_id: v1, default_rate: 125, default_moq: 50, currency: 'INR', status: 'active', created_at: now, updated_at: now });
        await ItemListTier.bulkCreate([
          { item_list_vendor_rate_id: rate.id, moq_min: 50, moq_max: null, price_per_unit: 125, valid_till: validTill, note: 'Standard order (50KG drum)', created_at: now, updated_at: now },
          { item_list_vendor_rate_id: rate.id, moq_min: 150, moq_max: null, price_per_unit: 115, valid_till: validTill, note: 'Full tanker lot', created_at: now, updated_at: now },
          { item_list_vendor_rate_id: rate.id, moq_min: 500, moq_max: null, price_per_unit: 108, valid_till: validTill, note: 'Annual contract price', created_at: now, updated_at: now },
        ]);
      }
      const ilACT3 = getIl('EI-RM-ACT-003');
      if (ilACT3) {
        const rate = await ItemListVendorRate.create({ items_list_id: ilACT3.id, vendor_id: v1, default_rate: 4800, default_moq: 1, currency: 'INR', status: 'active', created_at: now, updated_at: now });
        await ItemListTier.bulkCreate([
          { item_list_vendor_rate_id: rate.id, moq_min: 1, moq_max: null, price_per_unit: 4800, valid_till: validTill, note: 'List price', created_at: now, updated_at: now },
          { item_list_vendor_rate_id: rate.id, moq_min: 5, moq_max: null, price_per_unit: 4600, valid_till: validTill, note: 'Standard', created_at: now, updated_at: now },
          { item_list_vendor_rate_id: rate.id, moq_min: 10, moq_max: null, price_per_unit: 4400, valid_till: validTill, note: 'Bulk discount', created_at: now, updated_at: now },
        ]);
      }
    }
    if (v4) {
      const ilTUB = getIl('EI-PM-TUB-001');
      if (ilTUB) {
        const rate = await ItemListVendorRate.create({ items_list_id: ilTUB.id, vendor_id: v4, default_rate: 4.2, default_moq: 5000, currency: 'INR', status: 'active', created_at: now, updated_at: now });
        await ItemListTier.bulkCreate([
          { item_list_vendor_rate_id: rate.id, moq_min: 5000, moq_max: null, price_per_unit: 4.2, valid_till: validTill2, note: 'Standard MOQ', created_at: now, updated_at: now },
          { item_list_vendor_rate_id: rate.id, moq_min: 10000, moq_max: null, price_per_unit: 3.95, valid_till: validTill2, note: '10K+ discount', created_at: now, updated_at: now },
          { item_list_vendor_rate_id: rate.id, moq_min: 25000, moq_max: null, price_per_unit: 3.7, valid_till: validTill2, note: '25K+ bulk', created_at: now, updated_at: now },
        ]);
      }
      const ilBTL = getIl('EI-PM-BTL-001');
      if (ilBTL) {
        const rate = await ItemListVendorRate.create({ items_list_id: ilBTL.id, vendor_id: v4, default_rate: 5.5, default_moq: 2500, currency: 'INR', status: 'active', created_at: now, updated_at: now });
        await ItemListTier.bulkCreate([
          { item_list_vendor_rate_id: rate.id, moq_min: 2500, moq_max: null, price_per_unit: 5.5, valid_till: validTill2, note: 'Standard MOQ', created_at: now, updated_at: now },
          { item_list_vendor_rate_id: rate.id, moq_min: 5000, moq_max: null, price_per_unit: 5.2, valid_till: validTill2, note: '5K+ discount', created_at: now, updated_at: now },
          { item_list_vendor_rate_id: rate.id, moq_min: 10000, moq_max: null, price_per_unit: 4.9, valid_till: validTill2, note: '10K+ bulk', created_at: now, updated_at: now },
        ]);
      }
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

    console.log('Seeding Sales Orders and Purchase Orders...');
    await SalesOrder.destroy({ where: {} });
    await PurchaseOrder.destroy({ where: {} });
    await SalesOrder.bulkCreate([
      {
        order_id: 'SO-001',
        customer_name: 'Glow Cosmetics Pvt Ltd',
        branch: 'Branch A',
        order_date: '2026-02-01',
        expected_shipment_date: '2026-02-15',
        reference: 'REF-SO-001',
        payment_terms: 'NET 30',
        status: 'Confirmed',
        order_status: { orderStatus: 'Confirmed', invoiced: 'pending', payment: 'pending', packed: 'pending', shipped: 'pending', deliveryMethod: 'road' },
        form_data: { customerName: 'Glow Cosmetics Pvt Ltd', orderId: 'SO-001', orderDate: '2026-02-01', expectedShipmentDate: '2026-02-15', paymentTerms: 'NET 30' },
        items: [{ itemName: 'EI Sunscreen Lotion SPF50+ PA++++', product_code: 'EI-PR-00001', quantity: 10000, rate: '499', tax: '18' }],
        created_at: now,
        updated_at: now,
      },
      {
        order_id: 'SO-002',
        customer_name: 'Glow Cosmetics Pvt Ltd',
        branch: 'Branch A',
        order_date: '2026-02-01',
        expected_shipment_date: '2026-02-20',
        reference: 'REF-SO-002',
        payment_terms: 'NET 30',
        status: 'In Production',
        order_status: { orderStatus: 'In Production', invoiced: 'pending', payment: 'pending', packed: 'pending', shipped: 'pending', deliveryMethod: 'road' },
        form_data: { customerName: 'Glow Cosmetics Pvt Ltd', orderId: 'SO-002', orderDate: '2026-02-01', expectedShipmentDate: '2026-02-20', paymentTerms: 'NET 30' },
        items: [{ itemName: 'EI Gentle Foaming Facewash 150ml', product_code: 'EI-PR-00002', quantity: 10000, rate: '299', tax: '18' }],
        created_at: now,
        updated_at: now,
      },
      {
        order_id: 'SO-003',
        customer_name: 'SkinFirst Brands LLP',
        branch: 'Branch B',
        order_date: '2026-02-05',
        expected_shipment_date: '2026-02-20',
        reference: 'REF-SO-003',
        payment_terms: 'NET 30',
        status: 'Confirmed',
        order_status: { orderStatus: 'Confirmed', invoiced: 'pending', payment: 'pending', packed: 'pending', shipped: 'pending', deliveryMethod: 'road' },
        form_data: { customerName: 'SkinFirst Brands LLP', orderId: 'SO-003', orderDate: '2026-02-05', expectedShipmentDate: '2026-02-20', paymentTerms: 'NET 30' },
        items: [{ itemName: 'EI Sunscreen Lotion SPF50+ PA++++', product_code: 'EI-PR-00001', quantity: 5000, rate: '499', tax: '18' }],
        created_at: now,
        updated_at: now,
      },
      {
        order_id: 'SO-004',
        customer_name: 'SkinFirst Brands LLP',
        branch: 'Branch B',
        order_date: '2026-02-05',
        expected_shipment_date: '2026-02-25',
        reference: 'REF-SO-004',
        payment_terms: 'NET 30',
        status: 'Planning',
        order_status: { orderStatus: 'Planning', invoiced: 'pending', payment: 'pending', packed: 'pending', shipped: 'pending', deliveryMethod: 'road' },
        form_data: { customerName: 'SkinFirst Brands LLP', orderId: 'SO-004', orderDate: '2026-02-05', expectedShipmentDate: '2026-02-25', paymentTerms: 'NET 30' },
        items: [{ itemName: 'EI Gentle Foaming Facewash 150ml', product_code: 'EI-PR-00002', quantity: 5000, rate: '299', tax: '18' }],
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
      // Planning PR-extracted SOs (referenced by planning_extracted) — match HTML (50,000 / 30,000 / 40,000 / 50,000 units)
      { order_id: 'EI-SO-2026-001', customer_name: 'Planning Client A', branch: 'Branch A', order_date: '2026-02-10', expected_shipment_date: '2026-03-20', reference: 'REF-PLN-001', payment_terms: 'NET 30', status: 'Planning', order_status: { orderStatus: 'Planning', invoiced: 'pending', payment: 'pending', packed: 'pending', shipped: 'pending', deliveryMethod: 'road' }, form_data: {}, items: [{ itemName: 'EI Gentle Foaming Facewash', product_code: 'EI-FG-001', quantity: 50000, rate: '299', tax: '18' }], created_at: now, updated_at: now },
      { order_id: 'EI-SO-2026-002', customer_name: 'Planning Client B', branch: 'Branch A', order_date: '2026-02-12', expected_shipment_date: '2026-04-05', reference: 'REF-PLN-002', payment_terms: 'NET 30', status: 'Planning', order_status: { orderStatus: 'Planning', invoiced: 'pending', payment: 'pending', packed: 'pending', shipped: 'pending', deliveryMethod: 'road' }, form_data: {}, items: [{ itemName: 'EI Invisible Sunscreen SPF50', product_code: 'EI-FG-002', quantity: 30000, rate: '399', tax: '18' }], created_at: now, updated_at: now },
      { order_id: 'EI-SO-2026-003', customer_name: 'Planning Client C', branch: 'Branch B', order_date: '2026-02-15', expected_shipment_date: '2026-04-25', reference: 'REF-PLN-003', payment_terms: 'NET 30', status: 'Planning', order_status: { orderStatus: 'Planning', invoiced: 'pending', payment: 'pending', packed: 'pending', shipped: 'pending', deliveryMethod: 'road' }, form_data: {}, items: [{ itemName: 'EI Hydra-Boost Moisturiser', product_code: 'EI-FG-003', quantity: 40000, rate: '349', tax: '18' }], created_at: now, updated_at: now },
      { order_id: 'EI-SO-2026-004', customer_name: 'Planning Client D', branch: 'Branch B', order_date: '2026-02-18', expected_shipment_date: '2026-05-10', reference: 'REF-PLN-004', payment_terms: 'NET 30', status: 'Planning', order_status: { orderStatus: 'Planning', invoiced: 'pending', payment: 'pending', packed: 'pending', shipped: 'pending', deliveryMethod: 'road' }, form_data: {}, items: [{ itemName: 'EI Keratin Repair Conditioner', product_code: 'EI-FG-004', quantity: 50000, rate: '279', tax: '18' }], created_at: now, updated_at: now },
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
      { order_id: 'EI-PO-2025-001', vendor_name: 'Chemspec India Pvt Ltd', branch: 'Branch A', order_date: '2025-11-15', expected_shipment_date: '2025-11-20', reference: 'REF-UV-001', payment_terms: 'NET 30', status: 'Submitted', order_status: {}, form_data: {}, items: [{ itemName: 'Homosalate', quantity: 60, rate: '520' }, { itemName: 'Octinoxate', quantity: 50, rate: '600' }, { itemName: 'Octocrylene', quantity: 80, rate: '590' }], created_at: now, updated_at: now },
      { order_id: 'EI-PO-2025-002', vendor_name: 'Chemspec India', branch: 'Branch A', order_date: '2025-11-18', expected_shipment_date: '2025-11-22', reference: 'REF-SURF-002', payment_terms: 'NET 30', status: 'Submitted', order_status: {}, form_data: {}, items: [{ itemName: 'SLES 70%', quantity: 150, rate: '125' }, { itemName: 'CAPB 35%', quantity: 80, rate: '195' }, { itemName: 'SCI', quantity: 100, rate: '250' }], created_at: now, updated_at: now },
      { order_id: 'EI-PO-2025-003', vendor_name: 'Packwell Industries', branch: 'Branch B', order_date: '2025-11-20', expected_shipment_date: '2025-11-25', reference: 'REF-PKG-003', payment_terms: 'NET 30', status: 'Submitted', order_status: {}, form_data: {}, items: [{ itemName: 'HDPE Bottles 100ml', quantity: 5000, rate: '8' }, { itemName: 'Caps & Closures', quantity: 5000, rate: '2' }, { itemName: 'Labels 100x50', quantity: 10000, rate: '1.5' }], created_at: now, updated_at: now },
      { order_id: 'EI-PO-2025-004', vendor_name: 'Packwell Industries', branch: 'Branch B', order_date: '2025-11-22', expected_shipment_date: '2025-11-28', reference: 'REF-PKG-004', payment_terms: 'NET 30', status: 'Submitted', order_status: {}, form_data: {}, items: [{ itemName: 'PET Bottles 500ml', quantity: 2000, rate: '15' }, { itemName: 'Carton Boxes', quantity: 500, rate: '25' }], created_at: now, updated_at: now },
    ]);

    // Planning PR phase: SO data lives in sales_orders; planning_extracted references it by sales_order_id (FK). Data matches HTML PRs Extracted.
    console.log('Seeding Planning Extracted (PR extracted tab)...');
    await PlanningExtracted.destroy({ where: {} });
    const planSOs = await SalesOrder.findAll({ where: { order_id: ['EI-SO-2026-001', 'EI-SO-2026-002', 'EI-SO-2026-003', 'EI-SO-2026-004'] }, order: [['order_id']] });
    const planProds = await Product.findAll({ where: { product_code: ['EI-FG-001', 'EI-FG-002', 'EI-FG-003', 'EI-FG-004'] }, order: [['product_code']] });
    const planRmAll = await RawMaterial.findAll({ attributes: ['id', 'code', 'name', 'inci'] });
    const planPmAll = await PackMaterial.findAll({ attributes: ['id', 'code', 'description'] });
    const planRmById = (code) => { const r = planRmAll.find((x) => x.code === code); return r ? r.id : null; };
    const planRmByNameOrInci = (name) => { const r = planRmAll.find((x) => x.name === name || x.inci === name); return r ? r.id : null; };
    const planPmByCode = (code) => { const p = planPmAll.find((x) => x.code === code); return p ? p.id : null; };
    const planPmByDesc = (desc) => { const p = planPmAll.find((x) => x.description === desc || (desc && x.description && x.description.includes(desc))); return p ? p.id : null; };
    const rmL = (name, quantity, unit, code) => ({ raw_material_id: code ? planRmById(code) : planRmByNameOrInci(name), name, quantity, unit, percentage: 100 });
    const pmL = (name, quantity, unit, value, code) => ({ pack_material_id: code ? planPmByCode(code) : planPmByDesc(name), name, quantity, unit, value: value || 0, percentage: 100 });

    if (planSOs.length === 4 && planProds.length === 4) {
      // Facewash — 12 RM, 4 PM (HTML); BOM confirmed, 15 batches planned
      const facewashRm = [
        rmL('Aqua', 5153, 'KG', 'EI-RM-BASE-001'),
        rmL('Sodium Laureth Sulfate', 900, 'KG', 'EI-RM-SURF-001'),
        rmL('Cocamidopropyl Betaine', 375, 'KG', 'EI-RM-SURF-002'),
        rmL('Sodium Cocoyl Isethionate', 300, 'KG', 'EI-RM-SURF-003'),
        rmL('Glycerin', 225, 'KG', 'EI-RM-ACT-001'),
        rmL('Aloe Barbadensis Leaf Juice', 150, 'KG', null),
        rmL('Niacinamide', 150, 'KG', 'EI-RM-ACT-002'),
        rmL('Carbomer', 23, 'KG', 'EI-RM-POLY-001'),
        rmL('Phenoxyethanol', 60, 'KG', 'EI-RM-PRES-001'),
        rmL('Sodium Hydroxide', 38, 'KG', 'EI-RM-EXCIP-001'),
        rmL('Citric Acid Monohydrate', 15, 'KG', 'EI-RM-EXCIP-002'),
        rmL('Parfum', 38, 'KG', 'EI-RM-FRAG-002'),
      ];
      const facewashPm = [
        pmL('150ml Transparent PET Pump Bottle', 50000, 'PCS', 1.43, 'EI-PM-BTL-001'),
        pmL('24/410 Lotion Pump White', 50000, 'PCS', 2, 'EI-PM-PMP-001'),
        pmL('Facewash Front Label 100×80mm', 50000, 'PCS', 1.8, 'EI-PM-LBL-001'),
        pmL('Facewash 150ml Monocarton', 50000, 'PCS', 1.5, 'EI-PM-BOX-002'),
      ];
      // Sunscreen — 16 RM, 2 PM; BOM Pending
      const sunscreenRm = [
        rmL('Aqua', 788, 'KG', 'EI-RM-BASE-001'),
        rmL('Glycerin', 45, 'KG', 'EI-RM-ACT-001'),
        rmL('Butylene Glycol', 45, 'KG', 'EI-RM-HUM-001'),
        rmL('Homosalate', 150, 'KG', 'EI-RM-UVF-005'),
        rmL('Ethylhexyl Methoxycinnamate', 113, 'KG', 'EI-RM-UVF-001'),
        rmL('Octocrylene', 75, 'KG', 'EI-RM-UVF-006'),
        rmL('Butyl Methoxydibenzoylmethane', 45, 'KG', 'EI-RM-UVF-004'),
        rmL('PEG-100 Stearate/Glyceryl Stearate', 53, 'KG', 'EI-RM-EMUL-004'),
        rmL('Stearic Acid', 23, 'KG', 'EI-RM-EMUL-003'),
        rmL('Isohexadecane', 38, 'KG', 'EI-RM-SOLV-001'),
        rmL('Cyclopentasiloxane', 30, 'KG', 'EI-RM-SOLV-002'),
        rmL('Titanium Dioxide (nano)', 30, 'KG', 'EI-RM-UVF-002'),
        rmL('Tocopheryl Acetate', 8, 'KG', 'EI-RM-ACT-005'),
        rmL('Niacinamide', 30, 'KG', 'EI-RM-ACT-002'),
        rmL('Phenoxyethanol', 12, 'KG', 'EI-RM-PRES-001'),
        rmL('Ethylhexylglycerin', 3, 'KG', 'EI-RM-PRES-002'),
      ];
      const sunscreenPm = [
        pmL('50g Laminated Tube White Matte', 30000, 'PCS', 4.5, 'EI-PM-TUB-002'),
        pmL('Sunscreen 50g Monocarton Premium', 30000, 'PCS', 2.8, 'EI-PM-BOX-001'),
      ];
      // Moisturiser — 17 RM, 3 PM; BOM Pending
      const moisturiserRm = [
        rmL('Aqua', 1260, 'KG', 'EI-RM-BASE-001'),
        rmL('Glycerin', 100, 'KG', 'EI-RM-ACT-001'),
        rmL('Butylene Glycol', 60, 'KG', 'EI-RM-HUM-001'),
        rmL('Cetearyl Alcohol', 80, 'KG', 'EI-RM-EMUL-001'),
        rmL('Ceteareth-20', 30, 'KG', 'EI-RM-EMUL-002'),
        rmL('Dimethicone', 40, 'KG', 'EI-RM-SILI-001'),
        rmL('Stearic Acid', 30, 'KG', 'EI-RM-EMUL-003'),
        rmL('Niacinamide', 100, 'KG', 'EI-RM-ACT-002'),
        rmL('Sodium Hyaluronate', 10, 'KG', 'EI-RM-ACT-007'),
        rmL('Ceramide NP', 4, 'KG', 'EI-RM-ACT-008'),
        rmL('Panthenol', 20, 'KG', 'EI-RM-ACT-009'),
        rmL('Centella Asiatica Extract', 20, 'KG', 'EI-RM-ACT-010'),
        rmL('Tocopheryl Acetate', 10, 'KG', 'EI-RM-ACT-005'),
        rmL('Phenoxyethanol', 16, 'KG', 'EI-RM-PRES-001'),
        rmL('Ethylhexylglycerin', 6, 'KG', 'EI-RM-PRES-002'),
        rmL('Citric Acid Monohydrate', 4, 'KG', 'EI-RM-EXCIP-002'),
        rmL('Parfum', 10, 'KG', 'EI-RM-FRAG-001'),
      ];
      const moisturiserPm = [
        pmL('50ml Acrylic PMMA Jar + Lid White', 40000, 'PCS', 8, 'EI-PM-JAR-001'),
        pmL('Moisturiser 50ml Monocarton Premium', 40000, 'PCS', 3, 'EI-PM-BOX-003'),
        pmL('Product Insert / IFU Leaflet A5', 40000, 'PCS', 0.5, 'EI-PM-LBL-002'),
      ];
      // Conditioner — 15 RM, 4 PM; BOM Pending, 1 batch (batch size not set)
      const conditionerRm = [
        rmL('Aqua', 7240, 'KG', 'EI-RM-BASE-001'),
        rmL('Cetrimonium Chloride', 300, 'KG', 'EI-RM-COND-001'),
        rmL('Guar Hydroxypropyltrimonium Chloride', 50, 'KG', 'EI-RM-COND-002'),
        rmL('Glycerin', 200, 'KG', 'EI-RM-ACT-001'),
        rmL('Behentrimonium Methosulfate/Cetearyl', 600, 'KG', 'EI-RM-COND-003'),
        rmL('Cocos Nucifera Oil', 200, 'KG', 'EI-RM-OIL-001'),
        rmL('Argania Spinosa Kernel Oil', 100, 'KG', 'EI-RM-OIL-002'),
        rmL('Amodimethicone', 200, 'KG', 'EI-RM-SILI-002'),
        rmL('Hydrolyzed Keratin', 200, 'KG', 'EI-RM-ACT-011'),
        rmL('Panthenol', 100, 'KG', 'EI-RM-ACT-009'),
        rmL('Niacinamide', 200, 'KG', 'EI-RM-ACT-002'),
        rmL('Tocopheryl Acetate', 50, 'KG', 'EI-RM-ACT-005'),
        rmL('Phenoxyethanol', 80, 'KG', 'EI-RM-PRES-001'),
        rmL('Citric Acid Monohydrate', 20, 'KG', 'EI-RM-EXCIP-002'),
        rmL('Parfum', 80, 'KG', 'EI-RM-FRAG-002'),
      ];
      const conditionerPm = [
        pmL('200ml HDPE Bottle White Oval', 50000, 'PCS', 6, 'EI-PM-BTL-002'),
        pmL('28/410 Disc Cap White', 50000, 'PCS', 1.2, 'EI-PM-CAP-002'),
        pmL('Conditioner 200ml Wrap Label 200×130mm', 50000, 'PCS', 0.8, 'EI-PM-LBL-003'),
        pmL('24-unit Shipper Master Carton', 50000, 'PCS', 25, 'EI-PM-BOX-004'),
      ];

      const bomConfirmedAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
      await PlanningExtracted.bulkCreate([
        { sales_order_id: planSOs[0].id, product_id: planProds[0].product_id, order_qty_display: '50,000 Units', total_kg_display: '7,500 KG', order_date: '2026-02-10', due_date: '2026-03-20', batch_size_display: '500 KG', batches_required: 15, bom_status: 'Production Released', approved_by: 'Amit Kumar', raw_materials: facewashRm, packaging_materials: facewashPm, color: 'pink', batch_count: 15, batch_size_kg: 500, bom_confirmed_at: bomConfirmedAt, created_at: now, updated_at: now },
        { sales_order_id: planSOs[1].id, product_id: planProds[1].product_id, order_qty_display: '30,000 Units', total_kg_display: '1,500 KG', order_date: '2026-02-12', due_date: '2026-04-05', batch_size_display: '300 KG', batches_required: 5, bom_status: 'Production Ready', approved_by: 'Amit Kumar', raw_materials: sunscreenRm, packaging_materials: sunscreenPm, color: 'orange', batch_count: 5, batch_size_kg: 300, created_at: now, updated_at: now },
        { sales_order_id: planSOs[2].id, product_id: planProds[2].product_id, order_qty_display: '40,000 Units', total_kg_display: '2,000 KG', order_date: '2026-02-15', due_date: '2026-04-25', batch_size_display: '200 KG', batches_required: 10, bom_status: 'In Progress', approved_by: 'Riya Shah', raw_materials: moisturiserRm, packaging_materials: moisturiserPm, color: 'blue', batch_count: 10, batch_size_kg: 200, created_at: now, updated_at: now },
        { sales_order_id: planSOs[3].id, product_id: planProds[3].product_id, order_qty_display: '50,000 Units', total_kg_display: '10,000 KG', order_date: '2026-02-18', due_date: '2026-05-10', batch_size_display: 'Not set — 1 batch', batches_required: 1, bom_status: 'Planned', approved_by: 'Riya Shah', raw_materials: conditionerRm, packaging_materials: conditionerPm, color: 'purple', batch_count: 1, batch_size_kg: null, created_at: now, updated_at: now },
      ]);
    }

    // Procurement Requests — reference planning_extracted (which references sales_orders); items reference RM/PM/PR/FG by ID
    console.log('Seeding Procurement Requests...');
    await ProcurementRequest.destroy({ where: {} });
    const planRows = await PlanningExtracted.findAll({ order: [['id', 'ASC']], limit: 2 });
    const prRms = await RawMaterial.findAll({ attributes: ['id', 'code', 'name'], order: [['id', 'ASC']], limit: 5 });
    const prPms = await PackMaterial.findAll({ attributes: ['id', 'code', 'description'], order: [['id', 'ASC']], limit: 4 });
    if (planRows.length > 0 && prRms.length > 0 && prPms.length > 0) {
      const prItems1 = [
        ...prRms.slice(0, 3).map((r) => ({ type: 'RM', raw_material_id: r.id, quantity_requested: 500, unit: 'KG', line_notes: '', code: r.code, name: r.name })),
        ...prPms.slice(0, 2).map((p) => ({ type: 'PM', pack_material_id: p.id, quantity_requested: 10000, unit: 'PCS', line_notes: '', code: p.code, name: p.description || p.code })),
      ];
      const prItems2 = [
        { type: 'RM', raw_material_id: prRms[0].id, quantity_requested: 200, unit: 'KG', line_notes: 'Urgent', code: prRms[0].code, name: prRms[0].name },
        { type: 'PM', pack_material_id: prPms[0].id, quantity_requested: 5000, unit: 'PCS', line_notes: '', code: prPms[0].code, name: prPms[0].description || prPms[0].code },
      ];
      await ProcurementRequest.bulkCreate([
        { planning_extracted_id: planRows[0].id, priority: 'High', required_by_date: '2026-03-15', notes: 'Shortage for EI-SO-2026-001', items: prItems1, status: 'Pending', requested_by: 'planning@example.com', created_at: now, updated_at: now },
        { planning_extracted_id: planRows[0].id, priority: 'Medium', required_by_date: '2026-03-20', notes: 'Follow-up PR', items: prItems2, status: 'Pending', requested_by: 'planning@example.com', created_at: now, updated_at: now },
      ]);
      // Procurement Quotations — vendor quotes against procurement requests (mock data from Procurement Operations Hub reference)
      console.log('Seeding Procurement Quotations...');
      await ProcurementQuotation.destroy({ where: {} });
      const prList = await ProcurementRequest.findAll({ order: [['id', 'ASC']], limit: 2 });
      const quotVendors = await VendorClient.findAll({ where: { type: 'vendor' }, order: [['id', 'ASC']], attributes: ['id', 'name'], limit: 5 });
      if (prList.length >= 2 && quotVendors.length >= 3) {
        const [chemspec, sigma] = quotVendors;
        // QT-001 & QT-002: quote for first PR — same 3 RMs as prItems1 (prRms[0..2]); link by raw_material_id and code/name
        const qt1Items = [
          { raw_material_id: prRms[0].id, itemId: prRms[0].code, name: prRms[0].name, orderQty: 100, pricePerUnit: 490, uom: 'KG', totalValue: 49000 },
          { raw_material_id: prRms[1].id, itemId: prRms[1].code, name: prRms[1].name, orderQty: 75, pricePerUnit: 645, uom: 'KG', totalValue: 48375 },
          { raw_material_id: prRms[2].id, itemId: prRms[2].code, name: prRms[2].name, orderQty: 80, pricePerUnit: 560, uom: 'KG', totalValue: 44800 },
        ];
        const qt2Items = [
          { raw_material_id: prRms[0].id, itemId: prRms[0].code, name: prRms[0].name, orderQty: 100, pricePerUnit: 510, uom: 'KG', totalValue: 51000 },
          { raw_material_id: prRms[1].id, itemId: prRms[1].code, name: prRms[1].name, orderQty: 75, pricePerUnit: 660, uom: 'KG', totalValue: 49500 },
          { raw_material_id: prRms[2].id, itemId: prRms[2].code, name: prRms[2].name, orderQty: 80, pricePerUnit: 575, uom: 'KG', totalValue: 46000 },
        ];
        // QT-003: quote for second PR — same 1 RM + 1 PM as prItems2; link by raw_material_id / pack_material_id
        const qt3Items = [
          { raw_material_id: prRms[0].id, itemId: prRms[0].code, name: prRms[0].name, orderQty: 200, pricePerUnit: 87.5, uom: 'KG', totalValue: 17500 },
          { pack_material_id: prPms[0].id, itemId: prPms[0].code, name: prPms[0].description || prPms[0].code, orderQty: 5000, pricePerUnit: 10.26, uom: 'PCS', totalValue: 51300 },
        ];
        const qt3Total = 17500 + 51300;
        await ProcurementQuotation.bulkCreate([
          { procurement_request_id: prList[0].id, vendor_id: chemspec.id, quote_date: '2026-02-17', quoted_by: 'Procurement — Ramesh', attachment_ref: 'QT-001-Chemspec-UV-Filters.pdf', attachment_status: 'received', items: qt1Items, lead_time_days: 18, payment_terms: '50% Advance, 50% Before Dispatch', valid_till: '2026-03-10', total_value: 142175, notes: 'Chemspec offering 5% discount on 100KG lot. UV-002 and UV-003 at standard 25 KG rates.', status: 'confirmed', created_at: now, updated_at: now },
          { procurement_request_id: prList[0].id, vendor_id: sigma.id, quote_date: '2026-02-18', quoted_by: 'Procurement — Ramesh', attachment_ref: 'QT-002-Sigma-UV-Filters.pdf', attachment_status: 'received', items: qt2Items, lead_time_days: 21, payment_terms: '60 days credit', valid_till: '2026-03-15', total_value: 146500, notes: 'Sigma offers 60-day credit; pricing 3% higher. Alternate vendor for backup.', status: 'not_selected', created_at: now, updated_at: now },
          { procurement_request_id: prList[1].id, vendor_id: chemspec.id, quote_date: '2026-02-19', quoted_by: 'Procurement — Ramesh', attachment_ref: 'QT-003-Chemspec-Carbomer.pdf', attachment_status: 'received', items: qt3Items, lead_time_days: 12, payment_terms: '30 days credit', valid_till: '2026-03-20', total_value: qt3Total, notes: 'Standard pricing. 12-day lead time confirmed by vendor.', status: 'confirmed', created_at: now, updated_at: now },
        ]);
        // Procurement-linked POs: one Released (PR-REQ-001), one Draft (PR-REQ-002) — so Issued POs and Draft POs tabs have linked data
        const requestCode1 = `PR-REQ-${String(prList[0].id).padStart(3, '0')}`;
        const requestCode2 = `PR-REQ-${String(prList[1].id).padStart(3, '0')}`;
        const vendorName = chemspec.name || 'Chemspec India Pvt Ltd';
        await PurchaseOrder.bulkCreate([
          {
            order_id: `PO-${requestCode1}`,
            vendor_name: vendorName,
            branch: 'Branch A',
            order_date: '2026-02-17',
            expected_shipment_date: '2026-03-10',
            reference: requestCode1,
            payment_terms: '50% Advance, 50% Before Dispatch',
            status: 'Released',
            order_status: {},
            form_data: { requestId: String(prList[0].id), requestCode: requestCode1 },
            items: qt1Items.map((i) => ({ itemName: i.name, quantity: i.orderQty, rate: String(i.pricePerUnit), tax: '18' })),
            created_at: now,
            updated_at: now,
          },
          {
            order_id: `DPO-${requestCode2}`,
            vendor_name: vendorName,
            branch: 'Branch A',
            order_date: '2026-02-19',
            expected_shipment_date: '2026-03-20',
            reference: requestCode2,
            payment_terms: '30 days credit',
            status: 'Draft',
            order_status: {},
            form_data: { requestId: String(prList[1].id), requestCode: requestCode2 },
            items: qt3Items.map((i) => ({ itemName: i.name, quantity: i.orderQty, rate: String(i.pricePerUnit), tax: '18' })),
            created_at: now,
            updated_at: now,
          },
        ]);
        await prList[0].update({ status: 'PO Released' });
        await prList[1].update({ status: 'PO Draft' });
      }
    }

    console.log('Seeding GRN (Goods Received Notes) for Inbound...');
    await GoodsReceivedNote.destroy({ where: {} });
    const grnPos = await PurchaseOrder.findAll({ where: { order_id: ['EI-PO-2025-001', 'EI-PO-2025-002', 'EI-PO-2025-003', 'EI-PO-2025-004'] }, order: [['order_id', 'ASC']] });
    const poIdByOrderId = {};
    grnPos.forEach((p) => { poIdByOrderId[p.order_id] = p.id; });
    const grnRms = await RawMaterial.findAll({ attributes: ['id', 'code'] });
    const grnPms = await PackMaterial.findAll({ attributes: ['id', 'code'] });
    const grnRmByCode = {};
    grnRms.forEach((r) => { grnRmByCode[r.code] = r.id; });
    const grnPmByCode = {};
    grnPms.forEach((p) => { grnPmByCode[p.code] = p.id; });
    const grnSeed = [
      { grn_no: 'EI-GRN-2025-001', purchase_order_id: poIdByOrderId['EI-PO-2025-001'], po_no: 'EI-PO-2025-001', vendor: 'Chemspec India Pvt Ltd', type: 'RM', items: 3, po_value: 312400, expected_date: '2025-11-20', received_date: '2025-11-19', assigned_to: 'Karan Nair (WH Supervisor)', qc_status: 'Passed', status: 'GRN Complete', invoice_no: 'CHEM-INV-2025-1112', invoice_amount: 312400, grn_date: '2025-11-20', line_items: [{ id: 'l1', raw_material_id: grnRmByCode['EI-RM-UVF-001'], poQty: 60, rcvdQty: 60, invoiceQty: 60, unitPrice: 520, qcStatus: 'Pass', qcBy: 'Meera QC' }, { id: 'l2', raw_material_id: grnRmByCode['EI-RM-UVF-002'], poQty: 50, rcvdQty: 50, invoiceQty: 50, unitPrice: 600, qcStatus: 'Pass', qcBy: 'Meera QC' }, { id: 'l3', raw_material_id: grnRmByCode['EI-RM-UVF-003'], poQty: 80, rcvdQty: 80, invoiceQty: 80, unitPrice: 590, qcStatus: 'Pass', qcBy: 'Meera QC' }], workflow_steps: ['PO Received', 'Qty Check', 'QC Inspection', 'Label Generation', 'Dispatch Ready'], created_at: now, updated_at: now },
      { grn_no: 'EI-GRN-2025-002', purchase_order_id: poIdByOrderId['EI-PO-2025-002'], po_no: 'EI-PO-2025-002', vendor: 'Chemspec India', type: 'RM', items: 3, po_value: 185600, expected_date: '2025-11-22', received_date: '2025-11-21', assigned_to: 'Ravi Kumar', qc_status: 'In Progress', status: 'Under GRN', invoice_no: 'CHEM-INV-2025-1115', invoice_amount: 185200, grn_date: '2025-11-22', line_items: [{ id: 'l4', raw_material_id: grnRmByCode['EI-RM-SURF-001'], poQty: 150, rcvdQty: 148, invoiceQty: 150, unitPrice: 125, qcStatus: 'Pass', qcBy: 'Meera QC' }, { id: 'l5', raw_material_id: grnRmByCode['EI-RM-SURF-002'], poQty: 80, rcvdQty: 82, invoiceQty: 80, unitPrice: 195, qcStatus: 'Pass', qcBy: 'Meera QC' }, { id: 'l6', raw_material_id: grnRmByCode['EI-RM-SURF-003'], poQty: 100, rcvdQty: 100, invoiceQty: 100, unitPrice: 250, qcStatus: 'Pass', qcBy: 'Meera QC' }], workflow_steps: ['PO Received', 'Qty Check', 'QC Inspection', 'Label Generation'], created_at: now, updated_at: now },
      { grn_no: 'EI-GRN-2025-003', purchase_order_id: poIdByOrderId['EI-PO-2025-003'], po_no: 'EI-PO-2025-003', vendor: 'Packwell Industries', type: 'PM', items: 3, po_value: 79250, expected_date: '2025-11-25', received_date: '2025-11-24', assigned_to: 'Santosh Kumar', qc_status: 'Passed', status: 'GRN Complete', invoice_no: 'PKW-INV-2025-1118', invoice_amount: 79250, grn_date: '2025-11-25', line_items: [{ id: 'l7', pack_material_id: grnPmByCode['EI-PM-BTL-001'], poQty: 5000, rcvdQty: 5000, invoiceQty: 5000, unitPrice: 8, qcStatus: 'Pass', qcBy: 'Ravi QC' }, { id: 'l8', pack_material_id: grnPmByCode['EI-PM-CAP-001'], poQty: 5000, rcvdQty: 5000, invoiceQty: 5000, unitPrice: 2, qcStatus: 'Pass', qcBy: 'Ravi QC' }, { id: 'l9', pack_material_id: grnPmByCode['EI-PM-LBL-001'], poQty: 10000, rcvdQty: 10000, invoiceQty: 10000, unitPrice: 1.5, qcStatus: 'Pass', qcBy: 'Ravi QC' }], workflow_steps: ['PO Received', 'Qty Check', 'QC Inspection', 'Label Generation', 'Dispatch Ready'], created_at: now, updated_at: now },
      { grn_no: 'EI-GRN-2025-004', purchase_order_id: poIdByOrderId['EI-PO-2025-004'], po_no: 'EI-PO-2025-004', vendor: 'Packwell Industries', type: 'PM', items: 2, po_value: 125600, expected_date: '2025-11-28', received_date: null, assigned_to: 'Unassigned', qc_status: 'Pending', status: 'In Transit', invoice_no: null, invoice_amount: null, grn_date: null, line_items: [{ id: 'l10', pack_material_id: grnPmByCode['EI-PM-BTL-001'], poQty: 2000, rcvdQty: 0, invoiceQty: 0, unitPrice: 15, qcStatus: 'Pending', qcBy: 'Pending' }, { id: 'l11', pack_material_id: grnPmByCode['EI-PM-BOX-001'], poQty: 500, rcvdQty: 0, invoiceQty: 0, unitPrice: 25, qcStatus: 'Pending', qcBy: 'Pending' }], workflow_steps: [], created_at: now, updated_at: now },
    ];
    await GoodsReceivedNote.bulkCreate(grnSeed);

    console.log('Seeding MRN (Material Request Notes)...');
    await MaterialRequestNote.destroy({ where: {} });
    const mrnRms = await RawMaterial.findAll({ attributes: ['id', 'code'] });
    const mrnPms = await PackMaterial.findAll({ attributes: ['id', 'code'] });
    const mrnRmByCode = {};
    mrnRms.forEach((r) => { mrnRmByCode[r.code] = r.id; });
    const mrnPmByCode = {};
    mrnPms.forEach((p) => { mrnPmByCode[p.code] = p.id; });
    const mrnSeed = [
      { mrn_no: 'EI-MRN-2025-001', requested_by: 'Batch Mfg — ML1', status: 'Completed', assigned_picker: '', transfer_team: '', notes: 'EI Sunscreen SPF50+ (BTH-SUN-001), 500 KG. Required: 2025-11-20', line_items: [
        { id: 'm1', raw_material_id: mrnRmByCode['EI-RM-BASE-001'], quantity: 261.5, unit: 'KG', notes: '' },
        { id: 'm2', raw_material_id: mrnRmByCode['EI-RM-ACT-001'], quantity: 15, unit: 'KG', notes: '' },
        { id: 'm3', raw_material_id: mrnRmByCode['EI-RM-UVF-001'], quantity: 50, unit: 'KG', notes: '' },
        { id: 'm4', raw_material_id: mrnRmByCode['EI-RM-UVF-002'], quantity: 37.5, unit: 'KG', notes: '' },
        { id: 'm5', raw_material_id: mrnRmByCode['EI-RM-UVF-003'], quantity: 40, unit: 'KG', notes: '' },
        { id: 'm6', raw_material_id: mrnRmByCode['EI-RM-UVF-004'], quantity: 15, unit: 'KG', notes: '' },
        { id: 'm7', raw_material_id: mrnRmByCode['EI-RM-EMUL-001'], quantity: 15, unit: 'KG', notes: '' },
        { id: 'm8', raw_material_id: mrnRmByCode['EI-RM-EMUL-002'], quantity: 10, unit: 'KG', notes: '' },
        { id: 'm9', raw_material_id: mrnRmByCode['EI-RM-ACT-005'], quantity: 2.5, unit: 'KG', notes: '' },
        { id: 'm10', raw_material_id: mrnRmByCode['EI-RM-ACT-002'], quantity: 10, unit: 'KG', notes: '' },
        { id: 'm11', raw_material_id: mrnRmByCode['EI-RM-ACT-003'], quantity: 5, unit: 'KG', notes: '' },
        { id: 'm12', raw_material_id: mrnRmByCode['EI-RM-PRES-001'], quantity: 4, unit: 'KG', notes: '' },
      ], created_at: now, updated_at: now },
      { mrn_no: 'EI-MRN-2025-002', requested_by: 'Batch Mfg — ML1', status: 'Picked', assigned_picker: 'Santosh Kumar', transfer_team: '', notes: 'EI Gentle Foaming Facewash (BTH-FW-001), 500 KG. Required: 2025-11-21', line_items: [
        { id: 'm13', raw_material_id: mrnRmByCode['EI-RM-SURF-001'], quantity: 65, unit: 'KG', notes: '' },
        { id: 'm14', raw_material_id: mrnRmByCode['EI-RM-SURF-002'], quantity: 40, unit: 'KG', notes: '' },
        { id: 'm15', raw_material_id: mrnRmByCode['EI-RM-SURF-003'], quantity: 15, unit: 'KG', notes: '' },
        { id: 'm16', raw_material_id: mrnRmByCode['EI-RM-BASE-001'], quantity: 200, unit: 'KG', notes: '' },
        { id: 'm17', raw_material_id: mrnRmByCode['EI-RM-POLY-002'], quantity: 5, unit: 'KG', notes: '' },
        { id: 'm18', raw_material_id: mrnRmByCode['EI-RM-ACT-006'], quantity: 10, unit: 'KG', notes: '' },
        { id: 'm19', raw_material_id: mrnRmByCode['EI-RM-ACT-002'], quantity: 10, unit: 'KG', notes: '' },
        { id: 'm20', raw_material_id: mrnRmByCode['EI-RM-PRES-001'], quantity: 4, unit: 'KG', notes: '' },
      ], created_at: now, updated_at: now },
      { mrn_no: 'EI-MRN-2025-003', requested_by: 'Packaging — ML2', status: 'In Transfer', assigned_picker: 'Ravi Kumar', transfer_team: '', notes: 'EI Sunscreen SPF50+ — Fill & Pack (BTH-SUN-001-PACK), 10,000 units. Required: 2025-11-22', line_items: [
        { id: 'm21', pack_material_id: mrnPmByCode['EI-PM-TUB-001'], quantity: 10000, unit: 'PCS', notes: '' },
        { id: 'm22', pack_material_id: mrnPmByCode['EI-PM-CAP-001'], quantity: 10000, unit: 'PCS', notes: '' },
        { id: 'm23', pack_material_id: mrnPmByCode['EI-PM-BOX-001'], quantity: 10000, unit: 'PCS', notes: '' },
      ], created_at: now, updated_at: now },
      { mrn_no: 'EI-MRN-2025-004', requested_by: 'Batch Mfg — ML2', status: 'Completed', assigned_picker: 'Karan Nair', transfer_team: '', notes: 'EI Gentle Foaming Facewash (BTH-FW-002), 500 KG. Required: 2025-11-17', line_items: [
        { id: 'm24', raw_material_id: mrnRmByCode['EI-RM-EMUL-001'], quantity: 8, unit: 'KG', notes: '' },
        { id: 'm25', raw_material_id: mrnRmByCode['EI-RM-EMUL-002'], quantity: 6, unit: 'KG', notes: '' },
      ], created_at: now, updated_at: now },
    ];
    await MaterialRequestNote.bulkCreate(mrnSeed);

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

    /* ── Production Equipment ── */
    console.log('Seeding Production Equipment...');
    await ProductionEquipment.destroy({ where: {} });
    await ProductionEquipment.bulkCreate([
      { equipment_id: 'MV-01', name: 'Manufacturing Vessel 01', category: 'manufacturing', capacity: 500, type: 'jacketed', homogenizer: true, process_types: ['hot', 'cold'], status: 'idle', created_at: now, updated_at: now },
      { equipment_id: 'MV-02', name: 'Manufacturing Vessel 02', category: 'manufacturing', capacity: 300, type: 'jacketed', homogenizer: true, process_types: ['hot', 'cold'], status: 'idle', created_at: now, updated_at: now },
      { equipment_id: 'MV-03', name: 'Manufacturing Vessel 03', category: 'manufacturing', capacity: 200, type: 'simple', homogenizer: false, process_types: ['cold'], status: 'idle', created_at: now, updated_at: now },
      { equipment_id: 'ST-01', name: 'Supporting Tank 01', category: 'manufacturing', capacity: 100, type: 'support', homogenizer: false, process_types: ['hot', 'cold'], status: 'idle', created_at: now, updated_at: now },
      { equipment_id: 'ST-02', name: 'Supporting Tank 02', category: 'manufacturing', capacity: 100, type: 'support', homogenizer: false, process_types: ['hot', 'cold'], status: 'idle', created_at: now, updated_at: now },
      { equipment_id: 'ST-03', name: 'Supporting Tank 03', category: 'manufacturing', capacity: 50, type: 'support', homogenizer: false, process_types: ['cold'], status: 'idle', created_at: now, updated_at: now },
      { equipment_id: 'FL-01', name: 'Filling Line 01 (Bottle)', category: 'filling', speed: 3000, type: 'bottle', compatible: ['bottle'], status: 'idle', created_at: now, updated_at: now },
      { equipment_id: 'FL-02', name: 'Filling Line 02 (Tube)', category: 'filling', speed: 2000, type: 'tube', compatible: ['tube'], status: 'idle', created_at: now, updated_at: now },
      { equipment_id: 'FL-03', name: 'Filling Line 03 (Jar)', category: 'filling', speed: 500, type: 'jar', compatible: ['jar'], status: 'idle', created_at: now, updated_at: now },
      { equipment_id: 'FL-04', name: 'Filling Line 04 (Manual)', category: 'filling', speed: 200, type: 'manual', compatible: ['bottle', 'tube', 'jar', 'sachet'], status: 'idle', created_at: now, updated_at: now },
      { equipment_id: 'PL-01', name: 'Packaging Line 01', category: 'packaging', speed: 4000, type: 'auto', supports: ['carton', 'label', 'shrink'], status: 'idle', created_at: now, updated_at: now },
      { equipment_id: 'PL-02', name: 'Packaging Line 02', category: 'packaging', speed: 2500, type: 'semi', supports: ['carton', 'label'], status: 'idle', created_at: now, updated_at: now },
      { equipment_id: 'SK-01', name: 'Shrink Wrap Station', category: 'packaging', speed: 1500, type: 'shrink', supports: ['shrink'], status: 'idle', created_at: now, updated_at: now },
    ]);

    /* ── Production Team Members ── */
    console.log('Seeding Production Team Members (empty — add via Team Management UI)...');
    await ProductionTeamMember.destroy({ where: {} });

    /* ── Production Batches (BMR / BPR) ── */
    console.log('Seeding Production Batches...');
    await ProductionBatch.destroy({ where: {} });
    await ProductionBatch.bulkCreate([
      {
        bmr_no: 'BMR-2026-001', bpr_no: 'BPR-2026-001', product_name: 'Gentle Foaming Facewash', sku: 'EI-FW-150',
        so_no: 'SO-2026-001', order_qty: 30000, batch_size: 500, batch_no: 'B-01', batch_index: 1, total_batches: 3,
        bmr_status: 'in_production', bpr_status: 'draft', color: 'teal',
        process_type: 'hot', homogenizer: true, main_vessel: 'MV-01', supporting_tanks: ['ST-01'],
        filling_line: 'FL-01', filling_type: 'bottle', packaging_line: 'PL-01', monocarton: true, shrink: false,
        team_bmr: ['T01', 'T02', 'T04'], team_bpr: ['T08', 'T10'], qc_officer_bmr: 'T05', qc_officer_bpr: 'T07',
        mfg_date: '2026-03-04', fill_date: '2026-03-08', pack_date: '2026-03-09', fg_date: '2026-03-10',
        rm_connect_date: '2026-03-02', pm_connect_date: '2026-03-06',
        rm_reserved: true, pm_reserved: false, rm_connected: true, pm_connected: false,
        dispensing_rm: [
          { code: 'RM-001', inci: 'Aqua (Water)', required: 350, dispensed: 350, done: true },
          { code: 'RM-002', inci: 'Sodium Laureth Sulfate', required: 75, dispensed: 75, done: true },
          { code: 'RM-003', inci: 'Cocamidopropyl Betaine', required: 40, dispensed: 40, done: true },
          { code: 'RM-004', inci: 'Glycerin', required: 25, dispensed: 25, done: true },
          { code: 'RM-005', inci: 'Fragrance', required: 10, dispensed: 10, done: true },
        ],
        dispensing_pm: [
          { code: 'PM-001', name: '150ml Bottle', required: 10000, dispensed: 0, done: false },
          { code: 'PM-002', name: 'Flip Cap', required: 10000, dispensed: 0, done: false },
          { code: 'PM-003', name: 'Label', required: 10000, dispensed: 0, done: false },
          { code: 'PM-004', name: 'Mono Carton', required: 10000, dispensed: 0, done: false },
        ],
        bulk_yield: null, fill_yield: null, fg_yield: null,
        bulk_batch_accepted: null, fill_batch_accepted: null, fg_batch_accepted: null,
        qc_specs: [], remarks: '', due_date: '2026-03-12',
        created_at: now, updated_at: now,
      },
      {
        bmr_no: 'BMR-2026-002', bpr_no: 'BPR-2026-002', product_name: 'Gentle Foaming Facewash', sku: 'EI-FW-150',
        so_no: 'SO-2026-001', order_qty: 30000, batch_size: 500, batch_no: 'B-02', batch_index: 2, total_batches: 3,
        bmr_status: 'scheduled', bpr_status: 'draft', color: 'teal',
        process_type: 'hot', homogenizer: true, main_vessel: 'MV-01', supporting_tanks: ['ST-01'],
        filling_line: 'FL-01', filling_type: 'bottle', packaging_line: 'PL-01', monocarton: true, shrink: false,
        team_bmr: ['T01', 'T02'], team_bpr: [], qc_officer_bmr: 'T05', qc_officer_bpr: '',
        mfg_date: '2026-03-06', fill_date: '2026-03-10', pack_date: '2026-03-11', fg_date: '2026-03-12',
        rm_connect_date: '2026-03-04', pm_connect_date: '2026-03-08',
        rm_reserved: true, pm_reserved: false, rm_connected: false, pm_connected: false,
        dispensing_rm: [
          { code: 'RM-001', inci: 'Aqua (Water)', required: 350, dispensed: 0, done: false },
          { code: 'RM-002', inci: 'Sodium Laureth Sulfate', required: 75, dispensed: 0, done: false },
          { code: 'RM-003', inci: 'Cocamidopropyl Betaine', required: 40, dispensed: 0, done: false },
        ],
        dispensing_pm: [
          { code: 'PM-001', name: '150ml Bottle', required: 10000, dispensed: 0, done: false },
          { code: 'PM-002', name: 'Flip Cap', required: 10000, dispensed: 0, done: false },
        ],
        bulk_yield: null, fill_yield: null, fg_yield: null,
        bulk_batch_accepted: null, fill_batch_accepted: null, fg_batch_accepted: null,
        qc_specs: [], remarks: '', due_date: '2026-03-14',
        created_at: now, updated_at: now,
      },
      {
        bmr_no: 'BMR-2026-003', bpr_no: 'BPR-2026-003', product_name: 'Gentle Foaming Facewash', sku: 'EI-FW-150',
        so_no: 'SO-2026-001', order_qty: 30000, batch_size: 500, batch_no: 'B-03', batch_index: 3, total_batches: 3,
        bmr_status: 'batch_confirmed', bpr_status: 'draft', color: 'teal',
        process_type: 'hot', homogenizer: true, main_vessel: '', supporting_tanks: [],
        filling_line: '', filling_type: 'bottle', packaging_line: '', monocarton: true, shrink: false,
        team_bmr: [], team_bpr: [], qc_officer_bmr: '', qc_officer_bpr: '',
        mfg_date: null, fill_date: null, pack_date: null, fg_date: null,
        rm_connect_date: null, pm_connect_date: null,
        rm_reserved: false, pm_reserved: false, rm_connected: false, pm_connected: false,
        dispensing_rm: [
          { code: 'RM-001', inci: 'Aqua (Water)', required: 350, dispensed: 0, done: false },
          { code: 'RM-002', inci: 'Sodium Laureth Sulfate', required: 75, dispensed: 0, done: false },
        ],
        dispensing_pm: [
          { code: 'PM-001', name: '150ml Bottle', required: 10000, dispensed: 0, done: false },
        ],
        bulk_yield: null, fill_yield: null, fg_yield: null,
        bulk_batch_accepted: null, fill_batch_accepted: null, fg_batch_accepted: null,
        qc_specs: [], remarks: '', due_date: '2026-03-16',
        created_at: now, updated_at: now,
      },
      {
        bmr_no: 'BMR-2026-004', bpr_no: 'BPR-2026-004', product_name: 'Invisible Sunscreen SPF50', sku: 'EI-SS-50',
        so_no: 'SO-2026-002', order_qty: 20000, batch_size: 300, batch_no: 'B-01', batch_index: 1, total_batches: 2,
        bmr_status: 'bulk_qc', bpr_status: 'pm_reserved', color: 'amber',
        process_type: 'hot', homogenizer: true, main_vessel: 'MV-02', supporting_tanks: ['ST-02'],
        filling_line: 'FL-02', filling_type: 'tube', packaging_line: 'PL-01', monocarton: true, shrink: true,
        team_bmr: ['T01', 'T04'], team_bpr: ['T08', 'T09', 'T10', 'T11'], qc_officer_bmr: 'T05', qc_officer_bpr: 'T07',
        mfg_date: '2026-03-03', fill_date: '2026-03-07', pack_date: '2026-03-08', fg_date: '2026-03-09',
        rm_connect_date: '2026-03-01', pm_connect_date: '2026-03-05',
        rm_reserved: true, pm_reserved: true, rm_connected: true, pm_connected: false,
        dispensing_rm: [
          { code: 'RM-006', inci: 'Titanium Dioxide', required: 45, dispensed: 45, done: true },
          { code: 'RM-007', inci: 'Zinc Oxide', required: 30, dispensed: 30, done: true },
          { code: 'RM-001', inci: 'Aqua', required: 150, dispensed: 150, done: true },
          { code: 'RM-008', inci: 'Silicone Emulsion', required: 50, dispensed: 50, done: true },
        ],
        dispensing_pm: [
          { code: 'PM-005', name: '50ml Tube', required: 10000, dispensed: 0, done: false },
          { code: 'PM-006', name: 'Tube Cap', required: 10000, dispensed: 0, done: false },
          { code: 'PM-003', name: 'Label', required: 10000, dispensed: 0, done: false },
          { code: 'PM-004', name: 'Mono Carton', required: 10000, dispensed: 0, done: false },
        ],
        bulk_yield: null, fill_yield: null, fg_yield: null,
        bulk_batch_accepted: null, fill_batch_accepted: null, fg_batch_accepted: null,
        qc_specs: [
          { param: 'pH', spec: '6.5 - 7.5', result: '7.0', passed: true },
          { param: 'Viscosity', spec: '8000-12000 cps', result: '9500', passed: true },
          { param: 'SPF Value', spec: '>= 50', result: '52', passed: true },
          { param: 'Appearance', spec: 'White smooth lotion', result: 'Conforms', passed: true },
        ],
        remarks: '', due_date: '2026-03-10',
        created_at: now, updated_at: now,
      },
      {
        bmr_no: 'BMR-2026-005', bpr_no: 'BPR-2026-005', product_name: 'Invisible Sunscreen SPF50', sku: 'EI-SS-50',
        so_no: 'SO-2026-002', order_qty: 20000, batch_size: 300, batch_no: 'B-02', batch_index: 2, total_batches: 2,
        bmr_status: 'draft', bpr_status: 'draft', color: 'amber',
        process_type: 'hot', homogenizer: true, main_vessel: '', supporting_tanks: [],
        filling_line: '', filling_type: 'tube', packaging_line: '', monocarton: true, shrink: true,
        team_bmr: [], team_bpr: [], qc_officer_bmr: '', qc_officer_bpr: '',
        mfg_date: null, fill_date: null, pack_date: null, fg_date: null,
        rm_connect_date: null, pm_connect_date: null,
        rm_reserved: false, pm_reserved: false, rm_connected: false, pm_connected: false,
        dispensing_rm: [
          { code: 'RM-006', inci: 'Titanium Dioxide', required: 45, dispensed: 0, done: false },
          { code: 'RM-007', inci: 'Zinc Oxide', required: 30, dispensed: 0, done: false },
        ],
        dispensing_pm: [
          { code: 'PM-005', name: '50ml Tube', required: 10000, dispensed: 0, done: false },
        ],
        bulk_yield: null, fill_yield: null, fg_yield: null,
        bulk_batch_accepted: null, fill_batch_accepted: null, fg_batch_accepted: null,
        qc_specs: [], remarks: '', due_date: '2026-03-18',
        created_at: now, updated_at: now,
      },
      {
        bmr_no: 'BMR-2026-006', bpr_no: 'BPR-2026-006', product_name: 'Hydra-Boost Moisturiser', sku: 'EI-MO-200',
        so_no: 'SO-2026-003', order_qty: 15000, batch_size: 200, batch_no: 'B-01', batch_index: 1, total_batches: 1,
        bmr_status: 'draft', bpr_status: 'draft', color: 'purple',
        process_type: 'cold', homogenizer: false, main_vessel: 'MV-03', supporting_tanks: [],
        filling_line: 'FL-03', filling_type: 'jar', packaging_line: 'PL-02', monocarton: true, shrink: false,
        team_bmr: [], team_bpr: [], qc_officer_bmr: '', qc_officer_bpr: '',
        mfg_date: null, fill_date: null, pack_date: null, fg_date: null,
        rm_connect_date: null, pm_connect_date: null,
        rm_reserved: false, pm_reserved: false, rm_connected: false, pm_connected: false,
        dispensing_rm: [
          { code: 'RM-001', inci: 'Aqua', required: 140, dispensed: 0, done: false },
          { code: 'RM-009', inci: 'Hyaluronic Acid', required: 5, dispensed: 0, done: false },
          { code: 'RM-010', inci: 'Shea Butter', required: 30, dispensed: 0, done: false },
        ],
        dispensing_pm: [
          { code: 'PM-007', name: '200ml Jar', required: 15000, dispensed: 0, done: false },
          { code: 'PM-008', name: 'Jar Lid', required: 15000, dispensed: 0, done: false },
        ],
        bulk_yield: null, fill_yield: null, fg_yield: null,
        bulk_batch_accepted: null, fill_batch_accepted: null, fg_batch_accepted: null,
        qc_specs: [], remarks: '', due_date: '2026-03-20',
        created_at: now, updated_at: now,
      },
    ]);

    /* ── Transporters ── */
    console.log('Seeding Transporters...');
    await Transporter.destroy({ where: {} });
    await Transporter.bulkCreate([
      { name: 'BlueDart Express', code: 'BLUEDART', contact_phone: '+91-1860-233-1234', contact_email: 'customerservice@bluedart.com', tracking_url: 'https://www.bluedart.com/tracking', status: 'active', created_at: now, updated_at: now },
      { name: 'Delhivery', code: 'DELHIVERY', contact_phone: '+91-11-4567-8900', contact_email: 'support@delhivery.com', tracking_url: 'https://www.delhivery.com/track', status: 'active', created_at: now, updated_at: now },
      { name: 'FedEx India', code: 'FEDEX', contact_phone: '+91-22-2645-6789', contact_email: 'india@fedex.com', tracking_url: 'https://www.fedex.com/en-in/tracking.html', status: 'active', created_at: now, updated_at: now },
      { name: 'DTDC', code: 'DTDC', contact_phone: '+91-33-4400-6644', contact_email: 'custcare@dtdc.com', tracking_url: 'https://www.dtdc.in/tracking.asp', status: 'active', created_at: now, updated_at: now },
      { name: 'Ecom Express', code: 'ECOM', contact_phone: '+91-11-4567-1234', contact_email: 'support@ecomexpress.in', tracking_url: 'https://www.ecomexpress.in/tracking', status: 'active', created_at: now, updated_at: now },
      { name: 'Direct Dispatch', code: 'DIRECT', contact_phone: '', contact_email: '', tracking_url: '', status: 'active', created_at: now, updated_at: now },
      { name: 'Gati Logistics', code: 'GATI', contact_phone: '+91-40-2398-5566', contact_email: 'customercare@gati.com', tracking_url: 'https://www.gati.com/tracking', status: 'active', created_at: now, updated_at: now },
      { name: 'Rivigo', code: 'RIVIGO', contact_phone: '+91-124-466-9000', contact_email: 'help@rivigo.com', tracking_url: 'https://www.rivigo.com/tracking', status: 'active', created_at: now, updated_at: now },
    ]);

    /* ── Fulfillment Invoices ── */
    console.log('Seeding Fulfillment Invoices...');
    await FulfillmentInvoice.destroy({ where: {} });

    /* ── Fulfillment Orders ── */
    console.log('Seeding Fulfillment Orders...');
    await FulfillmentBatchSplit.destroy({ where: {} });
    await FulfillmentOrderItem.destroy({ where: {} });
    await FulfillmentOrder.destroy({ where: {} });

    const soEI001 = await SalesOrder.findOne({ where: { order_id: 'EI-SO-2026-001' } });
    const soEI002 = await SalesOrder.findOne({ where: { order_id: 'EI-SO-2026-002' } });
    const soEI003 = await SalesOrder.findOne({ where: { order_id: 'EI-SO-2026-003' } });
    const soEI004 = await SalesOrder.findOne({ where: { order_id: 'EI-SO-2026-004' } });

    const pbBMR001 = await ProductionBatch.findOne({ where: { bmr_no: 'BMR-2026-001' } });
    const pbBMR002 = await ProductionBatch.findOne({ where: { bmr_no: 'BMR-2026-002' } });
    const pbBMR003 = await ProductionBatch.findOne({ where: { bmr_no: 'BMR-2026-003' } });
    const pbBMR004 = await ProductionBatch.findOne({ where: { bmr_no: 'BMR-2026-004' } });
    const pbBMR005 = await ProductionBatch.findOne({ where: { bmr_no: 'BMR-2026-005' } });
    const pbBMR006 = await ProductionBatch.findOne({ where: { bmr_no: 'BMR-2026-006' } });

    const ffOrder1 = await FulfillmentOrder.create({
      so_no: 'EI-SO-2026-001', sales_order_id: soEI001?.id || null,
      customer_name: 'BeautyBox Retail', customer_city: 'Mumbai',
      order_date: '2026-01-10', due_date: '2026-03-15', priority: 'high', so_status: 'partial',
      so_value: 750000, ship_address: '12th Floor, Trade Centre, BKC, Bandra East, Mumbai 400051',
      payment_terms: 'Net 30', notes: 'Urgent — retail launch tied to March season. Partial dispatch OK.',
      created_at: now, updated_at: now,
    });
    const ffItem1 = await FulfillmentOrderItem.create({
      fulfillment_order_id: ffOrder1.id, item_no: '001', sku: 'EI-FG-001',
      product_name: 'EI Gentle Foaming Facewash', pack: '150ml Tube',
      ordered_qty: 50000, rate: 15, unit_price: 15,
      created_at: now, updated_at: now,
    });
    await FulfillmentBatchSplit.bulkCreate([
      {
        fulfillment_order_item_id: ffItem1.id, fulfillment_order_id: ffOrder1.id,
        production_batch_id: pbBMR001?.id || null, bmr_no: 'BMR-2026-001', bpr_no: 'BPR-2026-001',
        planned_qty: 20000, fg_qty: 20000, fg_location: 'FG-A-12', ff_status: 'fg_ready',
        picked_qty: 0, created_at: now, updated_at: now,
      },
      {
        fulfillment_order_item_id: ffItem1.id, fulfillment_order_id: ffOrder1.id,
        production_batch_id: pbBMR002?.id || null, bmr_no: 'BMR-2026-002', bpr_no: 'BPR-2026-002',
        planned_qty: 15000, fg_qty: 0, fg_location: null, ff_status: 'fg_pending',
        picked_qty: 0, created_at: now, updated_at: now,
      },
      {
        fulfillment_order_item_id: ffItem1.id, fulfillment_order_id: ffOrder1.id,
        production_batch_id: pbBMR003?.id || null, bmr_no: 'BMR-2026-003', bpr_no: 'BPR-2026-003',
        planned_qty: 15000, fg_qty: 0, fg_location: null, ff_status: 'fg_pending',
        picked_qty: 0, created_at: now, updated_at: now,
      },
    ]);

    const ffOrder2 = await FulfillmentOrder.create({
      so_no: 'EI-SO-2026-002', sales_order_id: soEI002?.id || null,
      customer_name: 'Glow & Go Distribution', customer_city: 'Bengaluru',
      order_date: '2026-02-01', due_date: '2026-04-10', priority: 'normal', so_status: 'in_production',
      so_value: 900000, ship_address: '45, Industrial Layout, Peenya, Bengaluru 560058',
      payment_terms: 'Net 45', notes: '',
      created_at: now, updated_at: now,
    });
    const ffItem2 = await FulfillmentOrderItem.create({
      fulfillment_order_id: ffOrder2.id, item_no: '001', sku: 'EI-FG-002',
      product_name: 'EI Invisible Sunscreen SPF50', pack: '50ml Bottle',
      ordered_qty: 30000, rate: 30, unit_price: 30,
      created_at: now, updated_at: now,
    });
    await FulfillmentBatchSplit.bulkCreate([
      {
        fulfillment_order_item_id: ffItem2.id, fulfillment_order_id: ffOrder2.id,
        production_batch_id: pbBMR004?.id || null, bmr_no: 'BMR-2026-004', bpr_no: 'BPR-2026-004',
        planned_qty: 15000, fg_qty: 14800, fg_location: 'FG-B-03', ff_status: 'bulk_qc',
        picked_qty: 0, created_at: now, updated_at: now,
      },
      {
        fulfillment_order_item_id: ffItem2.id, fulfillment_order_id: ffOrder2.id,
        production_batch_id: pbBMR005?.id || null, bmr_no: 'BMR-2026-005', bpr_no: 'BPR-2026-005',
        planned_qty: 15000, fg_qty: 0, fg_location: null, ff_status: 'fg_pending',
        picked_qty: 0, created_at: now, updated_at: now,
      },
    ]);

    const ffOrder3 = await FulfillmentOrder.create({
      so_no: 'EI-SO-2026-003', sales_order_id: soEI003?.id || null,
      customer_name: 'Shine & Care Salons', customer_city: 'Hyderabad',
      order_date: '2026-02-20', due_date: '2026-05-01', priority: 'normal', so_status: 'planned',
      so_value: 1000000, ship_address: 'Plot 88, HITEC City, Phase 2, Hyderabad 500081',
      payment_terms: 'Advance', notes: 'New client — first order. Quality check before dispatch.',
      created_at: now, updated_at: now,
    });
    const ffItem3 = await FulfillmentOrderItem.create({
      fulfillment_order_id: ffOrder3.id, item_no: '001', sku: 'EI-FG-003',
      product_name: 'EI Hydra-Boost Moisturiser', pack: '100ml Jar',
      ordered_qty: 40000, rate: 25, unit_price: 25,
      created_at: now, updated_at: now,
    });
    await FulfillmentBatchSplit.bulkCreate([
      {
        fulfillment_order_item_id: ffItem3.id, fulfillment_order_id: ffOrder3.id,
        production_batch_id: pbBMR006?.id || null, bmr_no: 'BMR-2026-006', bpr_no: 'BPR-2026-006',
        planned_qty: 40000, fg_qty: 0, fg_location: null, ff_status: 'fg_pending',
        picked_qty: 0, created_at: now, updated_at: now,
      },
    ]);

    const ffOrder4 = await FulfillmentOrder.create({
      so_no: 'EI-SO-2026-004', sales_order_id: soEI004?.id || null,
      customer_name: 'NaturGlow FMCG', customer_city: 'Delhi',
      order_date: '2025-12-15', due_date: '2026-02-28', priority: 'high', so_status: 'shipped',
      so_value: 400000, ship_address: 'A-12, Okhla Industrial Area, Phase 1, New Delhi 110020',
      payment_terms: 'COD', notes: '',
      invoice_no: 'INV-2026-1001', invoice_date: '2026-02-12',
      awb_no: 'BD9876543210', dispatch_date: '2026-02-18', courier: 'BlueDart Express',
      created_at: now, updated_at: now,
    });
    const ffItem4 = await FulfillmentOrderItem.create({
      fulfillment_order_id: ffOrder4.id, item_no: '001', sku: 'EI-FG-004',
      product_name: 'EI Daily Defence Conditioner', pack: '200ml Bottle',
      ordered_qty: 20000, rate: 20, unit_price: 20,
      created_at: now, updated_at: now,
    });
    await FulfillmentBatchSplit.bulkCreate([
      {
        fulfillment_order_item_id: ffItem4.id, fulfillment_order_id: ffOrder4.id,
        production_batch_id: null, bmr_no: 'BMR-2025-0401', bpr_no: 'BPR-2025-0401',
        planned_qty: 20000, fg_qty: 20000, fg_location: 'FG-C-01', ff_status: 'shipped',
        picked_qty: 20000, picker_name: 'Ramesh K', pick_date: '2026-02-10',
        pick_slip_no: 'PS-40112', remarks: 'Handle with care — glass bottles',
        invoice_no: 'INV-2026-1001', awb_no: 'BD9876543210', courier: 'BlueDart Express',
        dispatch_date: '2026-02-18', eta_date: '2026-02-25',
        created_at: now, updated_at: now,
      },
    ]);

    console.log('Seeding complete.');
    process.exit(0);
  } catch (err) {
    console.error('Seeding failed:', err);
    process.exit(1);
  }
}

seed();

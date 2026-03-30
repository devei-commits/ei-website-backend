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
const Authentication = require('./src/otp/models');
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
const WarehouseInventoryLocationHistory = require('./src/warehouseInventory/locationHistoryModel');
const warehouseSeedData = require('./src/warehouseInventory/warehouseSeedData');
const { WarehouseLocation, WarehouseRack, WarehouseRackItem } = require('./src/warehouseLocations/models');
const GoodsReceivedNote = require('./src/grn/models');
const MaterialRequestNote = require('./src/mrn/models');
const { ItemsList, ItemListVendorRate, ItemListTier } = require('./src/itemsList/models');
const legacyAppointmentsSeedData = require('./src/appointments/legacySeedData');
const { ProductionEquipment, ProductionTeamMember, ProductionBatch } = require('./src/production/models');
const { FulfillmentOrder, FulfillmentOrderItem, FulfillmentBatchSplit, Transporter, FulfillmentInvoice, ReservedBatchItem } = require('./src/fulfillment/models');
const { ClientQuery, ClientDevelopment, ClientOrder, ClientAppointment } = require('./src/clientHub/models');
const FacilityArea = require('./src/facilityAreas/models');
const { Department } = require('./src/departments/models');
const { ModuleDefinition, Permission, RolePermission } = require('./src/models/index');
const { StaffProfile } = require('./src/roles/models');
const defaultModuleDef = require('./src/roles/defaultModuleDefinition');
const zohoEnv = require('./src/services/zohoEnv');
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
      if (name) await db.query(`DROP TABLE IF EXISTS \`${name}\``, { raw: true }).catch(() => { });
    }
    await db.query('SET FOREIGN_KEY_CHECKS = 1', { raw: true });
    console.log('All tables dropped.');
    return;
  }
  if (dialect === 'sqlite') {
    const [rows] = await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", { raw: true });
    for (const row of rows || []) {
      if (row.name) await db.query(`DROP TABLE IF EXISTS "${row.name}"`, { raw: true }).catch(() => { });
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
    await db.sync({ force: true });

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

    const zohoBooksOn = zohoEnv.booksEnabled;
    const zohoSeedFull = zohoEnv.seedFullSync;
    const seedZohoItems = zohoEnv.seedSyncItems;
    const seedZohoContact = zohoEnv.seedSyncContacts;
    const seedZohoInvoice = zohoEnv.seedSyncInvoices;

    if (zohoSeedFull && zohoBooksOn) {
      console.log(
        '[Seed] Zoho: ZOHO_SEED_FULL_SYNC — syncing FG/RM/PM + contacts to Books and local DB, then demo invoice using DB zoho_item_id / zoho_id.'
      );
    }

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
    // Zoho seed: ZOHO_BOOKS_ENABLED=true + OAuth/org/currency. Recommended single switch:
    //   ZOHO_SEED_FULL_SYNC=true → items (FG/RM/PM) + contacts (client1, Luminos, Chemspec) + demo invoice, all IDs written to DB then invoice reads from DB.
    // Granular (optional): ZOHO_SEED_SYNC_ITEMS, ZOHO_SEED_SYNC_CONTACT, ZOHO_SEED_SYNC_INVOICE — invoice alone will not call Zoho unless items+client zoho ids already exist in DB.

    // 1. Super Admin
    const superAdmin = await User.create({
      fname: 'Super',
      lname: 'Admin',
      display_name: 'Super Admin',
      email: 'superadmin@example.com',
      mobile: '+919876543201',
      password: bcrypt.hashSync('SuperAdmin@123', 10),
      usertype: 'super_admin',
        zoho_contact_id: '3529895000000116003',
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
      zoho_contact_id: '3529895000000092022',
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

    // Portal user for seeded client master EI-CLI-00001 (Luminos) — 2-way link with vendor_clients.user_id
    const luminosPortalUser = await User.create({
      fname: 'Rajeev',
      lname: 'Sharma',
      display_name: 'Luminos Skincare',
      email: 'bd@luminos.in',
      mobile: '+91-9812345001',
      password: bcrypt.hashSync('LuminosPortal@123', 10),
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

    if (seedZohoContact) {
      const { syncZohoContactForNewUser } = require('./src/users/zohoContactSync');
      const zohoUser = await User.findByPk(client1.userid);
      if (zohoUser && !zohoUser.zoho_contact_id) {
        const seedBody = {};
        if (client1Billing) {
          const br = client1Billing.get ? client1Billing.get({ plain: true }) : client1Billing;
          seedBody.billing_address = {
            address: [br.address_line1, br.address_line2].filter(Boolean).join(', '),
            city: br.city_text,
            state: br.state_text,
            zip: br.pincode,
            country: br.country_text || 'India',
          };
        }
        const zoho = await syncZohoContactForNewUser(zohoUser, seedBody);
        if (zoho.synced && zoho.contactId) {
          await zohoUser.update({ zoho_contact_id: zoho.contactId });
          console.log(`[Seed] Zoho Books contact linked: ${zohoUser.email} → zoho_contact_id=${zoho.contactId}`);
        } else if (zoho.error && zoho.error !== 'zoho_disabled') {
          console.warn('[Seed] Zoho contact sync (client1@example.com) skipped:', zoho.error);
        }
      }
    }

    /*
    console.log('Seeding categories and products...');
    await Product.destroy({ where: {} });
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
        buy_price: 299.00,
        category: 'Sunscreen',
        lifecycle_status: 'Production Released',
        form: 'Lotion/Cream',
        fill_size: '50g',
        batch_size_kg: 500,
        lead_time_days: 50,
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
        buy_price: 179.00,
        category: 'Face Wash',
        lifecycle_status: 'Production Released',
        form: 'Gel',
        fill_size: '150ml',
        batch_size_kg: 500,
        lead_time_days: 40,
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

    console.log('Seeding legacy Appointments... (skipped — one entry only)');
    const legacyAppointmentsData = [];

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
    await Customization.bulkCreate(customizationsSeedData.slice(0, 1));

    console.log('Seeding Items...');
    const itemsSeedData = itemsSeedDataRaw.map((row) => excelRowToItem(row));
    await Item.bulkCreate(itemsSeedData);

    console.log('Seeding Vendors...');
    const vendorsSeedData = contactsSeedDataRaw.map((row) => contactRowToVendor(row));
    await Vendor.bulkCreate(vendorsSeedData);

    */
    console.log('Seeding Customers (contacts)...');
    const customersSeedData = seedContactData.map((row) => customerRowToModel(row));
    await Contact.bulkCreate(customersSeedData);
    /*

    console.log('Seeding Composite Items...');
    const compositeItemsData = compositeItemsSeedData.map((row) => compositeRowToModel(row));
    await CompositeItem.bulkCreate(compositeItemsData);

    console.log('Seeding Packaging (Masters)...');
    await Packaging.destroy({ where: {} });
    await Packaging.bulkCreate([
      { package_code: 'PKG-BTL-001', package_name: '30ml Dropper Bottle', package_sku: 'SKU-DRP-30', bottom: 'round', cap_type: 'dropper', bottom_name: 'Amber Glass', bottom_material: 'glass', cap_name: 'Black Dropper', cap_material: 'plastic', bottom_color: 'Amber', cap_color: 'Black', bottom_weight: '45g', cap_weight: '8g', dispenser_volume: '30ml', minimum_order_quantity: '1000', budget: 'medium', comments: 'Standard serum bottle', status: 'active', created_at: now, updated_at: now },
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
      { code: 'EI-RM-ACT-001', name: 'Glycerin', inci: 'Glycerin', category: 'ACTIVE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 55, gst: 12, shelf: '36M', specific_gravity: 1.26, status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-002', name: 'Niacinamide', inci: 'Niacinamide', category: 'ACTIVE', rm_type: 'Solid', uom: 'KG', price_per_kg: 1450, gst: 12, shelf: '24M', specific_gravity: 1.0, status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-003', name: 'Ascorbyl Glucoside', inci: 'Ascorbyl Glucoside', category: 'ACTIVE', rm_type: 'Solid', uom: 'KG', price_per_kg: 4800, gst: 12, shelf: '18M', specific_gravity: 1.0, status: 'Active', products: ['PR-001'], group: 'Primary', created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-004', name: 'Allantoin', inci: 'Allantoin', category: 'ACTIVE', rm_type: 'Solid', uom: 'KG', price_per_kg: 780, gst: 12, shelf: '36M', specific_gravity: 1.0, status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-005', name: 'Tocopheryl Acetate', inci: 'Tocopheryl Acetate', category: 'ACTIVE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 2200, gst: 12, shelf: '24M', specific_gravity: 0.96, status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-006', name: 'Aloe Vera Extract', inci: 'Aloe Barbadensis Leaf Juice', category: 'BOTANICAL', rm_type: 'Liquid', uom: 'KG', price_per_kg: 280, gst: 5, shelf: '18M', specific_gravity: 1.0, status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-BASE-001', name: 'Aqua (Purified Water)', inci: 'Aqua', category: 'BASE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 8.85, gst: 8, shelf: '24M', specific_gravity: 1.0, status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-EMUL-001', name: 'Cetearyl Alcohol', inci: 'Cetearyl Alcohol', category: 'EMULSIFIER', rm_type: 'Solid', uom: 'KG', price_per_kg: 185, gst: 12, shelf: '36M', specific_gravity: 0.85, status: 'Active', products: ['PR-001'], group: 'Primary +1', created_at: now, updated_at: now },
      { code: 'EI-RM-EMUL-002', name: 'Ceteareth-20', inci: 'Ceteareth-20', category: 'EMULSIFIER', rm_type: 'Solid', uom: 'KG', price_per_kg: 310, gst: 12, shelf: '24M', specific_gravity: 1.0, status: 'Active', products: ['PR-001'], group: 'Alt +1', created_at: now, updated_at: now },
      { code: 'EI-RM-EXCIP-001', name: 'Sodium Hydroxide (50%)', inci: 'Sodium Hydroxide', category: 'EXCIPIENT', rm_type: 'Liquid', uom: 'KG', price_per_kg: 45, gst: 18, shelf: '24M', specific_gravity: 1.0, status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-EXCIP-002', name: 'Citric Acid Monohydrate', inci: 'Citric Acid', category: 'EXCIPIENT', rm_type: 'Solid', uom: 'KG', price_per_kg: 85, gst: 12, shelf: '36M', specific_gravity: 1.0, status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-FRAG-001', name: 'Parfum — Solar Breeze', inci: 'Parfum', category: 'FRAGRANCE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 1500, gst: 18, shelf: '24M', specific_gravity: 0.9, status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-FRAG-002', name: 'Parfum — Jasmine Fresh', inci: 'Parfum', category: 'FRAGRANCE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 1600, gst: 18, shelf: '24M', specific_gravity: 0.9, status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-POLY-001', name: 'Carbomer 980', inci: 'Carbomer', category: 'POLYMER', rm_type: 'Solid', uom: 'KG', price_per_kg: 900, gst: 18, shelf: '36M', specific_gravity: 1.0, status: 'Active', products: ['PR-001'], group: 'Primary +1', created_at: now, updated_at: now },
      { code: 'EI-RM-POLY-002', name: 'Carbopol 940', inci: 'Carbomer', category: 'POLYMER', rm_type: 'Solid', uom: 'KG', price_per_kg: 850, gst: 18, shelf: '24M', specific_gravity: 1.0, status: 'Active', products: ['PR-002'], group: 'Alt +1', created_at: now, updated_at: now },
      { code: 'EI-RM-PRES-001', name: 'Phenoxyethanol', inci: 'Phenoxyethanol', category: 'PRESERVATIVE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 520, gst: 18, shelf: '36M', specific_gravity: 1.1, status: 'Active', products: ['PR-001', 'PR-002'], group: 'Primary', created_at: now, updated_at: now },
      { code: 'EI-RM-SURF-001', name: 'SLES 70%', inci: 'Sodium Laureth Sulfate', category: 'SURFACTANT', rm_type: 'Liquid', uom: 'KG', price_per_kg: 125, gst: 18, shelf: '24M', specific_gravity: 1.05, status: 'Active', products: ['PR-002'], group: 'Primary +1', created_at: now, updated_at: now },
      { code: 'EI-RM-SURF-002', name: 'Cocamidopropyl Betaine', inci: 'Cocamidopropyl Betaine', category: 'SURFACTANT', rm_type: 'Liquid', uom: 'KG', price_per_kg: 190, gst: 18, shelf: '24M', specific_gravity: 1.04, status: 'Active', products: ['PR-001'], group: 'Alt +1', created_at: now, updated_at: now },
      { code: 'EI-RM-SURF-003', name: 'Sodium Cocoyl Isethionate', inci: 'Sodium Cocoyl Isethionate', category: 'SURFACTANT', rm_type: 'Solid', uom: 'KG', price_per_kg: 240, gst: 18, shelf: '18M', specific_gravity: 1.0, status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-UVF-001', name: 'Ethylhexyl Methoxycinnamate', inci: 'Ethylhexyl Methoxycinnamate', category: 'UV FILTER', rm_type: 'Liquid', uom: 'KG', price_per_kg: 1200, gst: 18, shelf: '24M', specific_gravity: 1.05, status: 'Active', products: ['PR-001'], group: 'Primary', created_at: now, updated_at: now },
      { code: 'EI-RM-UVF-002', name: 'Titanium Dioxide (nano)', inci: 'Titanium Dioxide', category: 'UV FILTER', rm_type: 'Solid', uom: 'KG', price_per_kg: 650, gst: 12, shelf: '36M', specific_gravity: 1.0, status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-UVF-003', name: 'Zinc Oxide (nano)', inci: 'Zinc Oxide', category: 'UV FILTER', rm_type: 'Solid', uom: 'KG', price_per_kg: 720, gst: 12, shelf: '36M', specific_gravity: 1.0, status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-UVF-004', name: 'Avobenzone', inci: 'Butyl Methoxydibenzoylmethane', category: 'UV FILTER', rm_type: 'Solid', uom: 'KG', price_per_kg: 980, gst: 18, shelf: '24M', specific_gravity: 1.0, status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      // RMs from HTML PRs Extracted (sunscreen / moisturiser / conditioner)
      { code: 'EI-RM-UVF-005', name: 'Homosalate', inci: 'Homosalate', category: 'UV FILTER', rm_type: 'Liquid', uom: 'KG', price_per_kg: 520, gst: 18, shelf: '24M', specific_gravity: 1.04, status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-UVF-006', name: 'Octocrylene', inci: 'Octocrylene', category: 'UV FILTER', rm_type: 'Liquid', uom: 'KG', price_per_kg: 590, gst: 18, shelf: '24M', specific_gravity: 1.0, status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-HUM-001', name: 'Butylene Glycol', inci: 'Butylene Glycol', category: 'HUMECTANT', rm_type: 'Liquid', uom: 'KG', price_per_kg: 180, gst: 18, shelf: '24M', specific_gravity: 1.0, status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-EMUL-003', name: 'Stearic Acid', inci: 'Stearic Acid', category: 'EMULSIFIER', rm_type: 'Solid', uom: 'KG', price_per_kg: 120, gst: 12, shelf: '36M', specific_gravity: 0.85, status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-EMUL-004', name: 'PEG-100 Stearate/Glyceryl Stearate', inci: 'PEG-100 Stearate', category: 'EMULSIFIER', rm_type: 'Solid', uom: 'KG', price_per_kg: 380, gst: 18, shelf: '24M', specific_gravity: 1.0, status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-SOLV-001', name: 'Isohexadecane', inci: 'Isohexadecane', category: 'SOLVENT', rm_type: 'Liquid', uom: 'KG', price_per_kg: 220, gst: 18, shelf: '24M', specific_gravity: 0.79, status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-SOLV-002', name: 'Cyclopentasiloxane', inci: 'Cyclopentasiloxane', category: 'SOLVENT', rm_type: 'Liquid', uom: 'KG', price_per_kg: 450, gst: 18, shelf: '24M', specific_gravity: 0.96, status: 'Active', products: ['PR-001'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-PRES-002', name: 'Ethylhexylglycerin', inci: 'Ethylhexylglycerin', category: 'PRESERVATIVE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 1200, gst: 18, shelf: '24M', specific_gravity: 1.0, status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-SILI-001', name: 'Dimethicone', inci: 'Dimethicone', category: 'SILICONE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 680, gst: 18, shelf: '24M', specific_gravity: 0.97, status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-007', name: 'Sodium Hyaluronate', inci: 'Sodium Hyaluronate', category: 'ACTIVE', rm_type: 'Solid', uom: 'KG', price_per_kg: 8500, gst: 12, shelf: '24M', specific_gravity: 1.0, status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-008', name: 'Ceramide NP', inci: 'Ceramide NP', category: 'ACTIVE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 12000, gst: 12, shelf: '18M', specific_gravity: 1.0, status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-009', name: 'Panthenol', inci: 'Panthenol', category: 'ACTIVE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 420, gst: 12, shelf: '24M', specific_gravity: 1.0, status: 'Active', products: ['PR-001', 'PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-010', name: 'Centella Asiatica Extract', inci: 'Centella Asiatica Extract', category: 'BOTANICAL', rm_type: 'Liquid', uom: 'KG', price_per_kg: 1800, gst: 5, shelf: '18M', specific_gravity: 1.0, status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-COND-001', name: 'Cetrimonium Chloride', inci: 'Cetrimonium Chloride', category: 'CONDITIONER', rm_type: 'Solid', uom: 'KG', price_per_kg: 320, gst: 18, shelf: '24M', specific_gravity: 1.0, status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-COND-002', name: 'Guar Hydroxypropyltrimonium Chloride', inci: 'Guar Hydroxypropyltrimonium Chloride', category: 'CONDITIONER', rm_type: 'Solid', uom: 'KG', price_per_kg: 580, gst: 18, shelf: '24M', specific_gravity: 1.0, status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-COND-003', name: 'Behentrimonium Methosulfate/Cetearyl', inci: 'Behentrimonium Methosulfate', category: 'CONDITIONER', rm_type: 'Solid', uom: 'KG', price_per_kg: 420, gst: 18, shelf: '24M', specific_gravity: 1.0, status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-OIL-001', name: 'Cocos Nucifera Oil', inci: 'Cocos Nucifera Oil', category: 'OIL', rm_type: 'Liquid', uom: 'KG', price_per_kg: 180, gst: 5, shelf: '12M', specific_gravity: 0.92, status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-OIL-002', name: 'Argania Spinosa Kernel Oil', inci: 'Argania Spinosa Kernel Oil', category: 'OIL', rm_type: 'Liquid', uom: 'KG', price_per_kg: 3200, gst: 5, shelf: '12M', specific_gravity: 0.91, status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-SILI-002', name: 'Amodimethicone', inci: 'Amodimethicone', category: 'SILICONE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 920, gst: 18, shelf: '24M', specific_gravity: 0.98, status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
      { code: 'EI-RM-ACT-011', name: 'Hydrolyzed Keratin', inci: 'Hydrolyzed Keratin', category: 'ACTIVE', rm_type: 'Liquid', uom: 'KG', price_per_kg: 1200, gst: 12, shelf: '18M', specific_gravity: 1.0, status: 'Active', products: ['PR-002'], group: null, created_at: now, updated_at: now },
    ]);

    const rmLeadByCategory = [
      ['BASE', 7],
      ['UV FILTER', 21],
      ['ACTIVE', 14],
      ['BOTANICAL', 16],
      ['EMULSIFIER', 12],
      ['EXCIPIENT', 10],
      ['FRAGRANCE', 18],
      ['POLYMER', 14],
      ['PRESERVATIVE', 14],
      ['SURFACTANT', 14],
      ['HUMECTANT', 12],
      ['SOLVENT', 14],
      ['SILICONE', 18],
      ['CONDITIONER', 14],
      ['OIL', 12],
    ];
    for (const [cat, days] of rmLeadByCategory) {
      await RawMaterial.update({ lead_time_days: days, updated_at: now }, { where: { category: cat } });
    }

    // Bulk quality specs (form_data) for BMR Bulk QC reference panel + PM master — keys match production.controller BULK_QUALITY_FORM_KEYS
    const seedRmBulkForm = [
      ['EI-RM-BASE-001', { appearanceSpec: 'Clear, colourless liquid', phSpec: '6.0-7.5', microbialSpec: 'TVC NMT 100 CFU/ml', otherSpecs: 'Purified / WFI-grade water' }],
      ['EI-RM-ACT-001', { assayPurity: 'NLT 99.0%', appearanceSpec: 'Clear viscous liquid', moistureLod: 'NMT 0.5%', microbialSpec: 'Meets USP <61>' }],
      ['EI-RM-ACT-002', { assayPurity: 'NLT 98.5%', appearanceSpec: 'White to off-white powder', moistureLod: 'NMT 0.5%', heavyMetalsSpec: 'NMT 20 ppm Pb' }],
      ['EI-RM-POLY-001', { assayPurity: 'NLT 94.0%', appearanceSpec: 'Fluffy white powder', moistureLod: 'NMT 2.0%', phSpec: '2.5-3.5 (1% aq. disp.)' }],
      ['EI-RM-PRES-001', { assayPurity: 'NLT 99.0%', appearanceSpec: 'Clear liquid', phSpec: '6.0-8.0', odorColorSpec: 'Mild characteristic odour' }],
      ['EI-RM-UVF-001', { assayPurity: 'NLT 98.0%', appearanceSpec: 'Colourless to pale yellow liquid', moistureLod: 'NMT 0.2%', otherSpecs: 'UV filter — store away from light' }],
      ['EI-RM-EMUL-001', { appearanceSpec: 'White waxy flakes', assayPurity: 'NLT 95%', odorColorSpec: 'Low odour', microbialSpec: 'Meets IP limits' }],
    ];
    for (const [code, fd] of seedRmBulkForm) {
      await RawMaterial.update({ form_data: fd, updated_at: now }, { where: { code } });
    }

    const seedPmBulkForm = [
      ['EI-PM-TUB-001', { appearanceSpec: 'No cracks, seam intact; print legible', phSpec: 'N/A', otherSpecs: 'WVTR per drawing' }],
      ['EI-PM-CAP-001', { appearanceSpec: 'No flash; colour match approved swatch', microbialSpec: 'Bioburden per SOP', odorColorSpec: 'Neutral' }],
      ['EI-PM-BOX-001', { appearanceSpec: 'Score lines intact; no rub-off', moistureLod: 'Board moisture NMT 8%', otherSpecs: '300 GSM duplex — lot COA on file' }],
      ['EI-PM-BTL-001', { appearanceSpec: 'No stress whitening; neck finish within gauge', assayPurity: 'N/A', otherSpecs: '150ml HDPE — food-grade resin' }],
    ];
    for (const [code, fd] of seedPmBulkForm) {
      await PackMaterial.update({ form_data: fd, updated_at: now }, { where: { code } });
    }

    if (seedZohoItems) {
      const { syncZohoItemForNewRawMaterial, syncZohoItemForNewPackMaterial } = require('./src/services/zohoMasterItemSync');
      const { syncZohoItemForNewProduct } = require('./src/products/zohoItemSync');

      const productsToSync = await Product.findAll({
        where: { zoho_item_id: null },
        order: [['product_id', 'ASC']],
      });
      let nOk = 0;
      let nFail = 0;
      for (const p of productsToSync) {
        const z = await syncZohoItemForNewProduct(p, {});
        if (z.synced && z.itemId) {
          await p.update({ zoho_item_id: z.itemId });
          nOk++;
        } else if (
          z.error &&
          z.error !== 'zoho_disabled' &&
          z.error !== 'item_sync_disabled' &&
          z.error !== 'already_has_zoho_item_id'
        ) {
          console.warn(`[Seed] Zoho product item skipped (${p.product_code}):`, z.error);
          nFail++;
        }
      }
      console.log(`[Seed] Zoho Books products (FG): ${nOk} linked, ${nFail} skipped/errors`);

      const rms = await RawMaterial.findAll({ where: { zoho_id: '3529895000000114003' }, order: [['id', 'ASC']] });
      nOk = 0;
      nFail = 0;
      for (const rm of rms) {
        const z = await syncZohoItemForNewRawMaterial(rm, {});
        if (z.synced && z.itemId) {
          await rm.update({ zoho_id: z.itemId });
          nOk++;
        } else if (
          z.error &&
          z.error !== 'zoho_disabled' &&
          z.error !== 'item_sync_disabled' &&
          z.error !== 'already_has_zoho_id'
        ) {
          console.warn(`[Seed] Zoho RM skipped (${rm.code}):`, z.error);
          nFail++;
        }
      }
      console.log(`[Seed] Zoho Books raw materials: ${nOk} linked, ${nFail} skipped/errors`);

      const pms = await PackMaterial.findAll({ where: { zoho_id: null }, order: [['id', 'ASC']] });
      nOk = 0;
      nFail = 0;
      for (const pm of pms) {
        const z = await syncZohoItemForNewPackMaterial(pm, {});
        if (z.synced && z.itemId) {
          await pm.update({ zoho_id: z.itemId });
          nOk++;
        } else if (
          z.error &&
          z.error !== 'zoho_disabled' &&
          z.error !== 'item_sync_disabled' &&
          z.error !== 'already_has_zoho_id'
        ) {
          console.warn(`[Seed] Zoho PM skipped (${pm.code}):`, z.error);
          nFail++;
        }
      }
      console.log(`[Seed] Zoho Books pack materials: ${nOk} linked, ${nFail} skipped/errors`);
    }

    console.log('Seeding BOMs...');
    await BOM.destroy({ where: {} });
    await BOM.bulkCreate([
      // PR product BOM (linked to productA)
      {
        bom_code: 'PR-BOM-001', name: 'EI Sunscreen Lotion SPF50+ PA++++', product_id: productA.product_id,
        type: 'FG', status: 'Approved', version: 'v2.0', ph_range: '6.0-7.0', yield_pct: '98.5',
        rm_lines: [
          { phase: 'Phase A', inci_name: 'Aqua', rm_code: 'EI-RM-BASE-001', pct_w_w: 52.30, uom: 'kg', specific_gravity: 1.0 },
          { phase: 'Phase A', inci_name: 'Glycerin', rm_code: 'EI-RM-ACT-001', pct_w_w: 3.00, uom: 'kg', specific_gravity: 1.26 },
          { phase: 'Phase A', inci_name: 'Carbomer 980', rm_code: 'EI-RM-POLY-001', pct_w_w: 0.30, uom: 'kg', specific_gravity: 1.0 },
          { phase: 'Phase B (Oil)', inci_name: 'Homosalate', rm_code: 'EI-RM-UVF-001', pct_w_w: 10.00, uom: 'kg', specific_gravity: 1.0 },
          { phase: 'Phase B (Oil)', inci_name: 'Ethylhexyl Methoxycinnamate', rm_code: 'EI-RM-UVF-002', pct_w_w: 7.50, uom: 'kg', specific_gravity: 1.0 },
          { phase: 'Phase B (Oil)', inci_name: 'Octocrylene', rm_code: 'EI-RM-UVF-003', pct_w_w: 8.00, uom: 'kg', specific_gravity: 1.0 },
          { phase: 'Phase B (Oil)', inci_name: 'Butyl Methoxydibenzoylmethane', rm_code: 'EI-RM-UVF-004', pct_w_w: 3.00, uom: 'kg', specific_gravity: 1.0 },
          { phase: 'Phase B (Oil)', inci_name: 'Cetearyl Alcohol', rm_code: 'EI-RM-EMUL-001', pct_w_w: 3.00, uom: 'kg', specific_gravity: 0.85 },
          { phase: 'Phase B (Oil)', inci_name: 'Ceteareth-20', rm_code: 'EI-RM-EMUL-002', pct_w_w: 2.00, uom: 'kg', specific_gravity: 1.0 },
          { phase: 'Phase B (Oil)', inci_name: 'Tocopheryl Acetate', rm_code: 'EI-RM-ACT-005', pct_w_w: 0.50, uom: 'kg', specific_gravity: 0.96 },
          { phase: 'Phase C (Active)', inci_name: 'Niacinamide', rm_code: 'EI-RM-ACT-002', pct_w_w: 2.00, uom: 'kg', specific_gravity: 1.0 },
          { phase: 'Phase C (Active)', inci_name: 'Ascorbyl Glucoside', rm_code: 'EI-RM-ACT-003', pct_w_w: 1.00, uom: 'kg', specific_gravity: 1.0 },
          { phase: 'Phase C (Active)', inci_name: 'Allantoin', rm_code: 'EI-RM-ACT-004', pct_w_w: 0.20, uom: 'kg', specific_gravity: 1.0 },
          { phase: 'Phase C (Active)', inci_name: 'Parfum', rm_code: 'EI-RM-FRAG-001', pct_w_w: 0.30, uom: 'kg', specific_gravity: 0.9 },
          { phase: 'Phase D (Pres)', inci_name: 'Phenoxyethanol', rm_code: 'EI-RM-PRES-001', pct_w_w: 0.80, uom: 'kg', specific_gravity: 1.1 },
          { phase: 'Phase E (Adjust)', inci_name: 'Sodium Hydroxide', rm_code: 'EI-RM-EXCIP-001', pct_w_w: 0.40, uom: 'kg', specific_gravity: 1.0 },
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
      // Facewash 150ml — Pack BOM (and RM) for product EI-PR-00002
      {
        bom_code: 'PR-BOM-002', name: 'EI Gentle Foaming Facewash 150ml', product_id: productB.product_id,
        type: 'FG', status: 'Approved', version: 'v1.0', ph_range: '5.5-6.5', yield_pct: '98.5',
        rm_lines: [
          { phase: 'Phase A', inci_name: 'Aqua', rm_code: 'EI-RM-BASE-001', pct_w_w: 70, uom: 'kg', specific_gravity: 1.0 },
          { phase: 'Phase A', inci_name: 'Glycerin', rm_code: 'EI-RM-ACT-001', pct_w_w: 5, uom: 'kg', specific_gravity: 1.26 },
          { phase: 'Phase A', inci_name: 'SLES 70%', rm_code: 'EI-RM-SURF-001', pct_w_w: 12, uom: 'kg', specific_gravity: 1.05 },
          { phase: 'Phase A', inci_name: 'Cocamidopropyl Betaine', rm_code: 'EI-RM-SURF-002', pct_w_w: 3, uom: 'kg', specific_gravity: 1.04 },
          { phase: 'Phase A', inci_name: 'Niacinamide', rm_code: 'EI-RM-ACT-002', pct_w_w: 2, uom: 'kg', specific_gravity: 1.0 },
          { phase: 'Phase A', inci_name: 'Phenoxyethanol', rm_code: 'EI-RM-PRES-001', pct_w_w: 0.8, uom: 'kg', specific_gravity: 1.1 },
          { phase: 'Phase A', inci_name: 'Sodium Hydroxide', rm_code: 'EI-RM-EXCIP-001', pct_w_w: 0.4, uom: 'kg', specific_gravity: 1.0 },
        ],
        pm_lines: [
          { pm_code: 'EI-PM-BTL-001', description: '150ml Clear PET Pump Bottle', pack_type: 'Primary', qty_per_unit: 1, uom: 'pc/unit' },
          { pm_code: 'EI-PM-PMP-001', description: '24/410 Lotion Pump White', pack_type: 'Primary', qty_per_unit: 1, uom: 'pc/unit' },
          { pm_code: 'EI-PM-LBL-001', description: 'Facewash Front Label 100×80mm', pack_type: 'Primary', qty_per_unit: 1, uom: 'pc/unit' },
          { pm_code: 'EI-PM-BOX-002', description: 'Facewash 150ml Monocarton', pack_type: 'Secondary', qty_per_unit: 1, uom: 'pc/unit' },
        ],
        process_steps: [],
        stability_summary: 'Accelerated 6M: PASS',
        created_at: now, updated_at: now,
      },
    ]);

    console.log('Seeding Item Groups (RM/PM groups with member_ids from raw_materials/pack_materials)...');
    await ItemGroup.destroy({ where: {} });
    const rmByCode = await RawMaterial.findAll({ attributes: ['id', 'code'] }).then(rows => new Map(rows.map(r => [r.code, r.id])));
    const pmByCode = await PackMaterial.findAll({ attributes: ['id', 'code'] }).then(rows => new Map(rows.map(r => [r.code, r.id])));
    const igSeed = [
      { code: 'IG-001', icon: '', type: 'RM', name: 'Emulsion Base Water Phase', description: 'Purified water sources', purpose: 'Water phase for emulsions', status: 'Active', notes: '', member_ids: [rmByCode.get('EI-RM-BASE-001')].filter(Boolean), proposed_alternates: [], created_at: now, updated_at: now },
      { code: 'IG-002', icon: '', type: 'RM', name: 'Broad-Spectrum UV Filter Pack', description: 'UV filters for sunscreen', purpose: 'Sunscreen actives', status: 'Active', notes: '', member_ids: ['EI-RM-UVF-001', 'EI-RM-UVF-002', 'EI-RM-UVF-003', 'EI-RM-UVF-004'].map(c => rmByCode.get(c)).filter(Boolean), proposed_alternates: [], created_at: now, updated_at: now },
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
        reserved: 0,
        in_transit: 0,
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

    // ── Departments ──
    console.log('Seeding Departments...');
    await Department.destroy({ where: {} });
    await Department.bulkCreate([
      { name: 'Administration', code: 'administration', is_active: true, created_at: now, updated_at: now },
      { name: 'Manufacturing', code: 'manufacturing', is_active: true, created_at: now, updated_at: now },
      { name: 'Quality', code: 'quality', is_active: true, created_at: now, updated_at: now },
    ]);

    console.log('Seeding Facility Areas...');
    await WarehouseRackItem.destroy({ where: {} });
    await WarehouseRack.destroy({ where: {} });
    await WarehouseLocation.destroy({ where: {} });
    await FacilityArea.destroy({ where: {} });

    const areaSeed = [
      { code: 'AREA-WH', name: 'Main Warehouse', area_type: 'warehouse', icon: '', description: 'Central warehouse storage' },
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

    const locationSeed = [
      { code: 'LOC-RM', name: 'RM Store', area_id: WH, location_type: 'warehouse', zone_label: 'Zone A', icon: '', area_sqm: 380, description: 'Main warehouse storage', utilisation_pct: 50 },
    ];
    const createdLocations = await WarehouseLocation.bulkCreate(
      locationSeed.map((l) => ({ ...l, created_at: now, updated_at: now }))
    );
    const locByCode = new Map(createdLocations.map((c) => [c.code, c.id]));

    const rackSeed = [
      { locCode: 'LOC-RM', code: 'A1', name: 'A1', description: 'Ambient Row 1', levels: 4, slots_total: 16, tags: ['001'] },
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

    */
    console.log('Seeding Vendor / Client master (before Items List)...');
    await VendorClient.destroy({ where: {} });
    const vendorClientSeed = [
      { entity_code: 'EI-VEN-00001', type: 'vendor', zoho_id: null, name: 'Chemspec India', email: 'orders@chemspecindia.com', phone: '+91-9876543210', location: 'Mumbai', country: 'India', city: 'Mumbai', category: 'RAW MATERIAL', status: 'active', payment_terms: 'Adv 0% · Pre 100% · Post 0% · Net 30d', notes: '', rating: 4, moq: '—', lead_time: '14 days', data: {}, created_at: now, updated_at: now },
      { entity_code: 'EI-VEN-00002', type: 'vendor', zoho_id: '5012345678901002', name: 'Sigma Chemicals Pvt Ltd', email: 'sales@sigmachem.in', phone: '+91-9876543211', location: 'Pune', country: 'India', city: 'Pune', category: 'RAW MATERIAL', status: 'active', payment_terms: 'Adv 0% · Pre 100% · Post 0% · Net 45d', notes: '', rating: 4, moq: '—', lead_time: '18 days', data: {}, created_at: now, updated_at: now },
      { entity_code: 'EI-VEN-00003', type: 'vendor', zoho_id: '5012345678901003', name: 'UV Filters & Actives Co', email: 'procurement@uvfilters.co.in', phone: '+91-9876543212', location: 'Hyderabad', country: 'India', city: 'Hyderabad', category: 'UV FILTER / ACTIVE', status: 'active', payment_terms: 'Adv 0% · Pre 100% · Post 0% · Net 30d', notes: '', rating: 5, moq: '—', lead_time: '21 days', data: {}, created_at: now, updated_at: now },
      { entity_code: 'EI-VEN-00004', type: 'vendor', zoho_id: '5012345678901004', name: 'Packaging Solutions India', email: 'orders@packsol.in', phone: '+91-9876543213', location: 'Chennai', country: 'India', city: 'Chennai', category: 'PACKAGING', status: 'active', payment_terms: 'Adv 30% · Pre 70% · Post 0%', notes: '', rating: 4, moq: '—', lead_time: '21–28 days', data: {}, created_at: now, updated_at: now },
      { entity_code: 'EI-CLI-00001', type: 'client', zoho_id: null, name: 'Luminos Skincare', email: 'bd@luminos.in', phone: '+91-9812345001', location: 'Maharashtra', country: 'India', city: 'Mumbai', category: 'CDMO', status: 'active', payment_terms: 'NET 45', notes: '', rating: 5, moq: '—', lead_time: '—', data: { shipping_address: 'Luminos Skincare, 456 Andheri East, Mumbai, Maharashtra 400069, India' }, priority: 'high', segment: 'Skin Care', since_year: 2022, revenue_value: 4200000, avatar_color: 'orange', account_manager_id: amPriya.userid, contacts: [{ name: 'Rajeev Sharma', role: 'BD Head' }], created_at: now, updated_at: now },
    ];
    await VendorClient.bulkCreate(vendorClientSeed);

    await VendorClient.update(
      { user_id: luminosPortalUser.userid },
      { where: { entity_code: 'EI-CLI-00001' } }
    );

    try {
      const { ensureClientVendorMasterForUser } = require('./src/vendorClient/userLink');
      await ensureClientVendorMasterForUser(client1);
      await ensureClientVendorMasterForUser(client2);
      await ensureClientVendorMasterForUser(doctor);
      await ensureClientVendorMasterForUser(luminosPortalUser);
    } catch (e) {
      console.warn('[Seed] vendor_clients ↔ users link:', e && e.message ? e.message : e);
    }

    /*
    if (seedZohoContact) {
      const { syncZohoContactForVendorClient } = require('./src/users/zohoContactSync');
      const luminos = await VendorClient.findOne({ where: { entity_code: 'EI-CLI-00001' } });
      if (luminos && !luminos.zoho_id) {
        const zohoVc = await syncZohoContactForVendorClient(luminos);
        if (zohoVc.synced && zohoVc.contactId) {
          await luminos.update({ zoho_id: zohoVc.contactId });
          console.log(`[Seed] Zoho Books contact linked: Luminos Skincare (EI-CLI-00001) → zoho_id=${zohoVc.contactId}`);
        } else if (zohoVc.error && zohoVc.error !== 'zoho_disabled') {
          console.warn('[Seed] Zoho contact sync (Luminos Skincare) skipped:', zohoVc.error);
        }
      }
      const chemspec = await VendorClient.findOne({ where: { entity_code: 'EI-VEN-00001' } });
      if (chemspec && !chemspec.zoho_id) {
        const zohoVen = await syncZohoContactForVendorClient(chemspec);
        if (zohoVen.synced && zohoVen.contactId) {
          await chemspec.update({ zoho_id: zohoVen.contactId });
          console.log(`[Seed] Zoho Books vendor linked: Chemspec India (EI-VEN-00001) → zoho_id=${zohoVen.contactId}`);
        } else if (zohoVen.error && zohoVen.error !== 'zoho_disabled') {
          console.warn('[Seed] Zoho vendor sync (Chemspec India) skipped:', zohoVen.error);
        }
      }
    }

    // Demo invoice: customer_id from vendor_clients.zoho_id (Luminos), line item_id from products.zoho_item_id (EI-PR-00001). Always loaded fresh from DB after item+contact sync above.
    if (seedZohoInvoice) {
      const { pushZohoSeedDemoInvoice } = require('./src/fulfillment/zohoInvoiceSync');

      // Bulk item seed (seedZohoItems) runs earlier; if only invoice+contact flags were set, EI-PR-00001 may still lack zoho_item_id. Push that one FG to Books here when item API sync is allowed.
      if (zohoBooksOn && zohoEnv.syncItems) {
        const demoPrRow = await Product.findOne({ where: { product_code: 'EI-PR-00001' } });
        if (demoPrRow && (!demoPrRow.zoho_item_id || !String(demoPrRow.zoho_item_id).trim())) {
          const { syncZohoItemForNewProduct } = require('./src/products/zohoItemSync');
          const zPr = await syncZohoItemForNewProduct(demoPrRow, {});
          if (zPr.synced && zPr.itemId) {
            await demoPrRow.update({ zoho_item_id: zPr.itemId });
            console.log(`[Seed] Zoho Books product (demo invoice): EI-PR-00001 → zoho_item_id=${zPr.itemId}`);
          } else if (
            zPr.error &&
            zPr.error !== 'zoho_disabled' &&
            zPr.error !== 'item_sync_disabled' &&
            zPr.error !== 'already_has_zoho_item_id'
          ) {
            console.warn('[Seed] Zoho demo-invoice product sync (EI-PR-00001) skipped:', zPr.error);
          }
        }
      }

      const seedInvProduct = await Product.findOne({
        where: { product_code: 'EI-PR-00001' },
        attributes: ['product_id', 'zoho_item_id', 'mrp_price', 'product_name'],
      });
      const seedInvCustomer = await VendorClient.findOne({
        where: { entity_code: 'EI-CLI-00001' },
        attributes: ['id', 'zoho_id', 'name', 'entity_code'],
      });
      const prZoho = seedInvProduct && seedInvProduct.zoho_item_id ? String(seedInvProduct.zoho_item_id).trim() : '';
      const cliZoho = seedInvCustomer && seedInvCustomer.zoho_id ? String(seedInvCustomer.zoho_id).trim() : '';
      if (seedInvProduct && prZoho && seedInvCustomer && seedInvCustomer.id && cliZoho) {
        const invNo = `EI-SEED-INV-${now.getFullYear()}-${String(now.getTime()).slice(-8)}`;
        const invRes = await pushZohoSeedDemoInvoice({
          vendorClientId: seedInvCustomer.id,
          productId: seedInvProduct.product_id,
          invoiceNo: invNo,
          quantity: 48,
          rate: Number(seedInvProduct.mrp_price) || 499,
          invoiceDate: now.toISOString().slice(0, 10),
        });
        if (invRes.synced && invRes.invoiceId) {
          console.log(
            `[Seed] Zoho Books demo invoice: ${invNo} → zoho_invoice_id=${invRes.invoiceId} (vendor_clients.id=${seedInvCustomer.id} → zoho_id=${cliZoho}, PR zoho_item_id=${prZoho})`
          );
        } else if (invRes.error && invRes.error !== 'zoho_invoices_disabled') {
          console.warn('[Seed] Zoho demo invoice API error:', invRes.error);
        }
      } else {
        const reasons = [];
        if (!seedInvProduct) reasons.push('product EI-PR-00001 missing');
        else if (!prZoho) {
          reasons.push(
            'products.zoho_item_id empty for EI-PR-00001 (use ZOHO_SEED_SYNC_ITEMS / ZOHO_SEED_FULL_SYNC, or keep ZOHO_SYNC_ITEMS enabled so the demo-invoice step can create the Books item)'
          );
        }
        if (!seedInvCustomer) reasons.push('vendor_client EI-CLI-00001 missing');
        else if (!seedInvCustomer.id) reasons.push('vendor_clients.id missing');
        else if (!cliZoho) reasons.push('vendor_clients.zoho_id empty for Luminos (EI-CLI-00001)');
        console.warn(
          `[Seed] Zoho demo invoice not called — ${reasons.join('; ')}. Set ZOHO_SEED_FULL_SYNC=true or the matching ZOHO_SEED_SYNC_* flags so contacts/items exist in Postgres (and Books) before the invoice step.`
        );
      }
    }

    // ── Client Hub sub-entities ──
    console.log('Seeding Client Hub data (queries, developments, orders, appointments)...');
    await ClientAppointment.destroy({ where: {} });
    await ClientOrder.destroy({ where: {} });
    await ClientDevelopment.destroy({ where: {} });
    await ClientQuery.destroy({ where: {} });

    const hubClients = await VendorClient.findAll({ where: { type: 'client' }, order: [['entity_code', 'ASC']], attributes: ['id', 'entity_code'] });
    const cliId = {};
    for (const c of hubClients) { cliId[c.entity_code] = c.id; }
    const C1 = cliId['EI-CLI-00001'];

    await ClientQuery.bulkCreate([
      { client_id: C1, title: 'SPF 50 formulation pricing query', status: 'pending', due_date: '2026-03-05', category: 'Pricing', notes: '', created_at: now, updated_at: now },
    ]);

    await ClientDevelopment.bulkCreate([
      { client_id: C1, pr_code: 'PR-SUN-0042', name: 'SPF 30 Sunscreen Lotion 50g Tube', stage: 'R&D Closure', status: 'inprog', due_date: '2026-02-15', phase: 'Formula Lock', created_at: now, updated_at: now },
    ]);

    await ClientOrder.bulkCreate([
      { client_id: C1, product_name: 'SPF 30 Lotion 50g Tube', quantity: '50,000 units', status: 'inprog', due_date: '2026-03-05', batch_code: 'BT-2026-0301', created_at: now, updated_at: now },
    ]);

    await ClientAppointment.bulkCreate([
      { client_id: C1, title: 'Q2 Planning Call', appointment_date: '2026-03-03', appointment_time: '10:00 AM', type: 'Video Call', with_person: 'Rajeev Sharma', created_at: now, updated_at: now },
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
    console.log('Items List: RM/PM rows seeded; vendor quotation data (item_list_vendor_rates / item_list_tiers) left empty — add via Vendor Client / Items List UI.');

    console.log('Seeding Items Master (linked BOMs, Raw Materials, Pack Materials as arrays)...');
    await ItemMaster.destroy({ where: {} });
    const bomsForItems = await BOM.findAll({ where: { bom_code: 'PR-BOM-001' }, attributes: ['id', 'bom_code', 'name'] });
    const pmsForItems = await PackMaterial.findAll({ where: { code: 'EI-PM-TUB-001' }, attributes: ['id', 'code', 'description'] });
    const b1 = bomsForItems[0]?.id ?? null;
    const p1 = pmsForItems[0]?.id ?? null;
    await ItemMaster.bulkCreate([
      { code: 'IM-PROD-001', name: 'EI Sunscreen Lotion SPF50+', type: 'product', status: 'Active', bom_ids: b1 ? [b1] : [], raw_material_ids: [], pack_material_ids: p1 ? [p1] : [], created_at: now, updated_at: now },
    ]);

    // Procurement requests and planning_extracted reference sales_orders — delete in FK-safe order.
    // No demo Sales Order EI-SO-2026-001: it collides with the first real SO number many UIs generate
    // (sales_orders.order_id is not unique), producing duplicate SO numbers in Planning.
    console.log('Clearing sales_orders / planning_extracted / procurement (no demo SO seeded)...');
    await ProcurementQuotation.destroy({ where: {} }).catch(() => { });
    await ProcurementRequest.destroy({ where: {} });
    await PoTracking.destroy({ where: {} }).catch(() => { });
    await PlanningExtracted.destroy({ where: {} });
    await SalesOrder.destroy({ where: {} });
    await PurchaseOrder.destroy({ where: {} });

    // GRN: not seeded (test with real data).
    await GoodsReceivedNote.destroy({ where: {} });

    console.log('Seeding MRN (Material Request Notes)...');
    await MaterialRequestNote.destroy({ where: {} });
    const mrnRms = await RawMaterial.findAll({ attributes: ['id', 'code'] });
    const mrnPms = await PackMaterial.findAll({ attributes: ['id', 'code'] });
    const mrnRmByCode = {};
    mrnRms.forEach((r) => { mrnRmByCode[r.code] = r.id; });
    const mrnPmByCode = {};
    mrnPms.forEach((p) => { mrnPmByCode[p.code] = p.id; });
    const mrnSeed = [
      {
        mrn_no: 'EI-MRN-2026-001', requested_by: 'Batch Mfg', status: 'Pending', assigned_picker: '', transfer_team: '', notes: 'RM transfer for production', is_inbound_from_mu: false, line_items: [
          { id: 'm1', raw_material_id: mrnRmByCode['EI-RM-BASE-001'], quantity: 100, unit: 'KG', notes: '' },
          { id: 'm2', raw_material_id: mrnRmByCode['EI-RM-ACT-001'], quantity: 10, unit: 'KG', notes: '' },
        ], created_at: now, updated_at: now
      },
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

    // ── Production Equipment ──
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

    // ── Production Team Members ──
    console.log('Seeding Production Team Members (empty — add via Team Management UI)...');
    await ProductionTeamMember.destroy({ where: {} });

    // ── Production Batches: not seeded (test with real data). ──
    await ProductionBatch.destroy({ where: {} });

    // ── Transporters ──
    console.log('Seeding Transporters...');
    await Transporter.destroy({ where: {} });
    await Transporter.bulkCreate([
      { name: 'BlueDart Express', code: 'BLUEDART', contact_phone: '+91-1860-233-1234', contact_email: 'customerservice@bluedart.com', tracking_url: 'https://www.bluedart.com/tracking', status: 'active', created_at: now, updated_at: now },
    ]);

    // ── Fulfillment Invoices ──
    console.log('Seeding Fulfillment Invoices...');
    await FulfillmentInvoice.destroy({ where: {} });

    // ── Fulfillment Orders: not seeded (no SO/batch). ──
    await FulfillmentBatchSplit.destroy({ where: {} });
    await FulfillmentOrderItem.destroy({ where: {} });
    await FulfillmentOrder.destroy({ where: {} });

    // ── Reserved batch items: not seeded (no batch). ──
    await ReservedBatchItem.destroy({ where: {} });

    // ── Warehouse inventory location history: not seeded (no batch). ──
    await WarehouseInventoryLocationHistory.destroy({ where: {} }).catch(() => { });
    */

    console.log('Seeding complete.');
    process.exit(0);
  } catch (err) {
    console.error('Seeding failed:', err);
    process.exit(1);
  }
}

seed();

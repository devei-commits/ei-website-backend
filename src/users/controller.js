const { User, DoctorProfile, RefreshToken, Role } = require("../models/index");
const { Op } = require("sequelize");
const bcrypt = require("bcrypt");
const { getAllowedModules } = require("../middleware/security");
const { loginSchema, userSchema, updateUserSchema } = require("./schemas");
const { generateOtp } = require("../otp/controller");
const { generateToken, generateRefreshToken } = require("../middleware/security");
const Address = require("../models/Addresses");
const { Order, OrderItem } = require("../orders/models");
const { Payment } = require("../payments/models");
const db = require("../../db");

const isDev = process.env.DEV === "true" || process.env.NODE_ENV === "development";
const DEV_BYPASS_EMAIL = "client1@example.com";

// -----------------------------------------------------------------------------
// PUBLIC USER CREATION (POST /api/v1/users)
// This is the doctor/customer signup flow. It is unauthenticated and expects
// clinic_address, shipping_address, billing_address, etc. Do not change the
// payload contract or merge staff-creation logic here without:
// - Keeping this flow backward-compatible for existing frontend/partners, and
// - Branching only on payload shape (e.g. presence of roleId vs clinic_address)
//   and/or auth (authenticated + user-management => staff create).
// Staff user creation lives in createStaffUser (POST /api/v1/users/create) to
// avoid breaking this public flow and to keep admin-only creation behind auth.
// -----------------------------------------------------------------------------
const createUser = async (req, res) => {
  // const { error } = userSchema.validate(req.body, { abortEarly: false });
  // if (error) {
  //   return res
  //     .status(400)
  //     .json({ errors: error.details.map((e) => e.message) });
  // }

  const {
    fname,
    lname,
    display_name,
    email,
    mobile,
    password,
    doctor_id,
    clinic_address,
    shipping_address,
    billing_address,
  } = req.body;

  const t = await db.transaction();

  try {
    const existing = await User.findOne(
      { where: { email } },
      { transaction: t }
    );

    if (existing) {
      await t.rollback();
      return res.status(409).json({ error: "Email already in use" });
    }

    const user = await User.create(
      {
        fname,
        lname,
        display_name,
        email,
        mobile,
        password: bcrypt.hashSync(password, 10),
        doctor_id_legacy: doctor_id,
        usertype: "doctor",
        status: "active",
        verify_status: "pending",
      },
      { transaction: t }
    );

    await DoctorProfile.create(
      {
        user_id: user.userid,
        doctor_id: doctor_id,
        clinic_name: clinic_address.clinic_name,
        city: clinic_address.city,
        state: clinic_address.state,
        country: clinic_address.country,
        pincode: clinic_address.pincode,
        clinic_address: clinic_address.clinic_address,
      },
      { transaction: t }
    );

    await Address.create(
      {
        user_id: user.userid,
        address_type: "shipping",
        is_default_shipping: true,
        first_name: fname,
        last_name: lname,
        address_line1: shipping_address.address_line1,
        city_text: shipping_address.city,
        state_text: shipping_address.state,
        country_text: shipping_address.country,
        pincode: shipping_address.pincode,
        phone: mobile,
      },
      { transaction: t }
    );

    await Address.create(
      {
        user_id: user.userid,
        address_type: "billing",
        is_default_billing: true,
        first_name: fname,
        last_name: lname,
        address_line1: billing_address.address_line1,
        city_text: billing_address.city,
        state_text: billing_address.state,
        country_text: billing_address.country,
        pincode: billing_address.pincode,
        phone: mobile,
      },
      { transaction: t }
    );

    await t.commit();

    return res.status(201).json({
      status: "Success",
      details: "User created!",
      userid: user.userid,
    });

  } catch (err) {
    await t.rollback();
    return res.status(500).json({ error: err.message });
  }
};

const userLogin = async (req, res) => {
  console.log('Login attempt', { email: req.body.email });
  const { error } = loginSchema.validate(req.body, { abortEarly: false });
  if (error) {
    console.log(error);

    return res
      .status(400)
      .json({ errors: error.details.map((e) => e.message) });
  }
  const { email, password } = req.body;
  const user = await User.findOne({ where: { email: email } });
  console.log('user object:', user);

  if (!user) {
    return res.status(404).json({ error: "Invalid credentials!" });
  }
  const compare = await bcrypt.compare(password, user.password);
  console.log('password comparison result:', compare);
  if (!compare) {
    return res.status(404).json({ error: "Invalid credentials!" });
  }

  // Staff/admin dashboard: skip OTP and return token directly (no auth table needed)
  const staffTypes = ['super_admin', 'admin', 'bd_manager'];
  if (staffTypes.includes(user.usertype)) {
    return res.status(200).json({
      success: true,
      token: generateToken(user),
      skipOtp: true,
    });
  }

  // DEV: skip OTP for test user and return token directly
  if (isDev && user.email === DEV_BYPASS_EMAIL) {
    return res.status(200).json({
      success: true,
      token: generateToken(user),
      skipOtp: true,
    });
  }

  // Normal flow: send OTP and return userid for verify step
  const otpResult = await generateOtp({ phone: user.mobile, email: user.email });
  console.log('otpResult', otpResult);
  if (otpResult && otpResult.error) {
    return res.status(500).json({ error: otpResult.error });
  }
  return res.status(200).json({ success: true, userid: user.userid, otp: otpResult });
};

// Admin-only: update a user's payment terms (advancePayment, advanceAmount)
const updateUserPaymentTerms = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    const { advancePayment, advanceAmount } = req.body;
    const updates = {};
    if (typeof advancePayment === "boolean") updates.advance_payment = advancePayment;
    if (advanceAmount !== undefined && advanceAmount !== null) {
      updates.advance_amount = Number(advanceAmount);
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "At least one of advancePayment or advanceAmount is required" });
    }
    updates.updated_at = new Date();
    await user.update(updates);
    res.status(200).json({
      id: user.userid,
      email: user.email,
      advancePayment: !!user.advance_payment,
      advanceAmount: user.advance_amount != null ? Number(user.advance_amount) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Current user's own profile (from token). For staff: includes roleId, roleName, roleLevel, department.
const getMe = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: [
        "userid",
        "fname",
        "lname",
        "display_name",
        "email",
        "mobile",
        "usertype",
        "doctor_id_legacy",
        "status",
        "verify_status",
        "advance_payment",
        "advance_amount",
        "created_at",
      ],
      include: [
        {
          model: Address,
          as: "addresses",
          attributes: [
            "address_id",
            "address_type",
            "address_line1",
            "city_text",
            "state_text",
            "country_text",
            "pincode",
            "phone",
          ],
        },
        {
          model: DoctorProfile,
          as: "doctorProfile",
          attributes: [
            "doctor_id",
            "clinic_name",
            "clinic_address",
            "city",
            "state",
            "country",
            "pincode",
          ],
        }
      ],
    });

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const payload = user.toJSON ? user.toJSON() : { ...user.get() };
    payload.allowedModules = getAllowedModules(user.usertype);
    return res.status(200).json({ success: true, data: payload });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

// Staff usertypes for admin dashboard (getusers?staffOnly=true)
const STAFF_USERTYPES = ['super_admin', 'admin', 'bd_manager', 'doctor'];
// Map usertype -> role_id for API consistency (matches minimal GET /roles list)
const USERTYPE_TO_ROLE_ID = { super_admin: 1, admin: 2, bd_manager: 3, doctor: 4, customer: 5 };
const ROLE_ID_TO_USERTYPE = { 1: 'super_admin', 2: 'admin', 3: 'bd_manager', 4: 'doctor', 5: 'customer' };
// Display names for Edit User dropdown (must match GET /roles role_name values)
const USERTYPE_TO_ROLE_NAME = { super_admin: 'Super Admin', admin: 'Admin', bd_manager: 'BD Manager', doctor: 'Doctor', customer: 'Customer' };

// Optional rolesByCode: { [role_code]: { role_id, role_name } } from Role.findAll() for dynamic role names/ids
function formatUserForStaffList(user, rolesByCode) {
  const usertype = user.usertype || 'customer';
  const roleInfo = rolesByCode && rolesByCode[usertype];
  const roleId = roleInfo ? roleInfo.role_id : (USERTYPE_TO_ROLE_ID[usertype] ?? 0);
  const role_name = roleInfo ? roleInfo.role_name : (USERTYPE_TO_ROLE_NAME[usertype] ?? usertype);
  return {
    userid: user.userid,
    id: user.userid,
    display_name: user.display_name || [user.fname, user.lname].filter(Boolean).join(' ') || user.email,
    email: user.email,
    mobile: user.mobile || null,
    role_id: roleId,
    role_name,
    department: user.department ?? null,
    status: user.status || 'active',
    created_at: user.created_at,
  };
}

async function getRolesByCode() {
  const roles = await Role.findAll({ attributes: ['role_id', 'role_code', 'role_name'] });
  const map = {};
  roles.forEach((r) => { map[r.role_code] = { role_id: r.role_id, role_name: r.role_name }; });
  return map;
}

// Admin-only: list users. ?staffOnly=true returns only staff (super_admin, admin, bd_manager, doctor) with role_id, role_name, department
const getAllUsers = async (req, res) => {
  try {
    const staffOnly = req.query.staffOnly === 'true';
    const attributes = [
      'userid', 'fname', 'lname', 'display_name', 'email', 'mobile', 'usertype', 'department', 'status', 'created_at',
    ];
    let where = {};
    let rolesByCode = null;
    if (staffOnly) {
      const roles = await Role.findAll({ attributes: ['role_id', 'role_code', 'role_name'] });
      rolesByCode = {};
      roles.forEach((r) => { rolesByCode[r.role_code] = { role_id: r.role_id, role_name: r.role_name }; });
      const roleCodes = roles.map((r) => r.role_code);
      where = roleCodes.length ? { usertype: { [Op.in]: roleCodes } } : {};
    }
    const users = await User.findAll({
      attributes,
      where,
      order: [['userid', 'ASC']],
    });

    if (staffOnly) {
      return res.status(200).json(users.map((u) => formatUserForStaffList(u, rolesByCode)));
    }

    // Full list (legacy): include addresses
    const usersWithAddresses = await User.findAll({
      attributes: ['userid', 'display_name', 'email', 'usertype'],
      include: [
        {
          model: Address,
          as: 'addresses',
          attributes: ['address_id', 'address_type', 'address_line1', 'city_text', 'state_text', 'country_text', 'pincode', 'phone'],
        },
      ],
    });
    res.status(200).json(usersWithAddresses);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Admin-only: get one user by id (for view/edit in User Management)
const getUserById = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id, {
      attributes: ['userid', 'fname', 'lname', 'display_name', 'email', 'mobile', 'usertype', 'department', 'status', 'created_at', 'updated_at'],
    });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const rolesByCode = await getRolesByCode();
    res.status(200).json(formatUserForStaffList(user, rolesByCode));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Admin-only: update user's role (usertype) and department. roleId resolved from roles table (dynamic).
const updateUserRole = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const { roleId, department } = req.body;
    if (roleId != null) {
      const role = await Role.findByPk(Number(roleId));
      if (role) {
        user.usertype = role.role_code;
      }
    }
    if (department !== undefined) {
      user.department = department || null;
    }
    user.updated_at = new Date();
    await user.save();
    const roleRow = await Role.findOne({ where: { role_code: user.usertype }, attributes: ['role_id', 'role_name'] });
    res.status(200).json({
      id: user.userid,
      role_id: roleRow ? roleRow.role_id : null,
      role_name: roleRow ? roleRow.role_name : user.usertype,
      department: user.department,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Admin-only: update user profile (name, email, mobile, status)
const updateUserProfile = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const { display_name, name, email, mobile, status } = req.body;
    if (display_name !== undefined) user.display_name = display_name;
    if (name !== undefined) user.display_name = name;
    if (email !== undefined) user.email = email;
    if (mobile !== undefined) user.mobile = mobile;
    if (status !== undefined) user.status = status;
    user.updated_at = new Date();
    await user.save();
    res.status(200).json(formatUserForStaffList(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// -----------------------------------------------------------------------------
// ADMIN-ONLY STAFF USER CREATION (POST /api/v1/users/create)
// Separate from createUser so we don't alter the public doctor signup contract.
// If you ever consolidate into a single POST /api/v1/users:
// - Branch on auth + payload: e.g. if (req.user && hasModule('user-management') && body.roleId != null) => staff flow.
// - Otherwise treat as public doctor signup; preserve existing body shape and behavior.
// Role is dynamic: roleId is resolved from the roles table (role_code → usertype).
// -----------------------------------------------------------------------------
const createStaffUser = async (req, res) => {
  try {
    const body = req.body || {};
    const display_name = body.display_name ?? [body.firstName, body.lastName].filter(Boolean).join(' ').trim();
    const email = body.email && String(body.email).trim();
    const mobile = body.mobile != null ? String(body.mobile) : null;
    const password = body.password;
    const roleId = body.roleId != null ? Number(body.roleId) : null;
    const department = body.department != null ? String(body.department).trim() || null : null;
    const status = body.status || 'active';

    if (!email) return res.status(400).json({ error: 'email is required' });
    if (!password || String(password).length < 6) return res.status(400).json({ error: 'password is required (min 6 characters)' });
    if (roleId == null) return res.status(400).json({ error: 'roleId is required' });

    const role = await Role.findByPk(roleId);
    if (!role) return res.status(400).json({ error: 'Invalid roleId' });
    const usertype = role.role_code;

    const existing = await User.findOne({ where: { email } });
    if (existing) return res.status(409).json({ error: 'Email already in use' });

    const user = await User.create({
      fname: body.firstName ? String(body.firstName).trim() : null,
      lname: body.lastName ? String(body.lastName).trim() : null,
      display_name: display_name || email,
      email,
      mobile: mobile || null,
      password: bcrypt.hashSync(String(password), 10),
      usertype,
      department,
      status,
      verify_status: 'verified',
    });
    const rolesByCode = { [usertype]: { role_id: role.role_id, role_name: role.role_name } };
    res.status(201).json(formatUserForStaffList(user, rolesByCode));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Admin-only: delete user and related data (orders, order items, payments, addresses, doctor profile, refresh token)
const deleteUser = async (req, res) => {
  const t = await db.transaction();
  try {
    const user = await User.findByPk(req.params.id, { transaction: t });
    if (!user) {
      await t.rollback();
      return res.status(404).json({ error: 'User not found' });
    }
    const userid = user.userid;
    const email = user.email;

    const orders = await Order.findAll({ where: { user_id: userid }, attributes: ['order_id'], transaction: t });
    const orderIds = orders.map((o) => o.order_id);
    if (orderIds.length > 0) {
      await OrderItem.destroy({ where: { order_id: { [Op.in]: orderIds } }, transaction: t });
      await Payment.destroy({ where: { orderOrderId: { [Op.in]: orderIds } }, transaction: t }).catch(() => { });
      await Order.destroy({ where: { user_id: userid }, transaction: t });
    }
    await Address.destroy({ where: { user_id: userid }, transaction: t });
    await DoctorProfile.destroy({ where: { user_id: userid }, transaction: t });
    await RefreshToken.destroy({ where: { email }, transaction: t }).catch(() => { });
    await User.destroy({ where: { userid }, transaction: t });

    await t.commit();
    res.status(200).json({ message: 'User deleted' });
  } catch (err) {
    await t.rollback();
    res.status(500).json({ error: err.message });
  }
};

// Create address for current user (e.g. from cart checkout)
const createAddress = async (req, res) => {
  try {
    const { address_line1, address_line2, city_text, state_text, country_text, pincode, address_type, first_name, last_name, phone } = req.body;
    if (!address_line1 || !req.user?.id) {
      return res.status(400).json({ error: "address_line1 and user context required" });
    }
    const address = await Address.create({
      user_id: req.user.id,
      address_line1: address_line1 || '',
      address_line2: address_line2 || '',
      city_text: city_text || '',
      state_text: state_text || '',
      country_text: country_text || 'India',
      pincode: pincode || '',
      address_type: address_type || 'billing',
      first_name: first_name || '',
      last_name: last_name || '',
      phone: phone || '',
    });
    return res.status(201).json(address);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// Update current user's profile
const updateMe = async (req, res) => {
  const { error, value } = updateUserSchema.validate(req.body, { abortEarly: false });
  if (error) {
    return res.status(400).json({ errors: error.details.map((e) => e.message) });
  }

  const userId = req.user.id;
  const t = await db.transaction();

  try {
    const user = await User.findByPk(userId, { transaction: t });
    if (!user) {
      await t.rollback();
      return res.status(404).json({ error: "User not found" });
    }

    // Separate User and DoctorProfile fields
    const userFields = ['fname', 'lname', 'display_name', 'email', 'mobile'];
    const userUpdates = {};
    const now = new Date();

    userFields.forEach(field => {
      if (value[field] !== undefined) {
        userUpdates[field] = value[field];
      }
    });

    // Update User
    if (Object.keys(userUpdates).length > 0) {
      userUpdates.updated_at = now;
      await user.update(userUpdates, { transaction: t });
    }

    // Update or Create DoctorProfile
    if (value.clinic_details) {
      const doctorDataWithTime = { ...value.clinic_details, user_id: userId, updated_at: now };
      const [profile, created] = await DoctorProfile.findOrCreate({
        where: { user_id: userId },
        defaults: doctorDataWithTime,
        transaction: t
      });

      if (!created) {
        await profile.update(doctorDataWithTime, { transaction: t });
      }
    }

    // Update or Create Addresses
    const handleAddressUpdate = async (type, addressData) => {
      if (!addressData) return;

      const mappedData = {
        first_name: addressData.first_name,
        last_name: addressData.last_name,
        address_line1: addressData.address_line1,
        address_line2: addressData.address_line2,
        city_text: addressData.city,
        state_text: addressData.state,
        country_text: addressData.country,
        pincode: addressData.pincode,
        phone: addressData.phone,
        updated_at: now // Manual timestamp update
      };

      const [address, created] = await Address.findOrCreate({
        where: { user_id: userId, address_type: type },
        defaults: { ...mappedData, user_id: userId, address_type: type },
        transaction: t
      });

      if (!created) {
        await address.update(mappedData, { transaction: t });
      }
    };

    if (value.shipping_address) {
      await handleAddressUpdate('shipping', value.shipping_address);
    }
    if (value.billing_address) {
      await handleAddressUpdate('billing', value.billing_address);
    }

    await t.commit();

    // Fetch updated user with profile and addresses
    const updatedUser = await User.findByPk(userId, {
      include: [
        { model: DoctorProfile, as: 'doctorProfile' },
        { model: Address, as: 'addresses' }
      ]
    });

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      data: updatedUser
    });

  } catch (err) {
    if (t) await t.rollback();
    return res.status(500).json({ error: err.message });
  }
};

module.exports = {
  createUser,
  createStaffUser,
  userLogin,
  updateUserPaymentTerms,
  getAllUsers,
  getUserById,
  updateUserRole,
  updateUserProfile,
  deleteUser,
  getMe,
  updateMe,
  createAddress,
  updateUserRole,
};

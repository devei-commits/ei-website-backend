const { User, DoctorProfile } = require("../models/index");

const bcrypt = require("bcrypt");
const { loginSchema, userSchema, updateUserSchema } = require("./schemas");
const { generateOtp } = require("../otp/controller");
const { generateToken } = require("../middleware/security");
const Address = require("../models/Addresses");
const db = require("../../db");

const isDev = process.env.DEV === "true" || process.env.NODE_ENV === "development";
const DEV_BYPASS_EMAIL = "client1@example.com";

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

// Current user's own profile (from token)
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
      return res.status(404).json({ error: "User not found" });
    }

    return res.status(200).json(user);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// Admin-only: list all users
const getAllUsers = async (req, res) => {
  try {
    const users = await User.findAll({
      attributes: [
        "userid",
        "display_name",
        "email",
        "usertype"
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
      ],
    });

    res.status(200).json(users);
  } catch (err) {
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
  userLogin,
  updateUserPaymentTerms,
  getAllUsers,
  getMe,
  updateMe,
  createAddress,
};

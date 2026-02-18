const { User, DoctorProfile } = require("../models/index");

const bcrypt = require("bcrypt");
const { loginSchema, userSchema } = require("./schemas");
const { generateOtp } = require("../otp/controller");
const Address = require("../models/Addresses");
const db = require("../../db");

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
  const { error } = loginSchema.validate(req.body, { abortEarly: false });
  if (error) {
    return res
      .status(400)
      .json({ errors: error.details.map((e) => e.message) });
  }
  const { email, password } = req.body;
  const user = await User.findOne({ where: { email: email } });
  
  if (!user ){
    res.status(404).json({ error: "Invalid credentials!" });
  } else {
    const compare = await bcrypt.compare(password, user.password)
    if (!compare) {
     return res.status(404).json({ error: "Invalid credentials!" });
    }
    //send otp to number and store
    const otp = await generateOtp({ phone: user.mobile });
    // const refreshToken = await generateRefreshToken(user);
    // res.cookie('refreshToken', refreshToken, { httpOnly: true });
    // res.status(200).json({ token: generateToken(user) });
    res.status(200).json({ success:true,otp });
  }
};

// Admin-only: update a user's payment terms
const updateUserPaymentTerms = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    const { paymentTerms } = req.body;
    if (!paymentTerms || typeof paymentTerms !== "string") {
      return res
        .status(400)
        .json({ error: "paymentTerms is required and must be a string" });
    }
    await user.update({ paymentTerms });
    res
      .status(200)
      .json({
        id: user.id,
        email: user.email,
        paymentTerms: user.paymentTerms,
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
        "status",
        "verify_status",
        "created_at",
      ],
      include: [
        {
          model: Address,
          as: "addresses",
          attributes: [
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


module.exports = {
  createUser,
  userLogin,
  updateUserPaymentTerms,
  getAllUsers,
  getMe,
};

#!/usr/bin/env node
require('dotenv').config();

const bcrypt = require('bcrypt');
const db = require('../db');
const { User, DoctorProfile } = require('../src/users/models');
const { Role } = require('../src/roles/models');
const Address = require('../src/models/Addresses');

const DOCTOR_ROLE = {
  role_code: 'doctor',
  role_name: 'Doctor',
  level: 'staff',
};

const DOCTOR_USERS = [
  {
    email: 'dr.sarah@example.com',
    password: 'Doctor@123',
    fname: 'Sarah',
    lname: 'Smith',
    display_name: 'Dr. Sarah Smith',
    mobile: '+919988776655',
    doctor_id: 'DOC-SAR-101',
    portal_signup_role: 'dermatologist',
    clinic_name: 'Wellness Dermatology',
    clinic_address: 'Suite 405, Health Plaza, Bandra West',
    city: 'Mumbai',
    state: 'Maharashtra',
    pincode: '400050',
  },
  {
    email: 'dr.raj@example.com',
    password: 'Doctor@123',
    fname: 'Raj',
    lname: 'Kapoor',
    display_name: 'Dr. Raj Kapoor',
    mobile: '+919876543301',
    doctor_id: 'DOC-RAJ-102',
    portal_signup_role: 'dermatologist',
    clinic_name: 'SkinCare Plus Clinic',
    clinic_address: '12, Connaught Place, Block C',
    city: 'New Delhi',
    state: 'Delhi',
    pincode: '110001',
  },
  {
    email: 'dr.priya@example.com',
    password: 'Doctor@123',
    fname: 'Priya',
    lname: 'Menon',
    display_name: 'Dr. Priya Menon',
    mobile: '+919876543302',
    doctor_id: 'DOC-PRI-103',
    portal_signup_role: 'dermatologist',
    clinic_name: 'Glow Dermatology Centre',
    clinic_address: '88, MG Road, Indiranagar',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560038',
  },
  {
    email: 'dr.amit@example.com',
    password: 'Doctor@123',
    fname: 'Amit',
    lname: 'Verma',
    display_name: 'Dr. Amit Verma',
    mobile: '+919876543303',
    doctor_id: 'DOC-AMI-104',
    portal_signup_role: 'dermatologist',
    clinic_name: 'Chennai Skin Institute',
    clinic_address: '45, Anna Salai, T Nagar',
    city: 'Chennai',
    state: 'Tamil Nadu',
    pincode: '600017',
  },
];

async function ensureDoctorRole() {
  const [row] = await Role.findOrCreate({
    where: { role_code: DOCTOR_ROLE.role_code },
    defaults: {
      role_name: DOCTOR_ROLE.role_name,
      level: DOCTOR_ROLE.level,
      status: 'active',
      permissions_json: ['dashboard'],
    },
  });
  return row;
}

async function upsertDoctorUser(spec) {
  const email = String(spec.email).trim().toLowerCase();
  const now = new Date();
  const passwordHash = bcrypt.hashSync(String(spec.password), 10);

  const existing = await User.findOne({ where: { email } });
  let user = existing;

  if (!user) {
    user = await User.create({
      fname: spec.fname,
      lname: spec.lname,
      display_name: spec.display_name,
      email,
      mobile: spec.mobile,
      password: passwordHash,
      doctor_id_legacy: spec.doctor_id,
      usertype: 'doctor',
      portal_signup_role: spec.portal_signup_role,
      department: null,
      status: 'active',
      verify_status: 'verified',
      advance_payment: false,
      advance_amount: null,
      lifecycle_status: 'active',
      created_at: now,
      updated_at: now,
    });
  } else {
    await user.update({
      fname: spec.fname,
      lname: spec.lname,
      display_name: spec.display_name,
      mobile: spec.mobile,
      password: passwordHash,
      doctor_id_legacy: spec.doctor_id,
      usertype: 'doctor',
      portal_signup_role: spec.portal_signup_role,
      status: 'active',
      verify_status: 'verified',
      lifecycle_status: 'active',
      updated_at: now,
    });
  }

  const [profile] = await DoctorProfile.findOrCreate({
    where: { user_id: user.userid },
    defaults: {
      doctor_id: spec.doctor_id,
      clinic_name: spec.clinic_name,
      clinic_address: spec.clinic_address,
      city: spec.city,
      state: spec.state,
      country: 'India',
      pincode: spec.pincode,
      lifecycle_status: 'active',
    },
  });

  if (profile && !profile.isNewRecord) {
    await profile.update({
      doctor_id: spec.doctor_id,
      clinic_name: spec.clinic_name,
      clinic_address: spec.clinic_address,
      city: spec.city,
      state: spec.state,
      country: 'India',
      pincode: spec.pincode,
      lifecycle_status: 'active',
    });
  }

  const billingExists = await Address.findOne({
    where: { user_id: user.userid, address_type: 'billing' },
  });
  if (!billingExists) {
    await Address.create({
      user_id: user.userid,
      address_type: 'billing',
      is_default_billing: true,
      first_name: spec.fname,
      last_name: spec.lname,
      address_line1: spec.clinic_name,
      city_text: spec.city,
      state_text: spec.state,
      country_text: 'India',
      pincode: spec.pincode,
      phone: spec.mobile,
    });
  }

  const shippingExists = await Address.findOne({
    where: { user_id: user.userid, address_type: 'shipping' },
  });
  if (!shippingExists) {
    await Address.create({
      user_id: user.userid,
      address_type: 'shipping',
      is_default_shipping: true,
      first_name: spec.fname,
      last_name: spec.lname,
      address_line1: spec.clinic_address,
      city_text: spec.city,
      state_text: spec.state,
      country_text: 'India',
      pincode: spec.pincode,
      phone: spec.mobile,
    });
  }

  return {
    action: existing ? 'updated' : 'created',
    email,
    userid: user.userid,
    doctor_id: spec.doctor_id,
  };
}

async function main() {
  await db.authenticate();
  await ensureDoctorRole();

  const results = [];
  for (const spec of DOCTOR_USERS) {
    results.push(await upsertDoctorUser(spec));
  }

  console.log(JSON.stringify({ ok: true, password: 'Doctor@123', results }, null, 2));
  await db.close();
}

main().catch(async (e) => {
  console.error('[seed-doctor-users]', e && e.message ? e.message : e);
  try {
    await db.close();
  } catch (_e) {}
  process.exit(1);
});

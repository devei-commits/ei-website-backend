const { DataTypes, Model } = require('sequelize');
const db = require('../../db');
const { User } = require('../users/models');

class Appointment extends Model {}

Appointment.init({
  appointmentid: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  // Legacy import fields from external appointment system
  app_id: {
    type: DataTypes.STRING,
    allowNull: true
  },
  app_type: {
    type: DataTypes.STRING,
    allowNull: true
  },
  app_doc_name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  app_doc_mobile: {
    type: DataTypes.STRING,
    allowNull: true
  },
  app_doc_email: {
    type: DataTypes.STRING,
    allowNull: true
  },
  app_clinic_name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  app_address1: {
    type: DataTypes.STRING,
    allowNull: true
  },
  app_address2: {
    type: DataTypes.STRING,
    allowNull: true
  },
  app_state: {
    type: DataTypes.STRING,
    allowNull: true
  },
  app_city: {
    type: DataTypes.STRING,
    allowNull: true
  },
  app_other_address: {
    type: DataTypes.STRING,
    allowNull: true
  },
  app_pincode: {
    type: DataTypes.STRING,
    allowNull: true
  },
  app_date1: {
    type: DataTypes.STRING,
    allowNull: true
  },
  app_date1_time_slot1: {
    type: DataTypes.STRING,
    allowNull: true
  },
  app_date2: {
    type: DataTypes.STRING,
    allowNull: true
  },
  app_date2_time_slot2: {
    type: DataTypes.STRING,
    allowNull: true
  },
  app_status: {
    type: DataTypes.STRING,
    allowNull: true
  },
  app_remarks: {
    type: DataTypes.STRING,
    allowNull: true
  },
  app_userid: {
    type: DataTypes.STRING,
    allowNull: true
  },
  confirm_appointment: {
    type: DataTypes.STRING,
    allowNull: true
  },
  app_confirmation_status: {
    type: DataTypes.STRING,
    allowNull: true
  },
  meeting_status: {
    type: DataTypes.STRING,
    allowNull: true
  },
  mom: {
    type: DataTypes.STRING,
    allowNull: true
  },
  assign_to: {
    type: DataTypes.STRING,
    allowNull: true
  },
  pex_id: {
    type: DataTypes.STRING,
    allowNull: true
  },
  adedon: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // Existing normalized fields used by the current app
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: User,
      key: 'userid'
    }
  },
  doctor_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: User,
      key: 'userid'
    }
  },
  clinic_name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  email: {
    type: DataTypes.STRING,
    allowNull: true
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: true
  },
  address: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  city: {
    type: DataTypes.STRING,
    allowNull: true
  },
  state: {
    type: DataTypes.STRING,
    allowNull: true
  },
  pincode: {
    type: DataTypes.STRING,
    allowNull: true
  },
  reason: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  mode: {
    type: DataTypes.STRING,
    allowNull: true
  },
  status: {
    type: DataTypes.STRING,
    allowNull: true
  },
  lifecycle_status: {
    type: DataTypes.STRING,
    allowNull: true
  },
  slot1_date: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  slot1_time: {
    type: DataTypes.TIME,
    allowNull: true
  },
  slot2_date: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  slot2_time: {
    type: DataTypes.TIME,
    allowNull: true
  },
  created_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  updated_at: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  sequelize: db,
  modelName: 'Appointment',
  tableName: 'appointments',
  timestamps: false
});

// Associations
Appointment.belongsTo(User, { foreignKey: 'user_id', as: 'patient' });
Appointment.belongsTo(User, { foreignKey: 'doctor_id', as: 'doctor' });

User.hasMany(Appointment, { foreignKey: 'user_id', as: 'appointments' });
User.hasMany(Appointment, { foreignKey: 'doctor_id', as: 'doctorAppointments' });

module.exports = Appointment;

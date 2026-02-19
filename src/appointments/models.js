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
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: User,
      key: 'user_id'    
    }
  },
  doctor_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: User,
      key: 'user_id'
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

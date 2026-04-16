const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class LogisticsSchedule extends Model {}

LogisticsSchedule.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tracking_no: { type: DataTypes.STRING(200), allowNull: false },
    transporter: { type: DataTypes.STRING(200), allowNull: false },
    dispatch_date: { type: DataTypes.DATEONLY, allowNull: false },
    eta_date: { type: DataTypes.DATEONLY, allowNull: false },
    vehicle_no: { type: DataTypes.STRING(100), allowNull: false },
    status: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'Active' },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'LogisticsSchedule',
    tableName: 'logistics_schedules',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = LogisticsSchedule;


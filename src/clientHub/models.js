const { DataTypes, Model } = require('sequelize');
const db = require('../../db');
const VendorClient = require('../vendorClient/models');

class ClientQuery extends Model {}
ClientQuery.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    client_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: VendorClient, key: 'id' } },
    title: { type: DataTypes.STRING(500), allowNull: false },
    status: { type: DataTypes.STRING(50), allowNull: true, defaultValue: 'new' },
    due_date: { type: DataTypes.DATEONLY, allowNull: true },
    category: { type: DataTypes.STRING(100), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  { sequelize: db, modelName: 'ClientQuery', tableName: 'client_queries', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at' }
);

class ClientDevelopment extends Model {}
ClientDevelopment.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    client_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: VendorClient, key: 'id' } },
    pr_code: { type: DataTypes.STRING(100), allowNull: true },
    name: { type: DataTypes.STRING(500), allowNull: false },
    stage: { type: DataTypes.STRING(100), allowNull: true },
    status: { type: DataTypes.STRING(50), allowNull: true, defaultValue: 'new' },
    due_date: { type: DataTypes.DATEONLY, allowNull: true },
    phase: { type: DataTypes.STRING(100), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  { sequelize: db, modelName: 'ClientDevelopment', tableName: 'client_developments', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at' }
);

class ClientOrder extends Model {}
ClientOrder.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    client_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: VendorClient, key: 'id' } },
    product_name: { type: DataTypes.STRING(500), allowNull: false },
    quantity: { type: DataTypes.STRING(100), allowNull: true },
    status: { type: DataTypes.STRING(50), allowNull: true, defaultValue: 'pending' },
    due_date: { type: DataTypes.DATEONLY, allowNull: true },
    batch_code: { type: DataTypes.STRING(100), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  { sequelize: db, modelName: 'ClientOrder', tableName: 'client_orders', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at' }
);

class ClientAppointment extends Model {}
ClientAppointment.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    client_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: VendorClient, key: 'id' } },
    title: { type: DataTypes.STRING(500), allowNull: false },
    appointment_date: { type: DataTypes.DATEONLY, allowNull: true },
    appointment_time: { type: DataTypes.STRING(20), allowNull: true },
    type: { type: DataTypes.STRING(100), allowNull: true },
    with_person: { type: DataTypes.STRING(500), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  { sequelize: db, modelName: 'ClientAppointment', tableName: 'client_appointments', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at' }
);

VendorClient.hasMany(ClientQuery, { foreignKey: 'client_id', as: 'clientQueries' });
ClientQuery.belongsTo(VendorClient, { foreignKey: 'client_id', as: 'client' });

VendorClient.hasMany(ClientDevelopment, { foreignKey: 'client_id', as: 'clientDevelopments' });
ClientDevelopment.belongsTo(VendorClient, { foreignKey: 'client_id', as: 'client' });

VendorClient.hasMany(ClientOrder, { foreignKey: 'client_id', as: 'clientOrders' });
ClientOrder.belongsTo(VendorClient, { foreignKey: 'client_id', as: 'client' });

VendorClient.hasMany(ClientAppointment, { foreignKey: 'client_id', as: 'clientAppointments' });
ClientAppointment.belongsTo(VendorClient, { foreignKey: 'client_id', as: 'client' });

module.exports = { ClientQuery, ClientDevelopment, ClientOrder, ClientAppointment };

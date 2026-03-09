/**
 * Vendor / Client master: single table for both types.
 * entity_code is unique (e.g. EI-VEN-00001, EI-CLI-00001).
 * Extended form data (documents, pocs, banks, vendorItems/productInterests, etc.) in data JSON.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class VendorClient extends Model {}

VendorClient.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    entity_code: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    type: { type: DataTypes.STRING(20), allowNull: false }, // 'vendor' | 'client'
    name: { type: DataTypes.STRING(300), allowNull: true },
    email: { type: DataTypes.STRING(255), allowNull: true },
    phone: { type: DataTypes.STRING(64), allowNull: true },
    location: { type: DataTypes.STRING(200), allowNull: true },
    country: { type: DataTypes.STRING(100), allowNull: true },
    city: { type: DataTypes.STRING(100), allowNull: true },
    category: { type: DataTypes.STRING(100), allowNull: true },
    status: { type: DataTypes.STRING(50), allowNull: true }, // active, inactive, pending
    payment_terms: { type: DataTypes.STRING(100), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    rating: { type: DataTypes.INTEGER, allowNull: true },
    moq: { type: DataTypes.STRING(100), allowNull: true },
    lead_time: { type: DataTypes.STRING(100), allowNull: true },
    data: { type: DataTypes.JSONB, allowNull: true }, // formData + documents, pocs, banks, vendorItems/productInterests
    priority: { type: DataTypes.STRING(20), allowNull: true },
    segment: { type: DataTypes.STRING(200), allowNull: true },
    since_year: { type: DataTypes.INTEGER, allowNull: true },
    revenue_value: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    avatar_color: { type: DataTypes.STRING(50), allowNull: true },
    account_manager_id: { type: DataTypes.INTEGER, allowNull: true },
    contacts: { type: DataTypes.JSONB, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'VendorClient',
    tableName: 'vendor_clients',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = VendorClient;

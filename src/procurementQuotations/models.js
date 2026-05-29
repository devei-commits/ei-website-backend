/**
 * Procurement Quotations — vendor quotes against procurement requests.
 * Procurement team records quotations manually; one request can have multiple quotes from different vendors.
 * items JSON: array of { itemId/code, name, raw_material_id?, pack_material_id?, orderQty, pricePerUnit, uom, totalValue }.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');
const ProcurementRequest = require('../procurementRequests/models');
const VendorClient = require('../vendorClient/models');

class ProcurementQuotation extends Model {}

ProcurementQuotation.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    procurement_request_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'procurement_requests', key: 'id' },
    },
    vendor_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'vendor_clients', key: 'id' },
    },
    quote_date: { type: DataTypes.DATEONLY, allowNull: true },
    quoted_by: { type: DataTypes.STRING(200), allowNull: true },
    attachment_ref: { type: DataTypes.STRING(500), allowNull: true },
    attachment_status: { type: DataTypes.STRING(50), allowNull: true, defaultValue: 'pending' }, // received | pending
    items: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Array of { itemId, name, raw_material_id?, pack_material_id?, orderQty, pricePerUnit, uom, totalValue }',
    },
    lead_time_days: { type: DataTypes.INTEGER, allowNull: true },
    payment_terms: { type: DataTypes.TEXT, allowNull: true },
    valid_till: { type: DataTypes.DATEONLY, allowNull: true },
    total_value: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.STRING(50), allowNull: true, defaultValue: 'pending' }, // confirmed | not_selected | pending
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'ProcurementQuotation',
    tableName: 'procurement_quotations',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

ProcurementQuotation.belongsTo(ProcurementRequest, { foreignKey: 'procurement_request_id', as: 'procurementRequest' });
ProcurementRequest.hasMany(ProcurementQuotation, { foreignKey: 'procurement_request_id' });

ProcurementQuotation.belongsTo(VendorClient, { foreignKey: 'vendor_id', as: 'vendor' });
VendorClient.hasMany(ProcurementQuotation, { foreignKey: 'vendor_id' });

module.exports = ProcurementQuotation;

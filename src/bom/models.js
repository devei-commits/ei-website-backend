const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class BOM extends Model {}

BOM.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    bom_code: { type: DataTypes.STRING(100), allowNull: false },
    bom_sku: { type: DataTypes.STRING(100), allowNull: true },
    zoho_id: { type: DataTypes.STRING(100), allowNull: true },
    bom_category: { type: DataTypes.STRING(100), allowNull: true },
    bom_unit: { type: DataTypes.STRING(20), allowNull: true },
    bom_hsn: { type: DataTypes.STRING(50), allowNull: true },
    bom_tax_preference: { type: DataTypes.STRING(50), allowNull: true },
    bom_returnable: { type: DataTypes.BOOLEAN, allowNull: true },
    bom_associate_items: { type: DataTypes.TEXT, allowNull: true },
    type: { type: DataTypes.STRING(50), allowNull: true },
    status: { type: DataTypes.STRING(50), allowNull: true },
    version: { type: DataTypes.STRING(50), allowNull: true },
    client: { type: DataTypes.STRING(200), allowNull: true },
    name: { type: DataTypes.STRING(300), allowNull: true },
    dosage: { type: DataTypes.STRING(100), allowNull: true },
    pack_size: { type: DataTypes.STRING(50), allowNull: true },
    site: { type: DataTypes.STRING(100), allowNull: true },
    category: { type: DataTypes.STRING(100), allowNull: true },
    claims: { type: DataTypes.TEXT, allowNull: true },
    project: { type: DataTypes.STRING(200), allowNull: true },
    market: { type: DataTypes.STRING(200), allowNull: true },
    created_by: { type: DataTypes.STRING(100), allowNull: true },
    reviewed_by: { type: DataTypes.STRING(100), allowNull: true },
    desc: { type: DataTypes.TEXT, allowNull: true },
    spec_bulk: { type: DataTypes.TEXT, allowNull: true },
    spec_process: { type: DataTypes.TEXT, allowNull: true },
    spec_fg: { type: DataTypes.TEXT, allowNull: true },
    spec_pack: { type: DataTypes.TEXT, allowNull: true },
    spec_tests: { type: DataTypes.TEXT, allowNull: true },
    spec_release: { type: DataTypes.TEXT, allowNull: true },
    batch: { type: DataTypes.STRING(100), allowNull: true },
    yield_pct: { type: DataTypes.STRING(20), allowNull: true },
    overage: { type: DataTypes.STRING(20), allowNull: true },
    line: { type: DataTypes.STRING(100), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    regulatory: { type: DataTypes.TEXT, allowNull: true },
    ph_range: { type: DataTypes.STRING(50), allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    rm_lines: { type: DataTypes.JSON, allowNull: true },
    pm_lines: { type: DataTypes.JSON, allowNull: true },
    process_steps: { type: DataTypes.JSON, allowNull: true },
    stability_summary: { type: DataTypes.TEXT, allowNull: true },
    product_id: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize: db, modelName: 'BOM', tableName: 'boms', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at' }
);

module.exports = BOM;

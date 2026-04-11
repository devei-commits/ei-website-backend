const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

/**
 * Preset packaging choices for the website customize flow (distinct from masters `packaging` table).
 * `option_id` is stored on product_customizations.packagingType.
 */
class CustomizationPackagingOption extends Model {}

CustomizationPackagingOption.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    option_id: {
      type: DataTypes.STRING(80),
      allowNull: false,
      unique: true,
    },
    title: { type: DataTypes.STRING(200), allowNull: false, defaultValue: '' },
    subtitle: { type: DataTypes.STRING(400), allowNull: true },
    review_label: { type: DataTypes.STRING(400), allowNull: true },
    sku_code: { type: DataTypes.STRING(100), allowNull: true },
    is_custom: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    specs: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: {},
    },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'CustomizationPackagingOption',
    tableName: 'customization_packaging_options',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = CustomizationPackagingOption;

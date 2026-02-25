const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class Customization extends Model {}

Customization.init(
  {
    custom_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    concentration: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    active_composition: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    indications: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    how_to_use: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    specifications: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    cautions: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    frequently_asked_questions: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    category: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    incredients: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    care: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize: db,
    modelName: 'Customization',
    tableName: 'customizations',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = Customization;

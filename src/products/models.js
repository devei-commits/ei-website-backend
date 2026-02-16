const { DataTypes, Model } = require('sequelize');
const db = require('../../db');


class Product extends Model {}
Product.init({
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    description: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    stock: {
        type: DataTypes.INTEGER,
        allowNull: false
    }
}, {
    sequelize: db,
    modelName: 'product',
    paranoid: true, // Soft delete
});



class Category extends Model {}
Category.init({
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    }
}, {
    sequelize: db,
    modelName: 'category',
    paranoid: true, // Soft delete
});

Product.belongsTo(Category);
Category.hasMany(Product);

module.exports = { Product, Category };
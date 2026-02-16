const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class User extends Model {}
User.init({
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    password: {
        type: DataTypes.STRING,
        allowNull: false
    },
    gstNumber: {
        type: DataTypes.STRING,
        allowNull: true
    },
    billingAddress: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    shippingAddress: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    paymentTerms: {
        type: DataTypes.STRING,
        allowNull: true
        // e.g. "100% advance", "50% advance / 50% on delivery"
    },
    role: {
        type: DataTypes.ENUM(
            'super_admin',
            'admin',
            'bd_manager',
            'qa_manager',
            'rnd_lead',
            'procurement',
            'manufacturing_production',
            'sales',
            'logistics',
            'design',
            'rnd_staff',
            'qa_staff',
            'bd_staff',
            'doctor',
            'customer'
        ),
        allowNull: false,
        defaultValue: 'customer'
    }
}, {
    sequelize: db,
    modelName: 'user'
});

class RefreshToken extends Model { }
RefreshToken.init({
    email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    refreshToken: {
        type: DataTypes.STRING,
        allowNull: false
    }
}, {
    sequelize: db,
    modelName: 'refreshToken'
});

module.exports = { User, RefreshToken };

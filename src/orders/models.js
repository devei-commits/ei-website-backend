const { DataTypes, Model } = require('sequelize');
const db = require('../../db');
const { User } = require('../users/models');
const { Product } = require('../products/models');

class Order extends Model {}
Order.init({
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    shippingAddress: {
        type: DataTypes.STRING,
        allowNull: false
    },
    shippingCity: {
        type: DataTypes.STRING,
        allowNull: false
    },
    shippingState: {
        type: DataTypes.STRING,
        allowNull: false
    },
    shippingZip: {
        type: DataTypes.STRING,
        allowNull: false
    },
    total: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    paymentStatus: {
        // Mirrors payment_status in legacy schema
        type: DataTypes.ENUM('pending', 'paid', 'failed', 'refunded'),
        allowNull: false,
        defaultValue: 'pending'
    },
    orderDate: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    },
    status: {
        // Overall order lifecycle (shipping/processing)
        type: DataTypes.ENUM('pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'),
        allowNull: false,
        defaultValue: 'pending'
    },
    orderType: {
        type: DataTypes.ENUM('product', 'process'),
        allowNull: false,
        defaultValue: 'product'
    },
    customRequirements: {
        // Free-text description of how the client wants to customize the product/process
        type: DataTypes.TEXT,
        allowNull: true
    },
    rdStatus: {
        // R&D workflow status: submitted, under_review, approved, rejected
        type: DataTypes.ENUM('submitted', 'under_review', 'approved', 'rejected'),
        allowNull: true
    },
    rdNotes: {
        // Internal R&D comments/feedback
        type: DataTypes.TEXT,
        allowNull: true
    }
}, {
    sequelize: db,
    modelName: 'order'
});

class OrderItem extends Model {}
OrderItem.init({
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    quantity: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    }
}, {
    sequelize: db,
    modelName: 'orderItem'
});

class OrderStatusHistory extends Model {}
OrderStatusHistory.init({
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    status: {
        type: DataTypes.STRING,
        allowNull: false
    },
    step: {
        type: DataTypes.STRING,
        allowNull: true
        // e.g. 'PI', 'PO', 'SO', 'MANUFACTURING', 'GR', etc.
    },
    note: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    changedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    }
}, {
    sequelize: db,
    modelName: 'orderStatusHistory'
});


Order.belongsTo(User);
User.hasMany(Order);
Order.hasMany(OrderItem);
OrderItem.belongsTo(Order);
Order.belongsToMany(Product, { through: OrderItem });
Product.belongsToMany(Order, { through: OrderItem });

Order.hasMany(OrderStatusHistory, { as: 'statusHistory' });
OrderStatusHistory.belongsTo(Order);

module.exports = { Order, OrderItem, OrderStatusHistory };
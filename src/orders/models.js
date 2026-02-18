const { DataTypes, Model } = require('sequelize');
const db = require('../../db');
const { User } = require('../users/models');
const { Product } = require('../products/models');
const Address = require('../models/Addresses');

class Order extends Model {}
Order.init({
    order_id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    user_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: User,
            key: 'userid'
        }
    },
    billing_address_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: Address,
            key: 'address_id'
        }
    },
    shipping_address_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: Address,
            key: 'address_id'
        }
    },
    order_status: {
        type: DataTypes.ENUM('pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'),
        allowNull: false,
        defaultValue: 'pending'
    },
    payment_status: {
        type: DataTypes.ENUM('pending', 'paid', 'failed', 'refunded'),
        allowNull: false,
        defaultValue: 'pending'
    },
    subtotal: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    discount_total: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0
    },
    tax_total: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    shipping_total: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    grand_total: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
}, {
    sequelize: db,
    modelName: 'order',
    createdAt: 'created_at',
    updatedAt: false
});

class OrderItem extends Model {}
OrderItem.init({
    order_item_id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    order_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: Order,
            key: 'order_id'
        }
    },
    product_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
            model: Product,
            key: 'product_id'
        }
    },
    sef_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    item_type: {
        type: DataTypes.STRING,
        allowNull: true
    },
    quantity: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    unit_price: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    discount_amount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0
    },
    tax_amount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0
    },
    line_total: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    }
}, {
    sequelize: db,
    modelName: 'orderItem',
    tableName: 'order_items',
    timestamps: false
});




Order.belongsTo(User, { foreignKey: 'user_id' });
User.hasMany(Order, { foreignKey: 'user_id' });

Order.belongsTo(Address, { as: 'billingAddress', foreignKey: 'billing_address_id' });
Order.belongsTo(Address, { as: 'shippingAddress', foreignKey: 'shipping_address_id' });


Order.hasMany(OrderItem, { foreignKey: 'order_id' });
OrderItem.belongsTo(Order, { foreignKey: 'order_id' });
Product.hasMany(OrderItem, { foreignKey: 'product_id' });
OrderItem.belongsTo(Product, { foreignKey: 'product_id' });



module.exports = { Order, OrderItem };
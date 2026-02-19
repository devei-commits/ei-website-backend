const { Order, OrderItem } = require('./models');
const { Product } = require('../products/models');
const { Payment } = require('../payments/models');
const { Address } = require('../models/Addresses');
const { User } = require('../users/models');
const db = require('../../db');
// const { orderSchema, updateOrderSchema } = require('./schemas');


const saveOrder = async (req, res) => {
    const t = await db.transaction();
    try {
        const { billing_address_id, shipping_address_id, order_items, shipping_total = 0, discount_total = 0 } = req.body;
        const user_id = req.user.id;

        if (!order_items || !Array.isArray(order_items) || order_items.length === 0) {
            await t.rollback();
            return res.status(400).json({ error: 'order_items is required and must be a non-empty array' });
        }

        const productIds = [...new Set(order_items.map((item) => Number(item.product_id)).filter(Boolean))];
        const existingProducts = await Product.findAll({
            where: { product_id: productIds },
            attributes: ['product_id', 'advance_percentage'],
        });
        const existingIds = new Set(existingProducts.map((p) => Number(p.product_id)));
        const missingIds = productIds.filter((id) => !existingIds.has(id));
        if (missingIds.length > 0) {
            await t.rollback();
            return res.status(400).json({
                error: 'One or more products in your cart are no longer available.',
                invalidProductIds: missingIds,
            });
        }

        const subtotal = order_items.reduce((acc, item) => acc + (item.unit_price * item.quantity), 0);
        const tax_total = order_items.reduce((acc, item) => acc + (item.tax_amount || 0), 0);
        const grand_total = subtotal + tax_total + shipping_total - discount_total;

        // --- Payment terms resolution ---
        // Build map: product_id -> advance_percentage
        const productAdvanceMap = {};
        existingProducts.forEach((p) => {
            if (p.advance_percentage != null) {
                productAdvanceMap[Number(p.product_id)] = Number(p.advance_percentage);
            }
        });

        const hasProductTerms = order_items.some(
            (item) => productAdvanceMap[Number(item.product_id)] != null
        );

        let advance_amount_due = 0;

        if (hasProductTerms) {
            // Product-level terms take priority — sum per-line advances
            advance_amount_due = order_items.reduce((acc, item) => {
                const pct = productAdvanceMap[Number(item.product_id)];
                if (pct != null) {
                    const lineTotal = Number(item.unit_price) * Number(item.quantity);
                    return acc + (lineTotal * pct) / 100;
                }
                return acc; // no advance for lines without product terms
            }, 0);
            advance_amount_due = Math.round(advance_amount_due * 100) / 100;
        } else {
            // Fallback to user-level payment terms
            const user = await User.findByPk(user_id, {
                attributes: ['advance_payment', 'advance_amount'],
            });
            if (user && user.advance_payment && user.advance_amount != null) {
                advance_amount_due = Math.min(Number(user.advance_amount), grand_total);
                advance_amount_due = Math.round(advance_amount_due * 100) / 100;
            }
        }

        const order = await Order.create({
            user_id,
            billing_address_id,
            shipping_address_id,
            order_status: 'pending',
            payment_status: 'pending',
            subtotal,
            discount_total,
            tax_total,
            shipping_total,
            grand_total,
            advance_amount_due,
        }, { transaction: t });

        const orderItemsToCreate = order_items.map(item => ({
            product_id: Number(item.product_id),
            quantity: Number(item.quantity),
            unit_price: Number(item.unit_price),
            discount_amount: Number(item.discount_amount || 0),
            tax_amount: Number(item.tax_amount || 0),
            order_id: order.order_id,
            line_total: Number(item.unit_price) * Number(item.quantity),
        }));

        await OrderItem.bulkCreate(orderItemsToCreate, { transaction: t });



        await t.commit();

        const result = await Order.findByPk(order.order_id, { include: [OrderItem] });
        return res.status(201).json(result);
    } catch (err) {
        await t.rollback();
        return res.status(400).json({ error: err.message });
    }
};

// Admin roles that can see all orders; others see only their own
const ORDER_ADMIN_ROLES = ['super_admin', 'admin', 'bd_manager'];

const getAllOrders = async (req, res) => {
    try {
        const userId = Number(req.user?.id);
        const isAdmin = req.user && ORDER_ADMIN_ROLES.includes(req.user.role);
        const { status } = req.query;

        const where = isAdmin ? {} : { user_id: userId };
        if (status) {
            where.order_status = status;
        }

        const orders = await Order.findAll({
            where,
            include: [
                OrderItem,
                { model: Payment, as: 'payments', required: false, attributes: ['remainingAmount'] },
            ],
        });
        return res.json(orders);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
const getOrderById = async (req, res) => {
    try {
        const order = await Order.findByPk(req.params.id, { include: [OrderItem] });
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const isAdmin = req.user && ORDER_ADMIN_ROLES.includes(req.user.role);
        if (!isAdmin && order.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Not allowed to view this order' });
        }
        res.json(order);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const updateOrder = async (req, res) => {
    try {
        // const { error } = updateOrderSchema.validate(req.body, { abortEarly: false });
        // if (error) {
        //     return res.status(400).json({ errors: error.details.map(e => e.message) });
        // };
        const order = await Order.findByPk(req.params.id);
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const isAdmin = req.user && ORDER_ADMIN_ROLES.includes(req.user.role);
        if (!isAdmin && order.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Not allowed to update this order' });
        }
        const previousStatus = order.order_status;
        await order.update(req.body);


        res.status(200).json(order);
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: err.message });
    }
};

const deleteOrder = async (req, res) => {
    try {
        const order = await Order.findByPk(req.params.id);
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const isAdmin = req.user && ORDER_ADMIN_ROLES.includes(req.user.role);
        if (!isAdmin && order.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Not allowed to delete this order' });
        }
        await order.destroy();
        res.json({ message: 'Order deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const getOrderStatus = async (req, res) => {
    try {
        const order = await Order.findByPk(req.params.id);
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const isAdmin = req.user && ORDER_ADMIN_ROLES.includes(req.user.role);
        if (!isAdmin && order.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Not allowed to view this order' });
        }
        res.json({ id: order.order_id, status: order.order_status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const getOrdersByUserId = async (req, res) => {
    try {
        const requestedUserId = Number(req.params.userId);
        const isAdmin = req.user && ORDER_ADMIN_ROLES.includes(req.user.role);
        if (!isAdmin && req.user?.id !== requestedUserId) {
            return res.status(403).json({ error: 'Not allowed to view orders for this user' });
        }
        const orders = await Order.findAll({ where: { user_id: requestedUserId }, include: [OrderItem] });
        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};



module.exports = {
    saveOrder,
    getAllOrders,
    getOrderById,
    getOrdersByUserId,
    updateOrder,
    deleteOrder,
    getOrderStatus,
};
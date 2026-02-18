const { Order, OrderItem } = require('./models');
const { Address } = require('../models/Addresses');
const db = require('../../db');
// const { orderSchema, updateOrderSchema } = require('./schemas');


const saveOrder = async (req, res) => {
    const t = await db.transaction();
    try {
        // const { error } = orderSchema.validate(req.body, { abortEarly: false })
        // if (error) {
        //     return res.status(400).json({ errors: error.details.map(e => e.message) });
        // };

        const { billing_address_id, shipping_address_id, order_items, shipping_total = 0, discount_total = 0 } = req.body;
        const user_id = req.user.id;

        const subtotal = order_items.reduce((acc, item) => acc + (item.unit_price * item.quantity), 0);
        const tax_total = order_items.reduce((acc, item) => acc + (item.tax_amount || 0), 0);
        const grand_total = subtotal + tax_total + shipping_total - discount_total;

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
            grand_total
        }, { transaction: t });

        const orderItemsToCreate = order_items.map(item => ({
            ...item,
            order_id: order.order_id,
            line_total: item.unit_price * item.quantity
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

        const orders = await Order.findAll({ where, include: [OrderItem] });
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
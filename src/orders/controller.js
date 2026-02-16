const { Order, OrderStatusHistory } = require('./models');
const { orderSchema, updateOrderSchema } = require('./schemas');


const saveOrder = async (req, res) => {
    try {
        const { error } = orderSchema.validate(req.body, { abortEarly: false })
        if (error) {
            return res.status(400).json({ errors: error.details.map(e => e.message) });
        };
        req.body.total = req.body.orderItems.reduce((acc, item) => acc + item.price * item.quantity, 0);
        const order = await Order.create(req.body, { include: 'orderItems', validate: false });

        // Create initial status history entry
        await OrderStatusHistory.create({
            orderId: order.id,
            status: order.status,
            step: req.body.orderType === 'process' ? 'PI' : 'CREATED',
            note: 'Order created'
        });

        return res.status(201).json(order);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
};

// Admin roles that can see all orders; others see only their own
const ORDER_ADMIN_ROLES = ['super_admin', 'admin', 'bd_manager'];

const getAllOrders = async (req, res) => {
    try {
        const userId = Number(req.user?.id);
        const isAdmin = req.user && ORDER_ADMIN_ROLES.includes(req.user.role);
        const where = isAdmin ? {} : { userId };
        const orders = await Order.findAll({ where, include: 'orderItems' });
        return res.json(orders);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
const getOrderById = async (req, res) => {
    try {
        const order = await Order.findByPk(req.params.id, { include: 'orderItems' });
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const isAdmin = req.user && ORDER_ADMIN_ROLES.includes(req.user.role);
        if (!isAdmin && order.userId !== req.user.id) {
            return res.status(403).json({ error: 'Not allowed to view this order' });
        }
        res.json(order);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const updateOrder = async (req, res) => {
    try {
        const { error } = updateOrderSchema.validate(req.body, { abortEarly: false });
        if (error) {
            return res.status(400).json({ errors: error.details.map(e => e.message) });
        };
        const order = await Order.findByPk(req.params.id);
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const isAdmin = req.user && ORDER_ADMIN_ROLES.includes(req.user.role);
        if (!isAdmin && order.userId !== req.user.id) {
            return res.status(403).json({ error: 'Not allowed to update this order' });
        }
        const previousStatus = order.status;
        await order.update(req.body);

        // If status or orderType changed, append to history
        if (req.body.status || req.body.orderType) {
            await OrderStatusHistory.create({
                orderId: order.id,
                status: order.status,
                step: req.body.step || null,
                note: req.body.note || `Order updated from status ${previousStatus} to ${order.status}`
            });
        }
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
        if (!isAdmin && order.userId !== req.user.id) {
            return res.status(403).json({ error: 'Not allowed to delete this order' });
        }
        await order.destroy();
        res.json({ message: 'Order deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Update R&D status for process orders (submitted -> under_review -> approved/rejected)
const updateProcessRDStatus = async (req, res) => {
    try {
        const { rdStatus, rdNotes } = req.body;
        const allowedStatuses = ['submitted', 'under_review', 'approved', 'rejected'];
        if (!rdStatus || !allowedStatuses.includes(rdStatus)) {
            return res.status(400).json({ error: `rdStatus must be one of: ${allowedStatuses.join(', ')}` });
        }

        const order = await Order.findByPk(req.params.id);
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        if (order.orderType !== 'process') {
            return res.status(400).json({ error: 'R&D status can only be updated for process orders' });
        }

        await order.update({
            rdStatus,
            rdNotes: rdNotes || order.rdNotes
        });

        // Record R&D decision in history
        await OrderStatusHistory.create({
            orderId: order.id,
            status: order.status,
            step: `RND_${rdStatus.toUpperCase()}`,
            note: rdNotes || `R&D status updated to ${rdStatus}`
        });

        return res.status(200).json(order);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
};

const getOrderStatus = async (req, res) => {
    try {
        const order = await Order.findByPk(req.params.id);
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const isAdmin = req.user && ORDER_ADMIN_ROLES.includes(req.user.role);
        if (!isAdmin && order.userId !== req.user.id) {
            return res.status(403).json({ error: 'Not allowed to view this order' });
        }
        res.json({ id: order.id, status: order.status, orderType: order.orderType });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const getOrderHistory = async (req, res) => {
    try {
        const order = await Order.findByPk(req.params.id);
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const isAdmin = req.user && ORDER_ADMIN_ROLES.includes(req.user.role);
        if (!isAdmin && order.userId !== req.user.id) {
            return res.status(403).json({ error: 'Not allowed to view this order' });
        }
        const history = await OrderStatusHistory.findAll({
            where: { orderId: order.id },
            order: [['changedAt', 'ASC']]
        });
        res.json(history);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

module.exports = {
    saveOrder,
    getAllOrders,
    getOrderById,
    updateOrder,
    deleteOrder,
    getOrderStatus,
    getOrderHistory,
    updateProcessRDStatus,
};
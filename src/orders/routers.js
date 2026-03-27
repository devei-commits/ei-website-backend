const express = require('express');
const router = express.Router();
const { requireModule } = require('../middleware/security');
const {
    getAllOrders,
    saveOrder,
    previewCheckout,
    getOrderById,
    getOrdersByUserId,
    updateOrder,
    deleteOrder,
    getOrderStatus
} = require('./controller');

const requireOrderModule = requireModule('order-management', 'order-list');

// Create and view own orders: any authenticated user
router.post('/preview-checkout', previewCheckout);
router.route('/')
    .get(getAllOrders)
    .post(saveOrder);

// View another user's orders: require order-management/order-list
router.get('/user/:userId', requireOrderModule, getOrdersByUserId);

// View own order by id and status: any authenticated user (controller enforces ownership)
router.get('/:id', getOrderById);
router.get('/:id/status', getOrderStatus);

// Update/delete: require order module
router.put('/:id', requireOrderModule, updateOrder);
router.delete('/:id', requireOrderModule, deleteOrder);



module.exports = router;

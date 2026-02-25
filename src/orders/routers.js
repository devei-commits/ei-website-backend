const express = require('express');
const router = express.Router();
const { requireModule } = require('../middleware/security');
const {
    getAllOrders,
    saveOrder,
    getOrderById,
    getOrdersByUserId,
    updateOrder,
    deleteOrder,
    getOrderStatus
} = require('./controller');

router.use(requireModule('order-management', 'order-list'));

// Routes for /
router.route('/')
    .get(getAllOrders)
    .post(saveOrder);

// Routes for /:id
// Routes for /user/:userId
router.route('/user/:userId')
    .get(getOrdersByUserId);

// Routes for /:id
router.route('/:id')
    .get(getOrderById)
    .put(updateOrder)
    .delete(deleteOrder);

// Routes for /:id/status
router.route('/:id/status')
    .get(getOrderStatus);



module.exports = router;

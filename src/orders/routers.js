const express = require('express');
const router = express.Router();
const {
    getAllOrders,
    saveOrder,
    getOrderById,
    updateOrder,
    deleteOrder,
    getOrderStatus,
    getOrderHistory,
    updateProcessRDStatus
} = require('./controller');

router.post('/', saveOrder);
router.get('/', getAllOrders);
router.get('/:id', getOrderById);
router.get('/:id/status', getOrderStatus);
router.get('/:id/history', getOrderHistory);
router.put('/:id', updateOrder);
router.put('/:id/rd-status', updateProcessRDStatus);
router.delete('/:id', deleteOrder);

module.exports = router;

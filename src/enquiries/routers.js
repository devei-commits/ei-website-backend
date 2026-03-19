const express = require('express');
const router = express.Router();
const {
  getTicketTypes,
  createTicket,
  listTickets,
  getTicketById,
  updateTicket,
  addMessage,
} = require('./controller');

// All routes require authentication (enforced by app.js mounting with isAuthenticated)
router.get('/types', getTicketTypes);
router.post('/', createTicket);
router.get('/', listTickets);
router.get('/:id', getTicketById);
router.patch('/:id', updateTicket);
router.put('/:id', updateTicket);
router.post('/:id/messages', addMessage);

module.exports = router;

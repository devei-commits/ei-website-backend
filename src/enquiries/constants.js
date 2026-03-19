/**
 * Ticket categories (category field)
 */
const TICKET_CATEGORIES = [
  'delivery-issue',
  'quotation-request',
  'payment-issue',
  'product-inquiry',
  'partnership',
  'order-issue',
  'refund',
  'other',
];

/**
 * Ticket priorities
 */
const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

/**
 * Ticket statuses
 */
const TICKET_STATUSES = [
  'new',
  'open',
  'in-progress',
  'pending-internal',
  'resolved',
  'closed',
];

/**
 * Ticket sources (how the ticket was created)
 */
const TICKET_SOURCES = ['website', 'email', 'phone', 'chat', 'other'];

/**
 * Activity types for ticket timeline
 */
const ACTIVITY_TYPES = [
  'created',
  'assigned',
  'status-change',
  'priority-change',
  'order-linked',
  'message-added',
  'resolved',
  'reopened',
];

// Legacy: keep for backward compatibility if any code still uses ENQUIRY_TYPES
const ENQUIRY_TYPES = ['product', 'process', 'contact', 'quotation', 'other'];

const DETAILS_SHAPE_BY_TYPE = {
  product: { product_id: 'number', product_name: 'string', question: 'string', quantity: 'number' },
  process: { process_name: 'string', step: 'string', question: 'string' },
  contact: { subject: 'string', message: 'string', phone: 'string' },
  quotation: { product_interest: 'string', quantity: 'number', deadline: 'string', message: 'string', company_name: 'string' },
  other: { subject: 'string', description: 'string', category: 'string' },
};

module.exports = {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_SOURCES,
  ACTIVITY_TYPES,
  ENQUIRY_TYPES,
  DETAILS_SHAPE_BY_TYPE,
};

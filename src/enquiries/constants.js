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
  /** Product Information System / master data issues (cross-team) */
  'pis-issue',
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
const TICKET_SOURCES = [
  'website',
  'email',
  'phone',
  'chat',
  'internal-cross-team',
  /** Raised from EI-Admin enquiry management for a selected portal customer */
  'admin-dashboard',
  'other',
];

/** Teams that can be @tagged on internal tickets (ids stable for API/UI) */
const CROSS_TEAM_TEAMS = [
  { id: 'pis', name: 'PIS (Product Information)' },
  { id: 'warehouse', name: 'Warehouse & Inventory' },
  { id: 'planning', name: 'Planning & Production' },
  { id: 'procurement', name: 'Procurement' },
  { id: 'quality', name: 'Quality & Stability' },
  { id: 'sales-bd', name: 'Sales / BD' },
  { id: 'finance', name: 'Finance' },
  { id: 'customer-support', name: 'Customer Support' },
  { id: 'operations', name: 'Operations' },
];

/**
 * Issue-area tags (include PIS). Used with collaboration.issueAreas.
 */
const TICKET_ISSUE_AREAS = [
  { id: 'pis', label: 'PIS — codes, formulations, product master' },
  { id: 'inventory', label: 'Inventory / stock' },
  { id: 'planning', label: 'Planning / batches' },
  { id: 'procurement', label: 'Procurement / PO' },
  { id: 'quality', label: 'Quality / COA / stability' },
  { id: 'fulfillment', label: 'Fulfillment / dispatch' },
  { id: 'systems', label: 'Systems / integrations' },
  { id: 'other', label: 'Other' },
];

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
  CROSS_TEAM_TEAMS,
  TICKET_ISSUE_AREAS,
};

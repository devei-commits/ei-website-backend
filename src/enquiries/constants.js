/**
 * Allowed enquiry types. Use these when creating/updating enquiries.
 * details payload can contain type-specific keys as below.
 */
const ENQUIRY_TYPES = ['product', 'process', 'contact', 'quotation', 'other'];

/**
 * Suggested details shape per enquiry type (all keys optional; store what you need).
 * Frontend/API can send any subset. Stored in Enquiry.details (JSON).
 */
const DETAILS_SHAPE_BY_TYPE = {
  product: {
    product_id: 'number (optional)',
    product_name: 'string (optional)',
    product_sku: 'string (optional)',
    question: 'string (optional)',
    quantity: 'number (optional)',
    variant: 'string (optional)'
  },
  process: {
    process_name: 'string (optional)',
    step: 'string (optional)',
    question: 'string (optional)',
    reference_id: 'string (optional)'
  },
  contact: {
    subject: 'string (optional)',
    message: 'string (optional)',
    phone: 'string (optional)',
    preferred_time: 'string (optional)',
    topic: 'string (optional)'
  },
  quotation: {
    product_interest: 'string (optional)',
    quantity: 'number (optional)',
    deadline: 'string (optional)',
    message: 'string (optional)',
    company_name: 'string (optional)'
  },
  other: {
    subject: 'string (optional)',
    description: 'string (optional)',
    category: 'string (optional)'
  }
};

module.exports = {
  ENQUIRY_TYPES,
  DETAILS_SHAPE_BY_TYPE
};

const Joi = require('joi');
const {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_SOURCES,
} = require('./constants');

const customerShape = Joi.object({
  id: Joi.string().allow('', null),
  name: Joi.string().required(),
  email: Joi.string().email().required(),
  phone: Joi.string().allow('', null),
  company: Joi.string().allow('', null),
  isRegistered: Joi.boolean().allow(null),
}).unknown(true);

const collaborationSchema = Joi.object({
  taggedMembers: Joi.array()
    .items(
      Joi.object({
        userid: Joi.number().integer().required(),
        displayName: Joi.string().allow('', null),
        email: Joi.string().allow('', null),
      })
    )
    .default([]),
  taggedTeams: Joi.array()
    .items(
      Joi.object({
        id: Joi.string().required(),
        name: Joi.string().allow('', null),
      })
    )
    .default([]),
  issueAreas: Joi.array().items(Joi.string()).default([]),
});

const createTicketSchema = Joi.object({
  subject: Joi.string().max(500).required(),
  description: Joi.string().allow('', null),
  category: Joi.string().valid(...TICKET_CATEGORIES).allow('', null),
  priority: Joi.string().valid(...TICKET_PRIORITIES).allow('', null),
  source: Joi.string().valid(...TICKET_SOURCES).allow('', null),
  tags: Joi.array().items(Joi.string()).allow(null),
  customer: customerShape.allow(null),
  ticket_scope: Joi.string().valid('customer', 'internal').default('customer'),
  collaboration: collaborationSchema.optional().allow(null),
}).unknown(false);

const updateTicketSchema = Joi.object({
  subject: Joi.string().max(500),
  description: Joi.string().allow('', null),
  category: Joi.string().valid(...TICKET_CATEGORIES).allow('', null),
  priority: Joi.string().valid(...TICKET_PRIORITIES).allow('', null),
  status: Joi.string().valid(...TICKET_STATUSES).allow('', null),
  source: Joi.string().valid(...TICKET_SOURCES).allow('', null),
  tags: Joi.array().items(Joi.string()).allow(null),
  ticket_scope: Joi.string().valid('customer', 'internal').allow('', null),
  collaboration: collaborationSchema.optional().allow(null),
  current_assignee: Joi.object({
    staffId: Joi.string(),
    staffName: Joi.string(),
    staffEmail: Joi.string(),
    department: Joi.string(),
    assignedAt: Joi.date().iso(),
    assignedBy: Joi.string(),
    isActive: Joi.boolean(),
  }).allow(null),
  assignment_history: Joi.array().items(Joi.object()).allow(null),
  linked_orders: Joi.array().items(Joi.object()).allow(null),
  messages: Joi.array().items(Joi.object()).allow(null),
  activities: Joi.array().items(Joi.object()).allow(null),
  first_response_at: Joi.date().iso().allow(null),
  sla_deadline: Joi.date().iso().allow(null),
  resolved_at: Joi.date().iso().allow(null),
  resolution_notes: Joi.string().allow('', null),
  response_count: Joi.number().integer().min(0),
}).min(1).unknown(true);

/** Append a message to the ticket (customer or staff) */
const addMessageSchema = Joi.object({
  content: Joi.string().required(),
  isInternal: Joi.boolean().default(false),
}).unknown(false);

/** Legacy enquiry schema (backward compat) */
const enquirySchema = Joi.object({
  enquiry_type: Joi.string().allow('', null),
  details: Joi.object().pattern(Joi.string(), Joi.any()).allow(null),
  status: Joi.string().allow('', null),
});

module.exports = {
  createTicketSchema,
  updateTicketSchema,
  addMessageSchema,
  enquirySchema,
  collaborationSchema,
};

const Joi = require('joi');

const MODES = ['neft', 'rtgs', 'imps', 'upi', 'cheque'];
const INWARD_TYPES = ['invoice', 'advance', 'mixed'];
const VARIANCE_REASONS = ['tds', 'bank_charges', 'short_payment_dispute', 'write_off', 'other'];

const invoiceLinkSchema = Joi.object({
  fulfillmentInvoiceId: Joi.number().integer().allow(null),
  invoiceNo: Joi.string().allow('', null),
  amountApplied: Joi.number().precision(2).min(0).required(),
});

/* ── 5A: Record New Inward Payment ── */
const createInwardSchema = Joi.object({
  type: Joi.string().valid(...INWARD_TYPES).required(),
  clientId: Joi.number().integer().required(),
  bdPocId: Joi.number().integer().allow(null),
  expectedDate: Joi.date().iso().required(),
  expectedAmount: Joi.number().precision(2).min(0).required(),
  expectedTdsPercent: Joi.number().precision(2).min(0).max(100).default(0),
  currency: Joi.string().default('INR'),
  mode: Joi.string().valid(...MODES).allow(null),
  destinationBankAccountId: Joi.number().integer().allow(null),
  invoiceLinks: Joi.array().items(invoiceLinkSchema).default([]),
  // advance / mixed
  advanceAmount: Joi.number().precision(2).min(0).default(0),
  advanceAgainst: Joi.string().allow('', null),
  adjustableOn: Joi.string().allow('', null),
  // commitment proof
  commitmentBasis: Joi.string().allow('', null),
  commitmentAttachmentUrl: Joi.string().uri().allow('', null),
  notes: Joi.string().allow('', null),
})
  // invoice/mixed must link at least one invoice; advance/mixed must carry an advance amount
  .custom((v, helpers) => {
    if ((v.type === 'invoice' || v.type === 'mixed') && (!v.invoiceLinks || v.invoiceLinks.length === 0)) {
      return helpers.message('invoiceLinks required for invoice/mixed types');
    }
    if ((v.type === 'advance' || v.type === 'mixed') && !(v.advanceAmount > 0)) {
      return helpers.message('advanceAmount required for advance/mixed types');
    }
    return v;
  });

/* ── 5B: Confirm Receipt ── */
const varianceSchema = Joi.object({
  reason: Joi.string().valid(...VARIANCE_REASONS).required(),
  amount: Joi.number().precision(2).min(0).required(),
  note: Joi.string().allow('', null),
  tdsQuarter: Joi.string().allow('', null),
  tdsSection: Joi.string().allow('', null),
  form16aUrl: Joi.string().uri().allow('', null),
});

const confirmReceiptSchema = Joi.object({
  actualDate: Joi.date().iso().required(),
  actualAmount: Joi.number().precision(2).min(0).required(),
  actualMode: Joi.string().valid(...MODES).allow(null),
  utrReference: Joi.string().allow('', null),
  receivingBankAccountId: Joi.number().integer().allow(null),
  statementMatched: Joi.boolean().default(false),
  variances: Joi.array().items(varianceSchema).default([]),
  // when the variance can't be fully explained, allow splitting off a PARTIAL remainder
  allowPartial: Joi.boolean().default(false),
});

/* ── 5C: Reschedule ── */
const rescheduleSchema = Joi.object({
  newDate: Joi.date().iso().required(),
  reasonCategory: Joi.string().allow('', null),
  source: Joi.string().allow('', null),
  notes: Joi.string().allow('', null),
  attachmentUrl: Joi.string().uri().allow('', null),
  overrideReason: Joi.string().allow('', null),
  notifyBdPoc: Joi.boolean().default(true),
  updateBdTracker: Joi.boolean().default(true),
  notifyCfo: Joi.boolean().default(false),
});

const holdSchema = Joi.object({ reason: Joi.string().required() });
const writeOffSchema = Joi.object({
  amount: Joi.number().precision(2).min(0).allow(null),
  reason: Joi.string().required(),
});
const cancelSchema = Joi.object({ reason: Joi.string().allow('', null) });

/* ── Gate previews (read-only, no writes) ── */
const previewInwardSchema = Joi.object({
  expectedDate: Joi.date().iso().required(),
  amount: Joi.number().precision(2).min(0).required(),
});
const previewRescheduleSchema = Joi.object({ newDate: Joi.date().iso().required() });

/* ═══════════════════════ Outward Payments (View 3) + Approvals (View 4) ═══════════════════════ */

const SOURCE_MODULES = [
  'procurement', 'regulatory', 'quality', 'hr', 'statutory', 'operating',
  'warehouse', 'fulfillment', 'bd', 'production', 'capex', 'manual',
];
const PAYEE_TYPES = ['vendor', 'employee', 'govt', 'other'];

const createOutwardSchema = Joi.object({
  sourceModule: Joi.string().valid(...SOURCE_MODULES).default('manual'),
  sourceSubtype: Joi.string().allow('', null),
  sourceRefType: Joi.string().allow('', null),
  sourceRefId: Joi.number().integer().allow(null),
  sourceRefLabel: Joi.string().allow('', null),
  payeeType: Joi.string().valid(...PAYEE_TYPES).allow(null),
  payeeId: Joi.number().integer().allow(null),
  payeeName: Joi.string().required(),
  purpose: Joi.string().allow('', null),
  grossAmount: Joi.number().precision(2).min(0).required(),
  tdsPercent: Joi.number().precision(2).min(0).max(100).default(0),
  currency: Joi.string().default('INR'),
  dueDate: Joi.date().iso().required(),
  bankAccountId: Joi.number().integer().allow(null),
  isCapex: Joi.boolean().default(false),
  notes: Joi.string().allow('', null),
  // convenience: create straight into SUBMITTED (build approval chain immediately)
  submit: Joi.boolean().default(false),
  autoApprove: Joi.boolean().default(false),
});

const approveOutwardSchema = Joi.object({
  level: Joi.number().integer().allow(null), // approve a specific step; default = next pending
  overrideReason: Joi.string().allow('', null), // required when gate verdict is "over"
  note: Joi.string().allow('', null),
});
const rejectOutwardSchema = Joi.object({ reason: Joi.string().required() });
const holdOutwardSchema = Joi.object({ reason: Joi.string().required() });
const scheduleOutwardSchema = Joi.object({
  scheduledDate: Joi.date().iso().required(),
  overrideReason: Joi.string().allow('', null),
});
const executeOutwardSchema = Joi.object({
  bankAccountId: Joi.number().integer().required(),
  mode: Joi.string().valid(...MODES).required(),
  utrReference: Joi.string().required(),
  overrideReason: Joi.string().allow('', null),
});
const bulkApproveSchema = Joi.object({
  ids: Joi.array().items(Joi.number().integer()).min(1).required(),
  overrideReason: Joi.string().allow('', null),
});

/* ── Recurring Payments (View 6) ── */
const CADENCES = ['monthly', 'quarterly', 'annual'];
const createRecurringSchema = Joi.object({
  description: Joi.string().required(),
  sourceModule: Joi.string().valid(...SOURCE_MODULES).default('operating'),
  sourceSubtype: Joi.string().allow('', null),
  payeeId: Joi.number().integer().allow(null),
  payeeName: Joi.string().allow('', null),
  amount: Joi.number().precision(2).min(0).required(),
  cadence: Joi.string().valid(...CADENCES).required(),
  nextDueDate: Joi.date().iso().required(),
  bankAccountId: Joi.number().integer().allow(null),
  autoCreateState: Joi.string().valid('draft', 'submitted').default('draft'),
  autoApprove: Joi.boolean().default(false),
  isCapex: Joi.boolean().default(false),
});
const updateRecurringSchema = Joi.object({
  description: Joi.string(),
  sourceModule: Joi.string().valid(...SOURCE_MODULES),
  sourceSubtype: Joi.string().allow('', null),
  payeeId: Joi.number().integer().allow(null),
  payeeName: Joi.string().allow('', null),
  amount: Joi.number().precision(2).min(0),
  cadence: Joi.string().valid(...CADENCES),
  nextDueDate: Joi.date().iso(),
  bankAccountId: Joi.number().integer().allow(null),
  autoCreateState: Joi.string().valid('draft', 'submitted'),
  autoApprove: Joi.boolean(),
  isCapex: Joi.boolean(),
}).min(1);
const generateRecurringSchema = Joi.object({
  asOf: Joi.date().iso().allow(null),
  leadDays: Joi.number().integer().min(0).max(60).default(0),
});

module.exports = {
  MODES,
  INWARD_TYPES,
  VARIANCE_REASONS,
  SOURCE_MODULES,
  PAYEE_TYPES,
  createInwardSchema,
  confirmReceiptSchema,
  rescheduleSchema,
  holdSchema,
  writeOffSchema,
  cancelSchema,
  previewInwardSchema,
  previewRescheduleSchema,
  createOutwardSchema,
  approveOutwardSchema,
  rejectOutwardSchema,
  holdOutwardSchema,
  scheduleOutwardSchema,
  executeOutwardSchema,
  bulkApproveSchema,
  CADENCES,
  createRecurringSchema,
  updateRecurringSchema,
  generateRecurringSchema,
};

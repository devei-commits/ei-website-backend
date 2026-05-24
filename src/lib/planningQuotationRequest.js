/**
 * Planning "Request quotation" procurement requests — quotation workflow only,
 * must not count toward items-involved planned qty / release-to-planning totals.
 */

const PLANNING_QUOTATION_REQUEST_NOTE_TAG = 'Quotation requested from Planning';

/** @param {{ notes?: string | null } | { get?: () => { notes?: string | null } }} pr */
function isPlanningQuotationOnlyProcurementRequest(pr) {
  const plain = pr && typeof pr.get === 'function' ? pr.get({ plain: true }) : pr;
  return String(plain?.notes ?? '').includes(PLANNING_QUOTATION_REQUEST_NOTE_TAG);
}

module.exports = {
  PLANNING_QUOTATION_REQUEST_NOTE_TAG,
  isPlanningQuotationOnlyProcurementRequest,
};

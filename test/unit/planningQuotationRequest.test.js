const {
  isPlanningQuotationOnlyProcurementRequest,
  PLANNING_QUOTATION_REQUEST_NOTE_TAG,
} = require('../../src/lib/planningQuotationRequest');

describe('planningQuotationRequest', () => {
  it('detects planning quotation-only PR by notes tag', () => {
    expect(
      isPlanningQuotationOnlyProcurementRequest({
        notes: `${PLANNING_QUOTATION_REQUEST_NOTE_TAG} · Item A (RM-1)`,
      })
    ).toBe(true);
    expect(isPlanningQuotationOnlyProcurementRequest({ notes: 'Planned group: vendor|||terms|||7' })).toBe(
      false
    );
  });
});

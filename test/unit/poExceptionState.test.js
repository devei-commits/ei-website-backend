const { computeState } = require('../../src/purchaseOrders/exceptionController');

// Minimal Sequelize-row stubs.
// PO is read via get(key); tracking is read via get({ plain: true }) → whole row.
const poStub = (map) => ({ get: (k) => map[k] });
const trkStub = (map) => (map ? { get: () => map } : null);

// PO items totalling ₹5,900 incl. GST (below ₹5L) unless overridden.
const smallItems = [{ itemCode: 'RM1', quantity: 100, rate: 50, tax: 18 }]; // 100*50=5000 +18% = 5900
const bigItems = [{ itemCode: 'RM1', quantity: 10000, rate: 100, tax: 18 }]; // 1,000,000 +18% = 1,180,000

describe('PO exception computeState gating', () => {
  test('active approved PO: can hold / amend / cancel, not resume', () => {
    const s = computeState(
      poStub({ id: 1, status: 'Released', items: smallItems, approval_status: 'approved', exception_status: null, amendment_count: 0 }),
      trkStub({ po_released_at: '2026-07-10' }),
    );
    expect(s.canHold).toBe(true);
    expect(s.canAmend).toBe(true);
    expect(s.canCancel).toBe(true);
    expect(s.canResume).toBe(false);
    expect(s.requiresCfoToCancel).toBe(false);
  });

  test('on hold: can resume, cannot hold/amend', () => {
    const s = computeState(
      poStub({ id: 1, status: 'Released', items: smallItems, approval_status: 'approved', exception_status: 'on_hold', amendment_count: 0 }),
      trkStub({ po_released_at: '2026-07-10' }),
    );
    expect(s.onHold).toBe(true);
    expect(s.canResume).toBe(true);
    expect(s.canHold).toBe(false);
    expect(s.canAmend).toBe(false);
  });

  test('GRN complete: cannot cancel or amend', () => {
    const s = computeState(
      poStub({ id: 1, status: 'Released', items: smallItems, approval_status: 'approved', exception_status: null, amendment_count: 0 }),
      trkStub({ po_released_at: '2026-07-10', vendor_confirmed_at: '2026-07-11', shipped_at: '2026-07-12', grn_complete_at: '2026-07-14' }),
    );
    expect(s.grnComplete).toBe(true);
    expect(s.canCancel).toBe(false);
    expect(s.canAmend).toBe(false);
    expect(s.canHold).toBe(true); // hold still allowed
  });

  test('shipped (pre-GRN): cannot amend, can still cancel', () => {
    const s = computeState(
      poStub({ id: 1, status: 'In Transit', items: smallItems, approval_status: 'approved', exception_status: null, amendment_count: 1 }),
      trkStub({ po_released_at: '2026-07-10', vendor_confirmed_at: '2026-07-11', shipped_at: '2026-07-12' }),
    );
    expect(s.shipped).toBe(true);
    expect(s.canAmend).toBe(false);
    expect(s.canCancel).toBe(true);
    expect(s.amendmentCount).toBe(1);
  });

  test('amount above ₹5L → requiresCfoToCancel', () => {
    const s = computeState(
      poStub({ id: 1, status: 'Released', items: bigItems, approval_status: 'approved', exception_status: null, amendment_count: 0 }),
      trkStub({ po_released_at: '2026-07-10' }),
    );
    expect(s.requiresCfoToCancel).toBe(true);
  });

  test('not yet approved and not sent → cannot amend', () => {
    const s = computeState(
      poStub({ id: 1, status: 'Draft', items: smallItems, approval_status: 'under_review', exception_status: null, amendment_count: 0 }),
      trkStub(null),
    );
    expect(s.canAmend).toBe(false);
    expect(s.canHold).toBe(true);
    expect(s.canCancel).toBe(true);
  });

  // purchase_orders.status stays 'Draft' for the entire pre-release pipeline (submit / forward /
  // approve / reject only ever touch approval_status) — so every revert-to-draft case below uses
  // status: 'Draft' throughout, exactly like a real in-flight PO.

  test('under review, not yet approved → can revert to Draft (fills the gap Amend leaves)', () => {
    const s = computeState(
      poStub({ id: 1, status: 'Draft', items: smallItems, approval_status: 'under_review', exception_status: null, amendment_count: 0 }),
      trkStub(null),
    );
    expect(s.canAmend).toBe(false);
    expect(s.canRevertToDraft).toBe(true);
  });

  test('rejected → can revert to Draft', () => {
    const s = computeState(
      poStub({ id: 1, status: 'Draft', items: smallItems, approval_status: 'rejected', exception_status: null, amendment_count: 0 }),
      trkStub(null),
    );
    expect(s.canRevertToDraft).toBe(true);
  });

  test('changes requested → can revert to Draft', () => {
    const s = computeState(
      poStub({ id: 1, status: 'Draft', items: smallItems, approval_status: 'changes_requested', exception_status: null, amendment_count: 0 }),
      trkStub(null),
    );
    expect(s.canRevertToDraft).toBe(true);
  });

  test('not yet submitted (never entered workflow) → cannot revert to Draft (already there)', () => {
    const s = computeState(
      poStub({ id: 1, status: 'Draft', items: smallItems, approval_status: 'not_submitted', exception_status: null, amendment_count: 0 }),
      trkStub(null),
    );
    expect(s.canRevertToDraft).toBe(false);
  });

  test('approved / sent / released → cannot revert to Draft, use Amend instead', () => {
    const s = computeState(
      poStub({ id: 1, status: 'Released', items: smallItems, approval_status: 'approved', exception_status: null, amendment_count: 0 }),
      trkStub({ po_released_at: '2026-07-10' }),
    );
    expect(s.canAmend).toBe(true);
    expect(s.canRevertToDraft).toBe(false);
  });

  test('on hold / GRN complete / shipped → cannot revert to Draft', () => {
    const onHold = computeState(
      poStub({ id: 1, status: 'Draft', items: smallItems, approval_status: 'under_review', exception_status: 'on_hold', amendment_count: 0 }),
      trkStub(null),
    );
    expect(onHold.canRevertToDraft).toBe(false);

    // Sent-and-shipped implies it was approved and released already — Amend's territory, not this.
    const shipped = computeState(
      poStub({ id: 1, status: 'In Transit', items: smallItems, approval_status: 'approved', exception_status: null, amendment_count: 0 }),
      trkStub({ po_released_at: '2026-07-10', shipped_at: '2026-07-12' }),
    );
    expect(shipped.canRevertToDraft).toBe(false);
    expect(shipped.canAmend).toBe(false); // shipped is past Amend's window too
  });

  test('legacy Released PO with no tracking row and no approval_status → can still amend', () => {
    // Older POs can carry status 'Released' without ever having a po_tracking row (or one
    // whose po_released_at was never stamped) and without approval_status set, since both
    // predate that data being captured. status === 'Released' alone must still be honored,
    // since the release gate itself already required approval at the time it happened.
    const s = computeState(
      poStub({ id: 1, status: 'Released', items: smallItems, approval_status: null, exception_status: null, amendment_count: 0 }),
      trkStub(null),
    );
    expect(s.canAmend).toBe(true);
    expect(s.canHold).toBe(true);
    expect(s.canCancel).toBe(true);
  });

  test('completed PO: no hold / cancel / amend', () => {
    const s = computeState(
      poStub({ id: 1, status: 'Completed', items: smallItems, approval_status: 'approved', exception_status: null, amendment_count: 0 }),
      trkStub({ po_released_at: '2026-07-10', grn_complete_at: '2026-07-14' }),
    );
    expect(s.canHold).toBe(false);
    expect(s.canCancel).toBe(false);
    expect(s.canAmend).toBe(false);
  });

  test('cancelled PO reflects terminal flags', () => {
    const s = computeState(
      poStub({ id: 1, status: 'Cancelled', items: smallItems, approval_status: 'approved', exception_status: 'cancelled', exception_reason: 'dup', amendment_count: 0 }),
      trkStub(null),
    );
    expect(s.cancelled).toBe(true);
    expect(s.canCancel).toBe(false);
    expect(s.canHold).toBe(false);
    expect(s.canAmend).toBe(false);
  });
});

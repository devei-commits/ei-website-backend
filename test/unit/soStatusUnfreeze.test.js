/**
 * Cancelling an SO freezes the fulfillment row (`so_status='cancelled'`,
 * `manual_status_override=true`) so nothing recomputes over it. Moving the SO back to Draft only
 * rewrote sales_orders.status, leaving the freeze in place — so every fulfillment view kept showing
 * "Cancelled" while the sales order really was Draft (prod SO-00110).
 *
 * This pins the un-freeze decision itself, which is the part that was missing.
 */
const SO_STATUS_TO_COMMERCIAL = {
  draft: 'draft', approved: 'approved', confirmed: 'received',
  closed: 'closed', cancelled: 'cancelled', canceled: 'cancelled',
};

/** Mirrors the branch in updateOrder(): what the fulfillment row should become. */
function nextFulfillmentState(key, current) {
  const out = { commercial_status: SO_STATUS_TO_COMMERCIAL[key] };
  const leavingCancelled =
    key !== 'cancelled' && key !== 'canceled' &&
    (String(current.so_status || '').toLowerCase() === 'cancelled' || current.manual_status_override === true);
  if (leavingCancelled) {
    out.manual_status_override = key === 'closed';
    out.so_status = key === 'closed' ? 'closed' : 'planned';
  }
  return out;
}

const cancelled = { so_status: 'cancelled', manual_status_override: true };

describe('leaving Cancelled', () => {
  it('un-freezes the row so the status stops reading Cancelled', () => {
    expect(nextFulfillmentState('draft', cancelled)).toEqual({
      commercial_status: 'draft', manual_status_override: false, so_status: 'planned',
    });
  });

  it('applies to every non-cancelled target status', () => {
    for (const key of ['draft', 'approved', 'confirmed']) {
      const out = nextFulfillmentState(key, cancelled);
      expect(out.manual_status_override).toBe(false);
      expect(out.so_status).toBe('planned');
    }
  });

  it('keeps Closed frozen — that is its own deliberate freeze, not a leftover', () => {
    expect(nextFulfillmentState('closed', cancelled)).toEqual({
      commercial_status: 'closed', manual_status_override: true, so_status: 'closed',
    });
  });

  it('leaves a cancel alone rather than un-freezing it', () => {
    expect(nextFulfillmentState('cancelled', cancelled)).toEqual({ commercial_status: 'cancelled' });
    expect(nextFulfillmentState('canceled', cancelled)).toEqual({ commercial_status: 'cancelled' });
  });

  it('does not touch a row that was never frozen', () => {
    const live = { so_status: 'planned', manual_status_override: false };
    expect(nextFulfillmentState('approved', live)).toEqual({ commercial_status: 'approved' });
  });

  it('un-freezes a row frozen by the override flag alone', () => {
    const out = nextFulfillmentState('draft', { so_status: 'shipped', manual_status_override: true });
    expect(out.manual_status_override).toBe(false);
  });
});

/**
 * BOM confirmation is per BATCH, not per planning row.
 *
 * Each planning batch keeps its own rm_lines/pm_lines and they can be edited independently, so a
 * second batch on the same PR inherited batch 1's sign-off and the formula that actually went to
 * the floor was never re-checked.
 */

/** Is this batch cleared to be sent to production? */
function batchBomConfirmed(batch) {
  return Boolean(batch && batch.bom_confirmed_at);
}

/** What the update handler does to the sign-off when the formula is edited. */
function nextConfirmationOnEdit(batch, body) {
  const bomEdited = Array.isArray(body.rmLines) || Array.isArray(body.pmLines);
  if (bomEdited && body.bomConfirmedAt === undefined) return null;
  return batch.bom_confirmed_at;
}

const AT = '2026-08-24T10:00:00.000Z';

describe('per-batch BOM confirmation', () => {
  it('treats a new batch as unconfirmed even when a sibling was confirmed', () => {
    const b1 = { sequence: 1, bom_confirmed_at: AT };
    const b2 = { sequence: 2, bom_confirmed_at: null };
    expect(batchBomConfirmed(b1)).toBe(true);
    expect(batchBomConfirmed(b2)).toBe(false);
  });

  it('withdraws the sign-off when the batch formula is edited', () => {
    const batch = { bom_confirmed_at: AT };
    expect(nextConfirmationOnEdit(batch, { rmLines: [{ rm_code: 'X' }] })).toBeNull();
    expect(nextConfirmationOnEdit(batch, { pmLines: [{ pm_code: 'Y' }] })).toBeNull();
  });

  it('leaves the sign-off alone when the edit does not touch the formula', () => {
    const batch = { bom_confirmed_at: AT };
    expect(nextConfirmationOnEdit(batch, { sizeKg: 100 })).toBe(AT);
  });

  it('lets an explicit bomConfirmedAt in the same request win over the auto-withdraw', () => {
    const batch = { bom_confirmed_at: AT };
    expect(nextConfirmationOnEdit(batch, { rmLines: [], bomConfirmedAt: AT })).toBe(AT);
  });

  it('reads a missing or malformed batch as unconfirmed rather than throwing', () => {
    expect(batchBomConfirmed(null)).toBe(false);
    expect(batchBomConfirmed({})).toBe(false);
    expect(batchBomConfirmed({ bom_confirmed_at: '' })).toBe(false);
  });
});

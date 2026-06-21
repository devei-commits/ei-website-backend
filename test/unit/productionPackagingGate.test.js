/**
 * Mirrors production/controller.js packaging gate helpers.
 */
const PACKAGING_GATE_MESSAGE = 'Packaging cannot start until BMR bulk QC is cleared';

function isBmrBulkCleared(plain) {
  return String(plain?.bmr_status || '').toLowerCase() === 'cleared';
}

function assertPackagingRequiresBmrCleared(prevPlain, nextPlain) {
  if (isBmrBulkCleared(nextPlain)) return null;
  if (!prevPlain.pm_reserved && nextPlain.pm_reserved) return PACKAGING_GATE_MESSAGE;
  const prevBpr = String(prevPlain.bpr_status || 'draft').toLowerCase();
  const nextBpr = String(nextPlain.bpr_status || 'draft').toLowerCase();
  if (nextBpr !== prevBpr && nextBpr !== 'draft') return PACKAGING_GATE_MESSAGE;
  return null;
}

describe('production packaging gate', () => {
  it('blocks PM reserve before BMR cleared', () => {
    const prev = { bmr_status: 'in_production', bpr_status: 'draft', pm_reserved: false };
    const next = { bmr_status: 'in_production', bpr_status: 'pm_reserved', pm_reserved: true };
    expect(assertPackagingRequiresBmrCleared(prev, next)).toBe(PACKAGING_GATE_MESSAGE);
  });

  it('allows PM reserve after BMR cleared', () => {
    const prev = { bmr_status: 'bulk_qc', bpr_status: 'draft', pm_reserved: false };
    const next = { bmr_status: 'cleared', bpr_status: 'pm_reserved', pm_reserved: true };
    expect(assertPackagingRequiresBmrCleared(prev, next)).toBeNull();
  });

  it('allows BPR rewind to draft on unreserve', () => {
    const prev = { bmr_status: 'in_production', bpr_status: 'pm_reserved', pm_reserved: true };
    const next = { bmr_status: 'in_production', bpr_status: 'draft', pm_reserved: false };
    expect(assertPackagingRequiresBmrCleared(prev, next)).toBeNull();
  });
});

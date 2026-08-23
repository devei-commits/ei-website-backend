/**
 * The release gate reads `approval_status` off the loaded PO row. `updatePurchaseOrder` loaded that
 * row with PO_SAFE_ATTRIBUTES, which does not select the column — so the getter returned undefined
 * and EVERY release was refused with PO_NOT_APPROVED, whatever the database held.
 *
 * DPO-021 (id 1307) had approval_status 'approved' and still could not be released.
 */

/** The gate, exactly as written in updatePurchaseOrder. */
function releaseRefused(row) {
  const appr = String(row.get('approval_status') || '').trim().toLowerCase();
  return appr !== 'approved';
}

/** A Sequelize-ish row that only exposes the attributes it was selected with. */
const rowWith = (selected, data) => ({
  get: (k) => (selected.includes(k) ? data[k] : undefined),
});

const SAFE = ['id', 'order_id', 'status', 'form_data', 'items'];
const READ = [...SAFE, 'approval_status', 'approved_at', 'po_type'];
const DATA = { id: 1307, order_id: 'DPO-021', status: 'Draft', approval_status: 'approved' };

describe('release approval gate', () => {
  it('refuses an approved PO when the column was not selected — the reported bug', () => {
    expect(releaseRefused(rowWith(SAFE, DATA))).toBe(true);
  });

  it('allows it once the row is read with the approval columns', () => {
    expect(releaseRefused(rowWith(READ, DATA))).toBe(false);
  });

  it('still refuses a genuinely unapproved PO', () => {
    for (const v of ['not_submitted', 'under_review', 'under_approval', 'rejected', null, '']) {
      expect(releaseRefused(rowWith(READ, { ...DATA, approval_status: v }))).toBe(true);
    }
  });

  it('tolerates casing and padding on a real approval', () => {
    expect(releaseRefused(rowWith(READ, { ...DATA, approval_status: '  Approved ' }))).toBe(false);
  });
});

describe('attribute lists', () => {
  const { PO_READ_ATTRIBUTES_FOR_TEST } = (() => {
    // Re-derive from the controller source so the test fails if the column is dropped from the list.
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/purchaseOrders/controller.js'), 'utf8');
    return { PO_READ_ATTRIBUTES_FOR_TEST: src };
  })();

  it('reads the update row with PO_READ_ATTRIBUTES, not PO_SAFE_ATTRIBUTES', () => {
    const updateFn = PO_READ_ATTRIBUTES_FOR_TEST.slice(
      PO_READ_ATTRIBUTES_FOR_TEST.indexOf('async function updatePurchaseOrder'),
      PO_READ_ATTRIBUTES_FOR_TEST.indexOf('async function updatePurchaseOrder') + 1200,
    );
    expect(updateFn).toContain('PO_READ_ATTRIBUTES');
  });

  it('keeps approval_status in the approval column list', () => {
    expect(PO_READ_ATTRIBUTES_FOR_TEST).toMatch(/const PO_APPROVAL_COLUMNS = \[[\s\S]*?'approval_status'/);
  });
});

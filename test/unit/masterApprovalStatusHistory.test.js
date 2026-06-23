const {
  formatHistoryRow,
  readActorFromReq,
} = require('../../src/lib/masterApprovalStatusHistory');

describe('masterApprovalStatusHistory', () => {
  test('readActorFromReq maps req.user', () => {
    const actor = readActorFromReq({
      user: { id: 42, fullName: 'Jane Doe', email: 'jane@example.com' },
    });
    expect(actor).toEqual({ userId: 42, displayName: 'Jane Doe' });
  });

  test('formatHistoryRow maps db columns to API shape', () => {
    const row = formatHistoryRow({
      id: 1,
      master_kind: 'RM',
      master_id: 99,
      master_code: 'EI-RM-001',
      from_status: 'Draft',
      to_status: 'Under Review',
      changed_by_user_id: 7,
      changed_by_display_name: 'Reviewer',
      source: 'advance',
      note: null,
      created_at: '2026-06-23T10:00:00.000Z',
    });
    expect(row).toMatchObject({
      id: 1,
      masterKind: 'RM',
      masterId: 99,
      masterCode: 'EI-RM-001',
      fromStatus: 'Draft',
      toStatus: 'Under Review',
      changedByUserId: 7,
      changedByDisplayName: 'Reviewer',
      source: 'advance',
    });
  });
});

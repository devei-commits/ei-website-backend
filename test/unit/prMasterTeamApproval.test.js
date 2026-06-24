const {
  readApprovalTeamPending,
  formatPendingForApi,
  resolveCallerTeamKey,
  canPrTeamMemberAct,
} = require('../../src/lib/prMasterTeamApproval');

describe('prMasterTeamApproval', () => {
  test('readApprovalTeamPending parses API shape', () => {
    const pending = readApprovalTeamPending({
      from_status: 'Under Review',
      target_status: 'Under Approval',
      rm_signed_at: '2026-01-01T00:00:00.000Z',
      rm_signed_by: { user_id: 5, display_name: 'RM User', role_name: 'QA' },
      pack_signed_at: null,
    });
    expect(pending?.fromStatus).toBe('Under Review');
    expect(pending?.targetStatus).toBe('Under Approval');
    expect(pending?.rmSignedBy?.userId).toBe(5);
    expect(pending?.packSignedAt).toBeNull();
  });

  test('resolveCallerTeamKey matches assignees', () => {
    const teams = {
      rm_team: { userId: 10, displayName: 'A', roleName: null },
      pack_team: { userId: 20, displayName: 'B', roleName: null },
    };
    expect(resolveCallerTeamKey(10, teams)).toBe('rm_team');
    expect(resolveCallerTeamKey(20, teams)).toBe('pack_team');
    expect(resolveCallerTeamKey(99, teams)).toBeNull();
  });

  test('canPrTeamMemberAct blocks duplicate rm sign-off when pending', () => {
    const teams = {
      rm_team: { userId: 10, displayName: 'A', roleName: null },
      pack_team: { userId: 20, displayName: 'B', roleName: null },
    };
    const pending = {
      fromStatus: 'Draft',
      targetStatus: 'Under Review',
      rmSignedAt: '2026-01-01T00:00:00.000Z',
      rmSignedBy: teams.rm_team,
      rmNote: null,
      packSignedAt: null,
      packSignedBy: null,
      packNote: null,
    };
    const req = { user: { id: 10 } };
    expect(canPrTeamMemberAct(req, teams, pending)).toBe(false);
    expect(canPrTeamMemberAct({ user: { id: 20 } }, teams, pending)).toBe(true);
  });

  test('formatPendingForApi round-trips keys', () => {
    const api = formatPendingForApi({
      fromStatus: 'Under Review',
      targetStatus: 'Under Approval',
      rmSignedAt: null,
      rmSignedBy: null,
      rmNote: null,
      packSignedAt: '2026-01-02T00:00:00.000Z',
      packSignedBy: { userId: 3, displayName: 'Pack', roleName: null },
      packNote: 'ok',
    });
    expect(api.target_status).toBe('Under Approval');
    expect(api.pack_signed_by.user_id).toBe(3);
  });
});

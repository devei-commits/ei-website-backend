jest.mock('../../src/lib/masterApprovalStatusHistory', () => ({
  recordMasterApprovalStatusHistory: jest.fn(async () => null),
  readActorFromReq: (req) => ({
    userId: req && req.user ? req.user.id : null,
    displayName: req && req.user ? req.user.email : null,
  }),
}));
jest.mock('../../src/lib/masterApprovalAuth', () => ({
  hasMasterApprovalTeamAccess: jest.fn(async () => true),
}));
jest.mock('../../src/middleware/security', () => ({
  isPrivilegedRole: (u) => !!u && u.role === 'admin',
}));
jest.mock('../../src/lib/masterApprovalAssignee', () => ({
  readMasterApprovalStageAssignees: (record) => {
    const d = record && typeof record.get === 'function' ? record.get({ plain: true }) : record || {};
    return {
      drafter: null,
      reviewer: null,
      approver: null,
      rm_team: d.approval_stage_assignees?.rm_team ?? null,
      pack_team: d.approval_stage_assignees?.pack_team ?? null,
    };
  },
}));

const {
  detectChangedSections,
  deriveOverallStatus,
  readTrackApprovals,
  emptyTrackApprovals,
  applyTrackAction,
  canEditTrackSection,
  canActOnTrack,
  readTrackOwner,
} = require('../../src/lib/prTrackApproval');

function makeRow(init) {
  let data = { ...init };
  return {
    get: () => ({ ...data }),
    update: async (patch) => {
      Object.assign(data, patch);
      return true;
    },
    _data: () => data,
  };
}

const HOOKS = {
  readMasterId: (r) => r.get().product_id,
  readMasterCode: (r) => r.get().product_code ?? null,
};

describe('prTrackApproval', () => {
  test('deriveOverallStatus: Draft / Under Approval / Active', () => {
    const t = emptyTrackApprovals();
    expect(deriveOverallStatus(t)).toBe('Draft');
    t.rm.status = 'Sent for Approval';
    expect(deriveOverallStatus(t)).toBe('Under Approval');
    t.rm.status = 'Approved';
    expect(deriveOverallStatus(t)).toBe('Under Approval'); // pm still Draft
    t.pm.status = 'Approved';
    expect(deriveOverallStatus(t)).toBe('Active');
  });

  test('detectChangedSections diffs RM and PM lines vs stored BOM', () => {
    const bom = { rm_lines: [{ id: 1, pct: 10 }], pm_lines: [{ id: 9 }], process_steps: [] };
    expect(detectChangedSections({ rm_lines: [{ id: 1, pct: 10 }] }, bom)).toEqual({ rm: false, pm: false });
    expect(detectChangedSections({ rm_lines: [{ id: 1, pct: 12 }] }, bom)).toEqual({ rm: true, pm: false });
    expect(detectChangedSections({ pm_lines: [{ id: 9 }, { id: 10 }] }, bom)).toEqual({ rm: false, pm: true });
    // key ordering must not register as a change
    expect(detectChangedSections({ rm_lines: [{ pct: 10, id: 1 }] }, bom)).toEqual({ rm: false, pm: false });
  });

  test('detectChangedSections attributes process_steps by step_kind, not as one PM blob', () => {
    const bom = { process_steps: [] };
    // missing/unrecognized step_kind defaults to 'production' (RM) — matches the frontend default.
    expect(detectChangedSections({ process_steps: [{ n: 1 }] }, bom)).toEqual({ rm: true, pm: false });
    expect(detectChangedSections({ process_steps: [{ n: 1, step_kind: 'production' }] }, bom))
      .toEqual({ rm: true, pm: false });
    expect(detectChangedSections({ process_steps: [{ n: 1, step_kind: 'packaging' }] }, bom))
      .toEqual({ rm: false, pm: true });
    expect(detectChangedSections(
      { process_steps: [{ n: 1, step_kind: 'production' }, { n: 2, step_kind: 'packaging' }] },
      bom
    )).toEqual({ rm: true, pm: true });

    // editing only the packaging-kind rows leaves an unrelated production-kind row's absence
    // from the diff a non-change — i.e. rm stays false when only its own rows are untouched.
    const bomWithBoth = {
      process_steps: [{ n: 1, step_kind: 'production' }, { n: 2, step_kind: 'packaging' }],
    };
    expect(detectChangedSections(
      { process_steps: [{ n: 1, step_kind: 'production' }, { n: 2, step_kind: 'packaging', desc: 'updated' }] },
      bomWithBoth
    )).toEqual({ rm: false, pm: true });
  });

  test('full dual-track flow reaches Active only after both approve', async () => {
    const row = makeRow({
      product_id: 1,
      product_code: 'PR-1',
      pr_track_approvals: null,
      approval_stage_assignees: { rm_team: { userId: 11 }, pack_team: { userId: 22 } },
    });
    const rm = { user: { id: 11, email: 'rm@x' } };
    const pm = { user: { id: 22, email: 'pm@x' } };

    let r = await applyTrackAction({ req: rm, row, track: 'rm', action: 'send', hooks: HOOKS });
    expect(r.overall).toBe('Under Approval');
    r = await applyTrackAction({ req: rm, row, track: 'rm', action: 'approve', hooks: HOOKS });
    expect(r.overall).toBe('Under Approval');
    r = await applyTrackAction({ req: pm, row, track: 'pm', action: 'send', hooks: HOOKS });
    r = await applyTrackAction({ req: pm, row, track: 'pm', action: 'approve', hooks: HOOKS });
    expect(r.overall).toBe('Active');
    expect(row._data().status).toBe('Active');
    const tracks = readTrackApprovals(row);
    expect(tracks.rm.status).toBe('Approved');
    expect(tracks.rm.approved_by.user_id).toBe(11);
    expect(tracks.pm.approved_by.user_id).toBe(22);
  });

  test('approve before send is rejected', async () => {
    const row = makeRow({ product_id: 2, product_code: 'PR-2', pr_track_approvals: null, approval_stage_assignees: {} });
    const r = await applyTrackAction({ req: { user: { id: 5 } }, row, track: 'rm', action: 'approve', hooks: HOOKS });
    expect(r.error).toBeTruthy();
    expect(r.code).toBe('PR_TRACK_NOT_SENT');
  });

  test('section lock: non-owner cannot edit an owned section; owner can', async () => {
    const row = makeRow({ approval_stage_assignees: { rm_team: { userId: 11 }, pack_team: null } });
    expect(readTrackOwner(row, 'rm').userId).toBe(11);
    // owner
    expect(await canEditTrackSection({ user: { id: 11 } }, row, 'rm')).toBe(true);
    // non-owner, non-admin
    expect(await canEditTrackSection({ user: { id: 99 } }, row, 'rm')).toBe(false);
    // admin bypass
    expect(await canEditTrackSection({ user: { id: 99, role: 'admin' } }, row, 'rm')).toBe(true);
    // pm slot open → team-access user may take it
    expect(await canActOnTrack({ user: { id: 77 } }, row, 'pm')).toBe(true);
  });
});

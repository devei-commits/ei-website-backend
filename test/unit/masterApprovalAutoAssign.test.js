const {
  readApprovalStatusFromMasterRow,
  applyAutoAssignDrafterOnCreate,
  buildAutoAssignPatchForOpenStage,
} = require('../../src/lib/masterApprovalAutoAssign');

jest.mock('../../src/lib/masterApprovalAssignee', () => {
  const actual = jest.requireActual('../../src/lib/masterApprovalAssignee');
  return {
    ...actual,
    buildStageSlotForUserId: jest.fn(),
  };
});

const { buildStageSlotForUserId } = require('../../src/lib/masterApprovalAssignee');

describe('masterApprovalAutoAssign', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildStageSlotForUserId.mockResolvedValue({
      userId: 42,
      displayName: 'Jane Doe',
      roleName: 'Admin',
    });
  });

  test('readApprovalStatusFromMasterRow reads RM column then form_data', () => {
    expect(
      readApprovalStatusFromMasterRow('RM', {
        status: 'Under Review',
        form_data: { masterApprovalStatus: 'Draft' },
      })
    ).toBe('Under Review');
    expect(
      readApprovalStatusFromMasterRow('PM', {
        form_data: { masterApprovalStatus: 'Under Approval' },
      })
    ).toBe('Under Approval');
    expect(
      readApprovalStatusFromMasterRow('PR', {
        status: 'Active',
        lifecycle_status: 'Draft',
      })
    ).toBe('Active');
  });

  test('applyAutoAssignDrafterOnCreate sets drafter when slot is open', async () => {
    const req = { user: { id: 42, fullName: 'Jane Doe' } };
    const fields = {};
    await applyAutoAssignDrafterOnCreate(req, fields);
    expect(fields.approval_stage_assignees.drafter).toMatchObject({
      user_id: 42,
      display_name: 'Jane Doe',
    });
  });

  test('applyAutoAssignDrafterOnCreate does not override existing drafter', async () => {
    const req = { user: { id: 42, fullName: 'Jane Doe' } };
    const fields = {
      approval_stage_assignees: {
        drafter: { user_id: 9, display_name: 'Existing', role_name: null },
        reviewer: null,
        approver: null,
      },
    };
    await applyAutoAssignDrafterOnCreate(req, fields);
    expect(fields.approval_stage_assignees.drafter.user_id).toBe(9);
    expect(buildStageSlotForUserId).not.toHaveBeenCalled();
  });

  test('buildAutoAssignPatchForOpenStage assigns reviewer at Under Review', async () => {
    const req = { user: { id: 7, fullName: 'Bob' } };
    const row = {
      approval_stage_assignees: {
        drafter: { user_id: 1, display_name: 'Alice', role_name: null },
        reviewer: null,
        approver: null,
      },
    };
    const patch = await buildAutoAssignPatchForOpenStage(req, row, 'Under Review');
    expect(patch).toMatchObject({
      approval_stage_assignees: {
        reviewer: { user_id: 42, display_name: 'Jane Doe', role_name: 'Admin' },
      },
    });
  });

  test('buildAutoAssignPatchForOpenStage skips when stage already assigned', async () => {
    const req = { user: { id: 7, fullName: 'Bob' } };
    const row = {
      approval_stage_assignees: {
        drafter: null,
        reviewer: { user_id: 3, display_name: 'Other', role_name: null },
        approver: null,
      },
    };
    const patch = await buildAutoAssignPatchForOpenStage(req, row, 'Under Review');
    expect(patch).toBeNull();
  });
});

const {
  isPrivilegedRole,
  hasGranularAccess,
} = require('../../src/middleware/security');
const {
  canUpdateMasterApprovalStatus,
  canAssignMasterApproval,
  canApproveAssignedMaster,
  canApproveAtCurrentStage,
  APPROVAL_RESOURCE_BY_KIND,
} = require('../../src/lib/masterApprovalAuth');

jest.mock('../../src/middleware/security', () => ({
  isPrivilegedRole: jest.fn(),
  hasGranularAccess: jest.fn(),
}));

describe('masterApprovalAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('APPROVAL_RESOURCE_BY_KIND maps RM/PM/PR to inventory submodules', () => {
    expect(APPROVAL_RESOURCE_BY_KIND.RM).toBe('inventory.raw-materials');
    expect(APPROVAL_RESOURCE_BY_KIND.PM).toBe('inventory.packaging');
    expect(APPROVAL_RESOURCE_BY_KIND.PR).toBe('inventory.bom');
  });

  test('canUpdateMasterApprovalStatus allows privileged users', async () => {
    isPrivilegedRole.mockReturnValue(true);
    const req = { user: { role: 'admin' } };
    await expect(canUpdateMasterApprovalStatus(req, 'RM')).resolves.toBe(true);
    expect(hasGranularAccess).not.toHaveBeenCalled();
  });

  test('canUpdateMasterApprovalStatus checks granular approve permission', async () => {
    isPrivilegedRole.mockReturnValue(false);
    hasGranularAccess.mockResolvedValue(true);
    const req = { user: { roleId: 5 } };
    await expect(canUpdateMasterApprovalStatus(req, 'PR')).resolves.toBe(true);
    expect(hasGranularAccess).toHaveBeenCalledWith(req, 'inventory.bom', 'approve');
  });

  test('canUpdateMasterApprovalStatus denies without approve permission', async () => {
    isPrivilegedRole.mockReturnValue(false);
    hasGranularAccess.mockResolvedValue(false);
    const req = { user: { roleId: 5 } };
    await expect(canUpdateMasterApprovalStatus(req, 'PM')).resolves.toBe(false);
  });

  test('canApproveAssignedMaster allows admin regardless of assignee', async () => {
    isPrivilegedRole.mockReturnValue(true);
    const req = { user: { id: 99, role: 'admin' } };
    await expect(canApproveAssignedMaster(req, 'RM', null)).resolves.toBe(true);
    await expect(canApproveAssignedMaster(req, 'RM', 42)).resolves.toBe(true);
  });

  test('canApproveAssignedMaster requires assignee match for team members', async () => {
    isPrivilegedRole.mockReturnValue(false);
    hasGranularAccess.mockResolvedValue(true);
    const req = { user: { id: 7, roleId: 5 } };
    await expect(canApproveAssignedMaster(req, 'PR', 7)).resolves.toBe(true);
    await expect(canApproveAssignedMaster(req, 'PR', 8)).resolves.toBe(false);
    await expect(canApproveAssignedMaster(req, 'PR', null)).resolves.toBe(false);
  });

  test('canApproveAtCurrentStage denies open stage for team members', async () => {
    isPrivilegedRole.mockReturnValue(false);
    hasGranularAccess.mockResolvedValue(true);
    const req = { user: { id: 7, roleId: 5 } };
    const openAssignees = { drafter: null, reviewer: null, approver: null };
    await expect(canApproveAtCurrentStage(req, 'RM', 'Draft', openAssignees)).resolves.toBe(false);
  });

  test('canApproveAtCurrentStage requires drafter when assigned at Draft', async () => {
    isPrivilegedRole.mockReturnValue(false);
    hasGranularAccess.mockResolvedValue(true);
    const req = { user: { id: 7, roleId: 5 } };
    const assignees = {
      drafter: { userId: 7, displayName: 'Me', roleName: null },
      reviewer: null,
      approver: null,
    };
    await expect(canApproveAtCurrentStage(req, 'RM', 'Draft', assignees)).resolves.toBe(true);
    await expect(
      canApproveAtCurrentStage(req, 'RM', 'Draft', {
        ...assignees,
        drafter: { userId: 9, displayName: 'Other', roleName: null },
      })
    ).resolves.toBe(false);
  });

  test('canAssignMasterApproval mirrors team access', async () => {
    isPrivilegedRole.mockReturnValue(false);
    hasGranularAccess.mockResolvedValue(true);
    const req = { user: { roleId: 5 } };
    await expect(canAssignMasterApproval(req, 'PM')).resolves.toBe(true);
  });
});

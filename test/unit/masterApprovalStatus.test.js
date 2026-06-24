const {
  normalizeMasterApprovalStatus,
  resolveMasterApprovalStatus,
  readMasterApprovalStatusFromFormData,
  mergeFormDataWithApprovalStatus,
  getNextMasterApprovalStatus,
  getPreviousMasterApprovalStatus,
  resolveMasterApprovalPatch,
  isMasterPickerRequest,
  resolveApprovalStatusListFilter,
} = require('../../src/lib/masterApprovalStatus');

describe('masterApprovalStatus', () => {
  test('normalizeMasterApprovalStatus maps legacy active to Active', () => {
    expect(normalizeMasterApprovalStatus('active')).toBe('Active');
    expect(normalizeMasterApprovalStatus('ACTIVE')).toBe('Active');
  });

  test('resolveMasterApprovalStatus defaults to Draft on create', () => {
    expect(resolveMasterApprovalStatus(undefined, { forCreate: true })).toBe('Draft');
    expect(resolveMasterApprovalStatus('', { forCreate: true })).toBe('Draft');
  });

  test('resolveMasterApprovalStatus preserves existing when raw omitted', () => {
    expect(resolveMasterApprovalStatus(undefined, { existing: 'Under Review' })).toBe('Under Review');
  });

  test('readMasterApprovalStatusFromFormData reads masterApprovalStatus', () => {
    expect(readMasterApprovalStatusFromFormData({ masterApprovalStatus: 'Under Approval' })).toBe('Under Approval');
  });

  test('mergeFormDataWithApprovalStatus stamps Draft on create', () => {
    const fd = mergeFormDataWithApprovalStatus({ form_data: { name: 'Tube' } }, { forCreate: true });
    expect(fd.masterApprovalStatus).toBe('Draft');
  });

  test('getNextMasterApprovalStatus advances the chain', () => {
    expect(getNextMasterApprovalStatus('Draft')).toBe('Under Review');
    expect(getNextMasterApprovalStatus('Under Review')).toBe('Under Approval');
    expect(getNextMasterApprovalStatus('Under Approval')).toBe('Active');
    expect(getNextMasterApprovalStatus('Active')).toBeNull();
  });

  test('resolveMasterApprovalPatch supports advance', () => {
    expect(resolveMasterApprovalPatch({ advance: true }, 'Draft')).toEqual({ status: 'Under Review' });
    expect(resolveMasterApprovalPatch({ advance: true }, 'Under Approval')).toEqual({ status: 'Active' });
  });

  test('resolveMasterApprovalPatch supports explicit status', () => {
    expect(resolveMasterApprovalPatch({ status: 'Active' }, 'Under Approval')).toEqual({
      status: 'Active',
    });
  });

  test('getPreviousMasterApprovalStatus walks back the chain', () => {
    expect(getPreviousMasterApprovalStatus('Under Review')).toBe('Draft');
    expect(getPreviousMasterApprovalStatus('Under Approval')).toBe('Under Review');
    expect(getPreviousMasterApprovalStatus('Active')).toBe('Under Approval');
    expect(getPreviousMasterApprovalStatus('Draft')).toBeNull();
  });

  test('resolveMasterApprovalPatch supports revert', () => {
    expect(resolveMasterApprovalPatch({ revert: true }, 'Under Review')).toEqual({ status: 'Draft' });
    expect(resolveMasterApprovalPatch({ revert: true }, 'Draft')).toMatchObject({
      code: 'APPROVAL_NO_PREVIOUS',
    });
  });

  test('isMasterPickerRequest detects picker query flag', () => {
    expect(isMasterPickerRequest({ query: { for_picker: '1' } })).toBe(true);
    expect(isMasterPickerRequest({ query: { for_picker: 'true' } })).toBe(true);
    expect(isMasterPickerRequest({ query: {} })).toBe(false);
  });

  test('resolveApprovalStatusListFilter normalizes legacy active and skips all', () => {
    expect(resolveApprovalStatusListFilter('all')).toBeNull();
    expect(resolveApprovalStatusListFilter('')).toBeNull();
    expect(resolveApprovalStatusListFilter('active')).toBe('Active');
    expect(resolveApprovalStatusListFilter('Draft')).toBe('Draft');
  });
});

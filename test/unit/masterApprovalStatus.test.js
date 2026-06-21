const {
  normalizeMasterApprovalStatus,
  resolveMasterApprovalStatus,
  readMasterApprovalStatusFromFormData,
  mergeFormDataWithApprovalStatus,
  getNextMasterApprovalStatus,
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

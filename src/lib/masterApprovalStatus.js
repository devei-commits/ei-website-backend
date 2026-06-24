/**
 * Master registration approval workflow (RM / PM / PR).
 * Draft → Under Review → Under Approval → Active
 */

const MASTER_APPROVAL_STATUSES = ['Draft', 'Under Review', 'Under Approval', 'Active'];

const LEGACY_STATUS_MAP = {
  active: 'Active',
  inactive: 'Inactive',
  draft: 'Draft',
  'under review': 'Under Review',
  'under-review': 'Under Review',
  'under approval': 'Under Approval',
  'under-approval': 'Under Approval',
};

/** @param {unknown} raw */
function normalizeMasterApprovalStatus(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LEGACY_STATUS_MAP, lower)) {
    return LEGACY_STATUS_MAP[lower];
  }
  const found = MASTER_APPROVAL_STATUSES.find((x) => x.toLowerCase() === lower);
  if (found) return found;
  return s;
}

/**
 * Resolve approval status for create/update.
 * @param {unknown} raw
 * @param {{ existing?: unknown, forCreate?: boolean }} [opts]
 */
function resolveMasterApprovalStatus(raw, opts = {}) {
  const normalized = normalizeMasterApprovalStatus(raw);
  if (normalized) return normalized;
  const existingNorm = normalizeMasterApprovalStatus(opts.existing);
  if (existingNorm) return existingNorm;
  return opts.forCreate ? 'Draft' : 'Draft';
}

/** Next step in the approval chain, or null when already Active / unknown. */
function getNextMasterApprovalStatus(current) {
  const norm = normalizeMasterApprovalStatus(current) || 'Draft';
  const idx = MASTER_APPROVAL_STATUSES.indexOf(norm);
  if (idx < 0 || idx >= MASTER_APPROVAL_STATUSES.length - 1) return null;
  return MASTER_APPROVAL_STATUSES[idx + 1];
}

/** Previous step in the approval chain, or null when already Draft / unknown. */
function getPreviousMasterApprovalStatus(current) {
  const norm = normalizeMasterApprovalStatus(current) || 'Draft';
  const idx = MASTER_APPROVAL_STATUSES.indexOf(norm);
  if (idx <= 0) return null;
  return MASTER_APPROVAL_STATUSES[idx - 1];
}

/**
 * Resolve target status from PATCH body ({ status } or { advance: true }).
 * @param {Record<string, unknown>} body
 * @param {unknown} currentStatus
 */
function resolveMasterApprovalPatch(body, currentStatus) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.advance === true && b.revert === true) {
    return {
      error: 'Send only one of advance or revert',
      code: 'APPROVAL_PATCH_CONFLICT',
    };
  }
  if (b.advance === true) {
    const next = getNextMasterApprovalStatus(currentStatus);
    if (!next) {
      return { error: 'Item is already at the final approval stage', code: 'APPROVAL_NO_NEXT' };
    }
    return { status: next };
  }
  if (b.revert === true) {
    const prev = getPreviousMasterApprovalStatus(currentStatus);
    if (!prev) {
      return { error: 'Item is already at the first approval stage', code: 'APPROVAL_NO_PREVIOUS' };
    }
    return { status: prev };
  }
  const raw = b.status ?? b.masterApprovalStatus ?? b.master_approval_status;
  if (raw == null || String(raw).trim() === '') {
    return {
      error: 'status is required (or send { advance: true } or { revert: true })',
      code: 'APPROVAL_STATUS_REQUIRED',
    };
  }
  const status = normalizeMasterApprovalStatus(raw);
  if (!status || !MASTER_APPROVAL_STATUSES.includes(status)) {
    return {
      error: `Invalid approval status. Allowed: ${MASTER_APPROVAL_STATUSES.join(', ')}`,
      code: 'APPROVAL_STATUS_INVALID',
      allowed: MASTER_APPROVAL_STATUSES,
    };
  }
  return { status };
}

/** @param {unknown} formData */
function readMasterApprovalStatusFromFormData(formData, fallback = 'Draft') {
  if (formData == null || typeof formData !== 'object' || Array.isArray(formData)) {
    return fallback;
  }
  const fd = /** @type {Record<string, unknown>} */ (formData);
  const raw = fd.masterApprovalStatus ?? fd.status;
  return resolveMasterApprovalStatus(raw, { existing: fallback, forCreate: false });
}

/**
 * Merge masterApprovalStatus into PM (or nested) form_data payload.
 * @param {Record<string, unknown>} b request body
 * @param {{ forCreate?: boolean, existingFormData?: Record<string, unknown>|null }} [opts]
 */
function stripDeprecatedMasterFormKeys(fd) {
  if (fd == null || typeof fd !== 'object' || Array.isArray(fd)) return fd;
  const next = { ...fd };
  delete next.rmType;
  delete next.rm_type;
  delete next.itemCategory;
  return next;
}

function mergeFormDataWithApprovalStatus(b, opts = {}) {
  const { forCreate = false, existingFormData = null } = opts;
  const exFd =
    existingFormData != null && typeof existingFormData === 'object' && !Array.isArray(existingFormData)
      ? existingFormData
      : {};
  const bodyFd = b.form_data != null && typeof b.form_data === 'object' && !Array.isArray(b.form_data) ? b.form_data : {};
  const merged = { ...exFd, ...bodyFd };
  const hasExplicit =
    bodyFd.masterApprovalStatus !== undefined ||
    bodyFd.status !== undefined ||
    b.masterApprovalStatus !== undefined ||
    b.status !== undefined;
  if (forCreate || hasExplicit) {
    const raw = bodyFd.masterApprovalStatus ?? bodyFd.status ?? b.masterApprovalStatus ?? b.status;
    merged.masterApprovalStatus = resolveMasterApprovalStatus(raw, {
      existing: readMasterApprovalStatusFromFormData(exFd, null),
      forCreate,
    });
    merged.status = merged.masterApprovalStatus;
  }
  return stripDeprecatedMasterFormKeys(merged);
}

/**
 * SO / PR BOM pickers must list masters in every approval stage (Draft, Under Review, …).
 * @param {import('express').Request | { query?: Record<string, unknown> }} req
 */
function isMasterPickerRequest(req) {
  const raw = req?.query?.for_picker;
  if (raw == null) return false;
  const s = String(raw).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

/**
 * Optional approval-status filter for master list screens (not picker flows).
 * @param {unknown} statusParam — query `status`; use `all` to skip filtering.
 * @returns {string | null} canonical status value, or null when filter should be skipped
 */
function resolveApprovalStatusListFilter(statusParam) {
  const raw = statusParam != null ? String(statusParam).trim() : '';
  if (!raw || raw.toLowerCase() === 'all') return null;
  return normalizeMasterApprovalStatus(raw) || raw;
}

module.exports = {
  MASTER_APPROVAL_STATUSES,
  normalizeMasterApprovalStatus,
  resolveMasterApprovalStatus,
  getNextMasterApprovalStatus,
  getPreviousMasterApprovalStatus,
  resolveMasterApprovalPatch,
  readMasterApprovalStatusFromFormData,
  mergeFormDataWithApprovalStatus,
  stripDeprecatedMasterFormKeys,
  isMasterPickerRequest,
  resolveApprovalStatusListFilter,
};

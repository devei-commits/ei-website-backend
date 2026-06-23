/**
 * Master approval status (RM / PM / PR):
 * - Assign stage people: admin or inventory.*.column.*-assign-stages.edit.
 * - Change status: admin always; otherwise assigned user with approve permission.
 */
const {
  hasGranularAccess,
  isPrivilegedRole,
} = require('../middleware/security');
const { ASSIGN_STAGE_COLUMN_BY_KIND } = require('../roles/mastersModuleDefinition');
const {
  normalizeMasterApprovalStatus,
  resolveMasterApprovalStatus,
  readMasterApprovalStatusFromFormData,
} = require('./masterApprovalStatus');

/** @typedef {'RM' | 'PM' | 'PR'} MasterApprovalKind */

/** @type {Record<MasterApprovalKind, string>} */
const APPROVAL_RESOURCE_BY_KIND = {
  RM: 'inventory.raw-materials',
  PM: 'inventory.packaging',
  PR: 'inventory.bom',
};

function sendApprovalForbidden(res, message) {
  return res.status(403).json({
    error: message,
    message,
    code: 'MASTER_APPROVAL_FORBIDDEN',
  });
}

/**
 * Admin or role with inventory submodule approve permission.
 * @param {import('express').Request} req
 * @param {MasterApprovalKind} kind
 */
async function hasMasterApprovalTeamAccess(req, kind) {
  if (!req.user) return false;
  if (isPrivilegedRole(req.user)) return true;
  const resource = APPROVAL_RESOURCE_BY_KIND[kind];
  if (!resource) return false;
  return hasGranularAccess(req, resource, 'approve');
}

/** @deprecated alias */
async function canUpdateMasterApprovalStatus(req, kind) {
  return hasMasterApprovalTeamAccess(req, kind);
}

async function canAssignMasterApproval(req, kind) {
  if (!req.user) return false;
  if (isPrivilegedRole(req.user)) return true;
  const resource = APPROVAL_RESOURCE_BY_KIND[kind];
  const columnId = ASSIGN_STAGE_COLUMN_BY_KIND[kind];
  if (!resource || !columnId) return false;
  return hasGranularAccess(req, `${resource}.column.${columnId}`, 'edit');
}

async function canAccessMasterApprovalRoute(req, kind) {
  if (!req.user) return false;
  if (isPrivilegedRole(req.user)) return true;
  return (
    (await hasMasterApprovalTeamAccess(req, kind)) ||
    (await canAssignMasterApproval(req, kind))
  );
}

const { readMasterApprovalStageAssignees } = require('./masterApprovalAssignee');

/** Maps current workflow status → stage assignee slot. */
function stageKeyForCurrentStatus(status) {
  const s = normalizeMasterApprovalStatus(status) || 'Draft';
  if (s === 'Draft') return 'drafter';
  if (s === 'Under Review') return 'reviewer';
  if (s === 'Under Approval') return 'approver';
  return null;
}

/**
 * @param {import('express').Request} req
 * @param {MasterApprovalKind} kind
 * @param {unknown} currentStatus
 * @param {ReturnType<typeof readMasterApprovalStageAssignees>} stageAssignees
 */
async function canApproveAtCurrentStage(req, kind, currentStatus, stageAssignees) {
  if (!req.user) return false;
  if (isPrivilegedRole(req.user)) return true;
  const hasTeam = await hasMasterApprovalTeamAccess(req, kind);
  if (!hasTeam) return false;
  const stageKey = stageKeyForCurrentStatus(currentStatus);
  if (!stageKey) return false;
  const slot = stageAssignees[stageKey];
  if (!slot || !slot.userId) return false;
  const callerId = parseInt(String(req.user.id), 10);
  return Number.isFinite(callerId) && callerId === slot.userId;
}

/**
 * @param {import('express').Request} req
 * @param {MasterApprovalKind} kind
 * @param {number | null | undefined} assignedUserId
 * @deprecated use canApproveAtCurrentStage
 */
async function canApproveAssignedMaster(req, kind, assignedUserId) {
  if (!req.user) return false;
  if (isPrivilegedRole(req.user)) return true;
  const hasTeam = await hasMasterApprovalTeamAccess(req, kind);
  if (!hasTeam) return false;
  const assigned = assignedUserId != null ? parseInt(String(assignedUserId), 10) : null;
  if (!Number.isFinite(assigned) || assigned <= 0) return false;
  const callerId = parseInt(String(req.user.id), 10);
  return Number.isFinite(callerId) && callerId === assigned;
}

/**
 * Express middleware — approve permission or assign-stages column edit may call approval-status PATCH.
 * Assign vs status is enforced inside the patch handler.
 * @param {MasterApprovalKind} kind
 */
function requireMasterApprovalUpdate(kind) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Please log in to continue.',
        message: 'Please log in to continue.',
        code: 'UNAUTHORIZED',
      });
    }
    try {
      const ok = await canAccessMasterApprovalRoute(req, kind);
      if (!ok) {
        return sendApprovalForbidden(
          res,
          'You do not have permission to manage master approval on this record.'
        );
      }
      return next();
    } catch (err) {
      console.error('requireMasterApprovalUpdate error', err);
      return res.status(500).json({ error: 'Failed to verify approval permissions' });
    }
  };
}

/**
 * @param {import('express').Request} req
 * @param {MasterApprovalKind} kind
 * @param {unknown} raw
 * @param {{ existing?: unknown, forCreate?: boolean }} [opts]
 */
async function resolveWritableMasterApprovalStatus(req, kind, raw, opts = {}) {
  const { existing, forCreate = false } = opts;
  const allowed = await hasMasterApprovalTeamAccess(req, kind);
  if (allowed) {
    return resolveMasterApprovalStatus(raw, { existing, forCreate });
  }
  if (forCreate) return 'Draft';
  return normalizeMasterApprovalStatus(existing) || 'Draft';
}

async function preserveRmApprovalOnWrite(req, fields, existing) {
  const allowed = await hasMasterApprovalTeamAccess(req, 'RM');
  if (allowed) return;
  if (fields.status !== undefined) {
    delete fields.status;
  }
  if (fields.form_data != null && typeof fields.form_data === 'object' && !Array.isArray(fields.form_data)) {
    const fd = { ...(/** @type {Record<string, unknown>} */ (fields.form_data)) };
    delete fd.status;
    delete fd.masterApprovalStatus;
    fields.form_data = fd;
  }
  if (existing.status !== undefined) {
    fields.status = existing.status;
  }
}

async function preservePmApprovalOnWrite(req, fields, existingFormData) {
  const allowed = await hasMasterApprovalTeamAccess(req, 'PM');
  if (allowed) return;
  const exStatus = readMasterApprovalStatusFromFormData(existingFormData, 'Draft');
  if (fields.form_data != null && typeof fields.form_data === 'object' && !Array.isArray(fields.form_data)) {
    fields.form_data = {
      ...(/** @type {Record<string, unknown>} */ (fields.form_data)),
      masterApprovalStatus: exStatus,
      status: exStatus,
    };
  }
}

async function preservePrApprovalOnWrite(req, body, existing) {
  const allowed = await hasMasterApprovalTeamAccess(req, 'PR');
  if (allowed) return;
  const exStatus = normalizeMasterApprovalStatus(existing.status ?? existing.lifecycle_status) || 'Draft';
  if (body.status !== undefined) body.status = exStatus;
  if (body.lifecycle_status !== undefined) body.lifecycle_status = exStatus;
}

module.exports = {
  APPROVAL_RESOURCE_BY_KIND,
  hasMasterApprovalTeamAccess,
  canUpdateMasterApprovalStatus,
  canAssignMasterApproval,
  canAccessMasterApprovalRoute,
  canApproveAtCurrentStage,
  canApproveAssignedMaster,
  stageKeyForCurrentStatus,
  requireMasterApprovalUpdate,
  resolveWritableMasterApprovalStatus,
  preserveRmApprovalOnWrite,
  preservePmApprovalOnWrite,
  preservePrApprovalOnWrite,
  sendApprovalForbidden,
};

/**
 * PR master dual-team approval — RM team + Pack team must both sign before status advances.
 */
const { isPrivilegedRole } = require('../middleware/security');
const { normalizeMasterApprovalStatus } = require('./masterApprovalStatus');
const { readMasterApprovalStageAssignees } = require('./masterApprovalAssignee');
const { recordMasterApprovalStatusHistory, readActorFromReq } = require('./masterApprovalStatusHistory');

/** @typedef {'rm_team' | 'pack_team'} PrTeamKey */

const PR_TEAM_KEYS = /** @type {const} */ (['rm_team', 'pack_team']);

/**
 * @param {unknown} raw
 * @returns {import('./masterApprovalAssignee').ReturnType<typeof readMasterApprovalStageAssignees>['rm_team']}
 */
function readPendingSlot(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = /** @type {Record<string, unknown>} */ (raw);
  const id = parseInt(String(o.user_id ?? o.userId ?? ''), 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    userId: id,
    displayName: String(o.display_name ?? o.displayName ?? `User #${id}`).trim(),
    roleName:
      o.role_name != null && String(o.role_name).trim() !== ''
        ? String(o.role_name).trim()
        : o.roleName != null && String(o.roleName).trim() !== ''
          ? String(o.roleName).trim()
          : null,
  };
}

/**
 * @param {import('sequelize').Model | Record<string, unknown>} record
 */
function readPrTeamAssignees(record) {
  const stages = readMasterApprovalStageAssignees(record);
  return {
    rm_team: stages.rm_team ?? null,
    pack_team: stages.pack_team ?? null,
  };
}

/**
 * @param {unknown} raw
 */
function readApprovalTeamPending(raw) {
  if (raw == null) return null;
  let json = raw;
  if (typeof json === 'string') {
    try {
      json = JSON.parse(json);
    } catch {
      return null;
    }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const o = /** @type {Record<string, unknown>} */ (json);
  const fromStatus = normalizeMasterApprovalStatus(o.from_status ?? o.fromStatus);
  const targetStatus = normalizeMasterApprovalStatus(o.target_status ?? o.targetStatus);
  if (!fromStatus || !targetStatus) return null;
  return {
    fromStatus,
    targetStatus,
    rmSignedAt: o.rm_signed_at ?? o.rmSignedAt ?? null,
    rmSignedBy: readPendingSlot(o.rm_signed_by ?? o.rmSignedBy),
    rmNote: o.rm_note ?? o.rmNote ?? null,
    packSignedAt: o.pack_signed_at ?? o.packSignedAt ?? null,
    packSignedBy: readPendingSlot(o.pack_signed_by ?? o.packSignedBy),
    packNote: o.pack_note ?? o.packNote ?? null,
  };
}

/**
 * @param {import('sequelize').Model} row
 */
function readPendingFromRow(row) {
  const d = row.get({ plain: true });
  return readApprovalTeamPending(d.approval_team_pending);
}

function formatPendingForApi(pending) {
  if (!pending) return null;
  const slot = (s) =>
    s
      ? {
          user_id: s.userId,
          display_name: s.displayName,
          role_name: s.roleName ?? null,
        }
      : null;
  return {
    from_status: pending.fromStatus,
    target_status: pending.targetStatus,
    rm_signed_at: pending.rmSignedAt,
    rm_signed_by: slot(pending.rmSignedBy),
    rm_note: pending.rmNote,
    pack_signed_at: pending.packSignedAt,
    pack_signed_by: slot(pending.packSignedBy),
    pack_note: pending.packNote,
  };
}

/**
 * @param {number} callerId
 * @param {ReturnType<typeof readPrTeamAssignees>} teams
 */
function resolveCallerTeamKey(callerId, teams) {
  if (!Number.isFinite(callerId) || callerId <= 0) return null;
  if (teams.rm_team?.userId === callerId) return 'rm_team';
  if (teams.pack_team?.userId === callerId) return 'pack_team';
  return null;
}

/**
 * @param {PrTeamKey} teamKey
 * @param {ReturnType<typeof readPrTeamAssignees>} teams
 */
function isTeamSlotOpen(teamKey, teams) {
  const slot = teams[teamKey];
  return !slot || !slot.userId;
}

/**
 * @param {import('express').Request} req
 * @param {ReturnType<typeof readPrTeamAssignees>} teams
 * @param {ReturnType<typeof readApprovalTeamPending>} pending
 */
function canPrTeamMemberAct(req, teams, pending) {
  if (!req.user) return false;
  if (isPrivilegedRole(req.user)) return true;
  const callerId = parseInt(String(req.user.id), 10);
  if (!Number.isFinite(callerId)) return false;
  const teamKey = resolveCallerTeamKey(callerId, teams);
  if (teamKey) {
    if (!pending) return true;
    if (teamKey === 'rm_team' && pending.rmSignedAt) return false;
    if (teamKey === 'pack_team' && pending.packSignedAt) return false;
    return true;
  }
  return isTeamSlotOpen('rm_team', teams) || isTeamSlotOpen('pack_team', teams);
}

/**
 * @param {import('express').Request} req
 * @param {unknown} currentStatus
 * @param {import('sequelize').Model} row
 */
function canPrApproveAtCurrentStage(req, currentStatus, row) {
  const teams = readPrTeamAssignees(row);
  const pending = readPendingFromRow(row);
  return canPrTeamMemberAct(req, teams, pending);
}

/**
 * @param {PrTeamKey} teamKey
 */
function signoffSource(teamKey) {
  return teamKey === 'rm_team' ? 'pr_rm_team_signoff' : 'pr_pack_team_signoff';
}

function teamLabel(teamKey) {
  return teamKey === 'rm_team' ? 'RM team' : 'Pack team';
}

/**
 * Apply PR status change with dual RM + Pack team sign-off.
 * @param {{
 *   req: import('express').Request,
 *   row: import('sequelize').Model,
 *   targetStatus: string,
 *   readCurrentStatus: (row: import('sequelize').Model) => string,
 *   applyStatus: (row: import('sequelize').Model, status: string) => Promise<void>,
 *   readMasterId: (row: import('sequelize').Model) => number,
 *   readMasterCode: (row: import('sequelize').Model) => string | null,
 *   note?: string | null,
 *   isRevert?: boolean,
 * }} opts
 */
async function applyPrTeamStatusUpdate(opts) {
  const { req, row, targetStatus, readCurrentStatus, applyStatus, readMasterId, readMasterCode } = opts;
  const note = opts.note ?? null;
  const fromStatus = normalizeMasterApprovalStatus(readCurrentStatus(row));
  const toStatus = normalizeMasterApprovalStatus(targetStatus);
  if (fromStatus === toStatus) {
    return { status: fromStatus, advanced: false, signoffRecorded: null, pending: readPendingFromRow(row) };
  }

  const actor = readActorFromReq(req);
  const masterId = readMasterId(row);
  const masterCode = readMasterCode(row);

  if (isPrivilegedRole(req.user)) {
    await applyStatus(row, toStatus);
    await row.update({ approval_team_pending: null, updated_at: new Date() });
    await recordMasterApprovalStatusHistory({
      kind: 'PR',
      masterId,
      masterCode,
      fromStatus,
      toStatus,
      actor,
      source: opts.isRevert ? 'revert' : 'advance',
      note,
    });
    return { status: toStatus, advanced: true, signoffRecorded: null, pending: null };
  }

  const teams = readPrTeamAssignees(row);
  const callerId = actor.userId;
  let teamKey = resolveCallerTeamKey(callerId, teams);
  if (!teamKey) {
    if (isTeamSlotOpen('rm_team', teams)) teamKey = 'rm_team';
    else if (isTeamSlotOpen('pack_team', teams)) teamKey = 'pack_team';
    else {
      return {
        error: 'Only the assigned RM team or Pack team member may advance PR approval status.',
        code: 'PR_TEAM_FORBIDDEN',
      };
    }
  }

  let pending = readPendingFromRow(row);
  if (
    pending &&
    (pending.fromStatus !== fromStatus || pending.targetStatus !== toStatus)
  ) {
    pending = null;
  }

  const nowIso = new Date().toISOString();
  const signedBy = {
    userId: callerId,
    displayName: actor.displayName || `User #${callerId}`,
    roleName: teams[teamKey]?.roleName ?? null,
  };

  if (teamKey === 'rm_team' && pending?.rmSignedAt) {
    return { error: 'RM team has already signed this pending advance.', code: 'PR_TEAM_ALREADY_SIGNED' };
  }
  if (teamKey === 'pack_team' && pending?.packSignedAt) {
    return { error: 'Pack team has already signed this pending advance.', code: 'PR_TEAM_ALREADY_SIGNED' };
  }

  const nextPending = pending
    ? { ...pending }
    : {
        fromStatus,
        targetStatus: toStatus,
        rmSignedAt: null,
        rmSignedBy: null,
        rmNote: null,
        packSignedAt: null,
        packSignedBy: null,
        packNote: null,
      };

  if (teamKey === 'rm_team') {
    nextPending.rmSignedAt = nowIso;
    nextPending.rmSignedBy = signedBy;
    nextPending.rmNote = note;
  } else {
    nextPending.packSignedAt = nowIso;
    nextPending.packSignedBy = signedBy;
    nextPending.packNote = note;
  }

  await recordMasterApprovalStatusHistory({
    kind: 'PR',
    masterId,
    masterCode,
    fromStatus,
    toStatus: fromStatus,
    actor,
    source: signoffSource(teamKey),
    allowSameStatus: true,
    note:
      note ||
      `${teamLabel(teamKey)} sign-off recorded — pending advance to ${toStatus}.`,
  });

  const rmReady = !!nextPending.rmSignedAt;
  const packReady = !!nextPending.packSignedAt;

  if (rmReady && packReady) {
    await applyStatus(row, toStatus);
    await row.update({ approval_team_pending: null, updated_at: new Date() });
    await recordMasterApprovalStatusHistory({
      kind: 'PR',
      masterId,
      masterCode,
      fromStatus,
      toStatus,
      actor,
      source: opts.isRevert ? 'revert' : 'advance',
      note: note || 'Both RM and Pack teams signed — status advanced.',
    });
    return { status: toStatus, advanced: true, signoffRecorded: teamKey, pending: null };
  }

  await row.update({
    approval_team_pending: formatPendingForApi(nextPending),
    updated_at: new Date(),
  });

  return {
    status: fromStatus,
    advanced: false,
    signoffRecorded: teamKey,
    pending: nextPending,
  };
}

module.exports = {
  PR_TEAM_KEYS,
  readPrTeamAssignees,
  readApprovalTeamPending,
  readPendingFromRow,
  formatPendingForApi,
  resolveCallerTeamKey,
  canPrTeamMemberAct,
  canPrApproveAtCurrentStage,
  applyPrTeamStatusUpdate,
  teamLabel,
};

/**
 * Master approval stage assignees — Drafter / Reviewer / Approver (RM / PM / PR).
 */
const { User } = require('../users/models');
const Role = require('../models/Role');
const { activeRowWhere } = require('./softDelete');

/** @typedef {'drafter' | 'reviewer' | 'approver'} MasterApprovalStageKey */

const STAGE_KEYS = /** @type {const} */ (['drafter', 'reviewer', 'approver']);

const USERTYPE_TO_ROLE_NAME = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  bd_manager: 'BD Manager',
  doctor: 'Doctor',
  customer: 'Customer',
};

async function getRolesByCodeMap() {
  const roles = await Role.findAll({ attributes: ['role_id', 'role_code', 'role_name'] });
  /** @type {Record<string, { role_id: number, role_name: string }>} */
  const map = {};
  roles.forEach((r) => {
    map[r.role_code] = { role_id: r.role_id, role_name: r.role_name };
  });
  return map;
}

/**
 * @param {unknown} raw
 * @returns {{ userId: number, displayName: string, roleName: string | null } | null}
 */
function normalizeStageSlot(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = /** @type {Record<string, unknown>} */ (raw);
  const idRaw = o.user_id ?? o.userId;
  if (idRaw == null || idRaw === '') return null;
  const userId = parseInt(String(idRaw), 10);
  if (!Number.isFinite(userId) || userId <= 0) return null;
  const displayName =
    o.display_name != null && String(o.display_name).trim() !== ''
      ? String(o.display_name).trim()
      : o.displayName != null && String(o.displayName).trim() !== ''
        ? String(o.displayName).trim()
        : null;
  const roleName =
    o.role_name != null && String(o.role_name).trim() !== ''
      ? String(o.role_name).trim()
      : o.roleName != null && String(o.roleName).trim() !== ''
        ? String(o.roleName).trim()
        : null;
  return { userId, displayName: displayName || `User #${userId}`, roleName };
}

/**
 * @returns {Record<MasterApprovalStageKey, { userId: number, displayName: string, roleName: string | null } | null>}
 */
function emptyStageAssignees() {
  return { drafter: null, reviewer: null, approver: null };
}

/**
 * @param {unknown} record
 */
function readMasterApprovalStageAssignees(record) {
  const d = record && typeof record.get === 'function' ? record.get({ plain: true }) : record || {};
  const result = emptyStageAssignees();
  let json = d.approval_stage_assignees;
  if (typeof json === 'string') {
    try {
      json = JSON.parse(json);
    } catch {
      json = null;
    }
  }
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    for (const key of STAGE_KEYS) {
      result[key] = normalizeStageSlot(/** @type {Record<string, unknown>} */ (json)[key]);
    }
  }
  if (!result.approver && d.approval_assigned_user_id != null && d.approval_assigned_user_id !== '') {
    const legacyId = parseInt(String(d.approval_assigned_user_id), 10);
    if (Number.isFinite(legacyId) && legacyId > 0) {
      result.approver = {
        userId: legacyId,
        displayName:
          d.approval_assigned_display_name != null && String(d.approval_assigned_display_name).trim() !== ''
            ? String(d.approval_assigned_display_name).trim()
            : `User #${legacyId}`,
        roleName: null,
      };
    }
  }
  return result;
}

/** @deprecated */
function readMasterApprovalAssignee(record) {
  const stages = readMasterApprovalStageAssignees(record);
  const approver = stages.approver;
  return { userId: approver?.userId ?? null, displayName: approver?.displayName ?? null };
}

/**
 * @param {Record<MasterApprovalStageKey, { userId: number, displayName: string, roleName: string | null } | null>} stages
 */
function formatStageAssigneesForApi(stages) {
  /** @type {Record<string, { user_id: number, display_name: string, role_name: string | null } | null>} */
  const out = {};
  for (const key of STAGE_KEYS) {
    const slot = stages[key];
    out[key] =
      slot && slot.userId
        ? {
            user_id: slot.userId,
            display_name: slot.displayName,
            role_name: slot.roleName ?? null,
          }
        : null;
  }
  return out;
}

function formatMasterApprovalAssigneeFields(record) {
  const stages = readMasterApprovalStageAssignees(record);
  return {
    approval_stage_assignees: formatStageAssigneesForApi(stages),
    approval_assigned_user_id: stages.approver?.userId ?? null,
    approval_assigned_display_name: stages.approver?.displayName ?? null,
  };
}

/**
 * @param {import('sequelize').Model | Record<string, unknown>} userRow
 * @param {Record<string, { role_name?: string }>} [rolesByCode]
 */
function displayNameForUser(userRow, rolesByCode = {}) {
  const plain = userRow && typeof userRow.get === 'function' ? userRow.get({ plain: true }) : userRow || {};
  const name =
    String(plain.display_name || '').trim() ||
    [plain.fname, plain.lname].filter(Boolean).join(' ').trim() ||
    String(plain.email || '').trim() ||
    `User #${plain.userid}`;
  const usertype = plain.usertype || 'customer';
  const roleInfo = rolesByCode[usertype];
  const roleName = roleInfo ? roleInfo.role_name : USERTYPE_TO_ROLE_NAME[usertype] ?? usertype;
  return { displayName: name, roleName: roleName ?? null };
}

/**
 * @param {unknown} raw
 * @param {MasterApprovalStageKey} stageKey
 * @param {Record<string, unknown>} [fromBodySlot]
 */
async function resolveStageSlotUpdate(raw, stageKey, fromBodySlot) {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `Invalid ${stageKey} assignment`, code: 'ASSIGNEE_INVALID' };
  }
  const o = /** @type {Record<string, unknown>} */ (raw);
  if (o.open === true || o.user_id === null || o.userId === null) {
    return null;
  }
  const userId = parseInt(String(o.user_id ?? o.userId ?? ''), 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return { error: `Invalid user for ${stageKey}`, code: 'ASSIGNEE_INVALID' };
  }
  const user = await User.findOne({
    where: activeRowWhere({ userid: userId }),
    attributes: ['userid', 'display_name', 'fname', 'lname', 'email', 'usertype'],
  });
  if (!user) {
    return { error: `User not found for ${stageKey}`, code: 'ASSIGNEE_NOT_FOUND' };
  }
  const rolesByCode = await getRolesByCodeMap();
  const { displayName, roleName } = displayNameForUser(user, rolesByCode);
  const fromBodyName =
    fromBodySlot?.display_name != null ? String(fromBodySlot.display_name).trim() : '';
  const fromBodyRole =
    fromBodySlot?.role_name != null ? String(fromBodySlot.role_name).trim() : '';
  return {
    userId,
    displayName: fromBodyName || displayName,
    roleName: fromBodyRole || roleName,
  };
}

/**
 * @param {Record<string, unknown>} body
 */
async function resolveAssigneeUpdateFromBody(body) {
  if (Object.prototype.hasOwnProperty.call(body, 'approval_stage_assignees')) {
    const raw = body.approval_stage_assignees;
    if (raw == null) {
      return {
        approval_stage_assignees: formatStageAssigneesForApi(emptyStageAssignees()),
        approval_assigned_user_id: null,
        approval_assigned_display_name: null,
      };
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: 'Invalid approval_stage_assignees', code: 'ASSIGNEE_INVALID' };
    }
    const input = /** @type {Record<string, unknown>} */ (raw);
    const stages = emptyStageAssignees();
    for (const key of STAGE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
      const resolved = await resolveStageSlotUpdate(input[key], key, /** @type {Record<string, unknown>} */ (input[key]));
      if (resolved && resolved.error) return resolved;
      stages[key] = resolved;
    }
    const apiStages = formatStageAssigneesForApi(stages);
    return {
      approval_stage_assignees: apiStages,
      approval_assigned_user_id: stages.approver?.userId ?? null,
      approval_assigned_display_name: stages.approver?.displayName ?? null,
    };
  }

  if (!Object.prototype.hasOwnProperty.call(body, 'approval_assigned_user_id')) {
    return null;
  }
  const raw = body.approval_assigned_user_id;
  if (raw == null || raw === '') {
    const cleared = emptyStageAssignees();
    return {
      approval_stage_assignees: formatStageAssigneesForApi(cleared),
      approval_assigned_user_id: null,
      approval_assigned_display_name: null,
    };
  }
  const userId = parseInt(String(raw), 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return { error: 'Invalid approval_assigned_user_id', code: 'ASSIGNEE_INVALID' };
  }
  const user = await User.findOne({
    where: activeRowWhere({ userid: userId }),
    attributes: ['userid', 'display_name', 'fname', 'lname', 'email', 'usertype'],
  });
  if (!user) {
    return { error: 'Assigned approver user not found', code: 'ASSIGNEE_NOT_FOUND' };
  }
  const rolesByCode = await getRolesByCodeMap();
  const { displayName, roleName } = displayNameForUser(user, rolesByCode);
  const stages = emptyStageAssignees();
  stages.approver = { userId, displayName, roleName };
  return {
    approval_stage_assignees: formatStageAssigneesForApi(stages),
    approval_assigned_user_id: userId,
    approval_assigned_display_name: displayName,
  };
}

function bodyRequestsAssigneeUpdate(body) {
  if (!body || typeof body !== 'object') return false;
  return (
    Object.prototype.hasOwnProperty.call(body, 'approval_stage_assignees') ||
    Object.prototype.hasOwnProperty.call(body, 'approval_assigned_user_id')
  );
}

function bodyRequestsStatusUpdate(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.advance === true) return true;
  return body.status !== undefined && body.status !== null && String(body.status).trim() !== '';
}

module.exports = {
  STAGE_KEYS,
  readMasterApprovalStageAssignees,
  readMasterApprovalAssignee,
  formatStageAssigneesForApi,
  formatMasterApprovalAssigneeFields,
  resolveAssigneeUpdateFromBody,
  bodyRequestsAssigneeUpdate,
  bodyRequestsStatusUpdate,
};

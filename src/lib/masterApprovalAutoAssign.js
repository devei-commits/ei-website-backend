/**
 * Auto-assign approval stage slots when a user creates or edits a master (RM / PM / PR).
 * - New record → assign creator as Drafter when that slot is open.
 * - Open stage + user saves or advances → assign that user to the current stage slot.
 */
const { stageKeyForCurrentStatus } = require('./masterApprovalAuth');
const {
  MASTER_APPROVAL_STATUSES,
  normalizeMasterApprovalStatus,
  readMasterApprovalStatusFromFormData,
} = require('./masterApprovalStatus');
const { readActorFromReq } = require('./masterApprovalStatusHistory');
const {
  readMasterApprovalStageAssignees,
  formatStageAssigneesForApi,
  emptyStageAssignees,
  buildStageSlotForUserId,
} = require('./masterApprovalAssignee');

/** @typedef {'RM' | 'PM' | 'PR'} MasterApprovalKind */

/**
 * @param {MasterApprovalKind} kind
 * @param {import('sequelize').Model | Record<string, unknown>} row
 */
function readApprovalStatusFromMasterRow(kind, row) {
  const d = row && typeof row.get === 'function' ? row.get({ plain: true }) : row || {};
  if (kind === 'PR') {
    return normalizeMasterApprovalStatus(d.status ?? d.lifecycle_status) || 'Draft';
  }
  if (kind === 'RM') {
    const colStatus = normalizeMasterApprovalStatus(d.status);
    if (colStatus && MASTER_APPROVAL_STATUSES.includes(colStatus)) {
      return colStatus;
    }
    return readMasterApprovalStatusFromFormData(d.form_data, 'Draft');
  }
  return readMasterApprovalStatusFromFormData(d.form_data, 'Draft');
}

/**
 * @param {import('express').Request} req
 */
async function actorStageSlotFromReq(req) {
  const actor = readActorFromReq(req);
  if (!actor.userId) return null;
  return buildStageSlotForUserId(actor.userId, { displayName: actor.displayName });
}

/**
 * @param {Record<string, unknown>} fields
 * @param {ReturnType<typeof readMasterApprovalStageAssignees>} stages
 */
function writeAssigneeFields(fields, stages) {
  fields.approval_stage_assignees = formatStageAssigneesForApi(stages);
  fields.approval_assigned_user_id = stages.approver?.userId ?? null;
  fields.approval_assigned_display_name = stages.approver?.displayName ?? null;
}

/**
 * Assign the creator to the Drafter slot on new master rows (Draft).
 * @param {import('express').Request} req
 * @param {Record<string, unknown>} fields
 */
async function applyAutoAssignDrafterOnCreate(req, fields) {
  if (!req?.user) return fields;

  const fromFields = readMasterApprovalStageAssignees({ approval_stage_assignees: fields.approval_stage_assignees });
  const stages = { ...emptyStageAssignees(), ...fromFields };
  if (stages.drafter?.userId) return fields;

  const slot = await actorStageSlotFromReq(req);
  if (!slot) return fields;

  stages.drafter = slot;
  writeAssigneeFields(fields, stages);
  return fields;
}

/**
 * PR create: assign creator as drafter and RM team lead when those slots are open.
 * @param {import('express').Request} req
 * @param {Record<string, unknown>} fields
 */
async function applyAutoAssignPrCreatorOnCreate(req, fields) {
  await applyAutoAssignDrafterOnCreate(req, fields);
  if (!req?.user) return fields;

  const fromFields = readMasterApprovalStageAssignees({ approval_stage_assignees: fields.approval_stage_assignees });
  const stages = { ...emptyStageAssignees(), ...fromFields };
  if (stages.rm_team?.userId) return fields;

  const slot = await actorStageSlotFromReq(req);
  if (!slot) return fields;

  stages.rm_team = slot;
  writeAssigneeFields(fields, stages);
  return fields;
}

/**
 * When the current approval stage is open, assign the acting user to that stage.
 * @param {import('express').Request} req
 * @param {import('sequelize').Model | Record<string, unknown>} row
 * @param {unknown} currentStatus
 */
async function buildAutoAssignPatchForOpenStage(req, row, currentStatus) {
  if (!req?.user) return null;
  const stageKey = stageKeyForCurrentStatus(currentStatus);
  if (!stageKey) return null;

  const stages = readMasterApprovalStageAssignees(row);
  if (stages[stageKey]?.userId) return null;

  const slot = await actorStageSlotFromReq(req);
  if (!slot) return null;

  stages[stageKey] = slot;
  return {
    approval_stage_assignees: formatStageAssigneesForApi(stages),
    approval_assigned_user_id: stages.approver?.userId ?? null,
    approval_assigned_display_name: stages.approver?.displayName ?? null,
  };
}

/**
 * Merge open-stage auto-assign into a write payload (create/update).
 * @param {import('express').Request} req
 * @param {import('sequelize').Model | Record<string, unknown>} row
 * @param {unknown} currentStatus
 * @param {Record<string, unknown>} fields
 */
async function applyAutoAssignOnTouch(req, row, currentStatus, fields) {
  const patch = await buildAutoAssignPatchForOpenStage(req, row, currentStatus);
  if (!patch) return fields;
  return { ...fields, ...patch };
}

/**
 * Persist open-stage auto-assign directly on an existing row.
 * @param {import('express').Request} req
 * @param {import('sequelize').Model} row
 * @param {unknown} currentStatus
 */
async function touchAutoAssignOpenStage(req, row, currentStatus) {
  const patch = await buildAutoAssignPatchForOpenStage(req, row, currentStatus);
  if (!patch) return false;
  await row.update({ ...patch, updated_at: new Date() });
  return true;
}

module.exports = {
  readApprovalStatusFromMasterRow,
  applyAutoAssignDrafterOnCreate,
  applyAutoAssignPrCreatorOnCreate,
  applyAutoAssignOnTouch,
  touchAutoAssignOpenStage,
  buildAutoAssignPatchForOpenStage,
};

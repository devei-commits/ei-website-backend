/**
 * Shared PATCH …/approval-status handler for RM / PM / PR masters.
 */
const {
  resolveMasterApprovalPatch,
  readMasterApprovalStatusFromFormData,
  normalizeMasterApprovalStatus,
  MASTER_APPROVAL_STATUSES,
} = require('./masterApprovalStatus');
const {
  readMasterApprovalStageAssignees,
  resolveAssigneeUpdateFromBody,
  bodyRequestsAssigneeUpdate,
  bodyRequestsStatusUpdate,
} = require('./masterApprovalAssignee');
const {
  canAssignMasterApproval,
  canApproveAtCurrentStage,
  sendApprovalForbidden,
} = require('./masterApprovalAuth');
const {
  readPendingFromRow,
  formatPendingForApi,
  canPrApproveAtCurrentStage,
  applyPrTeamStatusUpdate,
  assertPrTeamAssignPatchAllowed,
} = require('./prMasterTeamApproval');
const {
  readActorFromReq,
  recordMasterApprovalStatusHistory,
} = require('./masterApprovalStatusHistory');
const { touchAutoAssignOpenStage } = require('./masterApprovalAutoAssign');

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {'RM' | 'PM' | 'PR'} kind
 * @param {import('sequelize').Model} row
 * @param {{
 *   readCurrentStatus: (row: import('sequelize').Model) => string,
 *   readMasterId?: (row: import('sequelize').Model) => number,
 *   readMasterCode?: (row: import('sequelize').Model) => string | null,
 *   applyStatus: (row: import('sequelize').Model, status: string) => Promise<void>,
 *   formatResponse: (row: import('sequelize').Model) => Record<string, unknown>,
 * }} hooks
 */
function readNoteFromBody(body) {
  const raw = body && typeof body === 'object' ? body.note ?? body.comment : null;
  if (raw == null) return null;
  const s = String(raw).trim();
  return s || null;
}

function readRmApprovalStatusFromRow(row) {
  const d = row.get({ plain: true });
  const colStatus = normalizeMasterApprovalStatus(d.status);
  if (colStatus && MASTER_APPROVAL_STATUSES.includes(colStatus)) {
    return colStatus;
  }
  return readMasterApprovalStatusFromFormData(d.form_data, 'Draft');
}

async function handleMasterApprovalPatch(req, res, kind, row, hooks) {
  const body = req.body || {};
  if (!bodyRequestsAssigneeUpdate(body) && !bodyRequestsStatusUpdate(body)) {
    res.status(400).json({
      error: 'Provide status, advance, revert, and/or approval_stage_assignees',
      code: 'APPROVAL_PATCH_EMPTY',
    });
    return false;
  }

  if (bodyRequestsAssigneeUpdate(body)) {
    if (!(await canAssignMasterApproval(req, kind))) {
      sendApprovalForbidden(
        res,
        'You need Assign approval stages (Edit) permission to change stage assignees.'
      );
      return false;
    }
    const assignPatch = await resolveAssigneeUpdateFromBody(body);
    if (assignPatch && assignPatch.error) {
      res.status(400).json({
        error: assignPatch.error,
        code: assignPatch.code,
      });
      return false;
    }
    if (assignPatch) {
      if (kind === 'PR') {
        const forbidden = assertPrTeamAssignPatchAllowed(req, row, assignPatch);
        if (forbidden) {
          res.status(403).json({
            error: forbidden.error,
            message: forbidden.error,
            code: forbidden.code,
          });
          return false;
        }
      }
      const assignUpdate =
        kind === 'PR'
          ? { ...assignPatch, approval_team_pending: null, updated_at: new Date() }
          : { ...assignPatch, updated_at: new Date() };
      await row.update(assignUpdate);
    }
  }

  if (bodyRequestsStatusUpdate(body)) {
    await row.reload();
    let current = hooks.readCurrentStatus(row);
    await touchAutoAssignOpenStage(req, row, current);
    await row.reload();
    current = hooks.readCurrentStatus(row);
    const stageAssignees = readMasterApprovalStageAssignees(row);
    const canApprove =
      kind === 'PR'
        ? await canPrApproveAtCurrentStage(req, current, row)
        : await canApproveAtCurrentStage(req, kind, current, stageAssignees);
    if (!canApprove) {
      sendApprovalForbidden(
        res,
        kind === 'PR'
          ? 'Only the assigned RM team or Pack team member (or an admin) may advance PR approval status.'
          : 'Only the person assigned to this approval stage (or an admin) may advance the status.'
      );
      return false;
    }
    const resolved = resolveMasterApprovalPatch(body, current);
    if (resolved.error) {
      res.status(400).json({
        error: resolved.error,
        code: resolved.code,
        ...(resolved.allowed ? { allowed: resolved.allowed } : {}),
      });
      return false;
    }
    const fromStatus = normalizeMasterApprovalStatus(current);
    const toStatus = normalizeMasterApprovalStatus(resolved.status);

    if (kind === 'PR') {
      const prResult = await applyPrTeamStatusUpdate({
        req,
        row,
        targetStatus: resolved.status,
        readCurrentStatus: hooks.readCurrentStatus,
        applyStatus: hooks.applyStatus,
        readMasterId: hooks.readMasterId
          ? (r) => hooks.readMasterId(r)
          : (r) => parseInt(String(r.get('id') ?? r.get('product_id') ?? ''), 10),
        readMasterCode: hooks.readMasterCode ? (r) => hooks.readMasterCode(r) : () => null,
        note: readNoteFromBody(body),
        isRevert: body.revert === true,
      });
      if (prResult.error) {
        res.status(400).json({ error: prResult.error, code: prResult.code });
        return false;
      }
    } else {
      await hooks.applyStatus(row, resolved.status);
      if (fromStatus !== toStatus) {
        const masterId = hooks.readMasterId
          ? hooks.readMasterId(row)
          : parseInt(String(row.get('id') ?? row.get('product_id') ?? ''), 10);
        const source =
          body.advance === true ? 'advance' : body.revert === true ? 'revert' : 'status_set';
        await recordMasterApprovalStatusHistory({
          kind,
          masterId,
          masterCode: hooks.readMasterCode ? hooks.readMasterCode(row) : null,
          fromStatus,
          toStatus,
          actor: readActorFromReq(req),
          source,
          note: readNoteFromBody(body),
        });
      }
    }
  }

  await row.reload();
  res.json(await hooks.formatResponse(row));
  return true;
}

function rmApprovalHooks(formatRawMaterial) {
  return {
    readCurrentStatus(row) {
      return readRmApprovalStatusFromRow(row);
    },
    readMasterId(row) {
      return row.get('id');
    },
    readMasterCode(row) {
      const d = row.get({ plain: true });
      return d.code ?? null;
    },
    async applyStatus(row, status) {
      const d = row.get({ plain: true });
      const exFd =
        d.form_data != null && typeof d.form_data === 'object' && !Array.isArray(d.form_data)
          ? d.form_data
          : {};
      const nextFd = { ...exFd, masterApprovalStatus: status, status };
      await row.update({ status, form_data: nextFd, updated_at: new Date() });
    },
    formatResponse(row) {
      return formatRawMaterial(row);
    },
  };
}

function pmApprovalHooks(formatPackMaterialFull) {
  return {
    readCurrentStatus(row) {
      const d = row.get({ plain: true });
      return readMasterApprovalStatusFromFormData(d.form_data, 'Draft');
    },
    readMasterId(row) {
      return row.get('id');
    },
    readMasterCode(row) {
      const d = row.get({ plain: true });
      return d.code ?? null;
    },
    async applyStatus(row, status) {
      const d = row.get({ plain: true });
      const exFd =
        d.form_data != null && typeof d.form_data === 'object' && !Array.isArray(d.form_data)
          ? d.form_data
          : {};
      const nextFd = { ...exFd, masterApprovalStatus: status, status };
      await row.update({ form_data: nextFd, updated_at: new Date() });
    },
    formatResponse(row) {
      return formatPackMaterialFull(row);
    },
  };
}

function prApprovalHooks() {
  const { formatMasterApprovalAssigneeFields } = require('./masterApprovalAssignee');
  return {
    readCurrentStatus(row) {
      const d = row.get({ plain: true });
      return normalizeMasterApprovalStatus(d.status ?? d.lifecycle_status) || 'Draft';
    },
    readMasterId(row) {
      return row.get('product_id');
    },
    readMasterCode(row) {
      const d = row.get({ plain: true });
      return d.product_code ?? null;
    },
    async applyStatus(row, status) {
      await row.update({
        status,
        lifecycle_status: status,
        updated_at: new Date(),
      });
    },
    formatResponse(row) {
      const d = row.get({ plain: true });
      const pending = readPendingFromRow(row);
      return {
        product_id: d.product_id,
        product_code: d.product_code,
        product_name: d.product_name,
        status: d.status,
        lifecycle_status: d.lifecycle_status,
        approval_team_pending: formatPendingForApi(pending),
        ...formatMasterApprovalAssigneeFields(row),
      };
    },
  };
}

module.exports = {
  handleMasterApprovalPatch,
  rmApprovalHooks,
  pmApprovalHooks,
  prApprovalHooks,
};

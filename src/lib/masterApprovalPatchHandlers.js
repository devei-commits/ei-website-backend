/**
 * Shared PATCH …/approval-status handler for RM / PM / PR masters.
 */
const {
  resolveMasterApprovalPatch,
  readMasterApprovalStatusFromFormData,
  normalizeMasterApprovalStatus,
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
  readActorFromReq,
  recordMasterApprovalStatusHistory,
} = require('./masterApprovalStatusHistory');

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
async function handleMasterApprovalPatch(req, res, kind, row, hooks) {
  const body = req.body || {};
  if (!bodyRequestsAssigneeUpdate(body) && !bodyRequestsStatusUpdate(body)) {
    res.status(400).json({
      error: 'Provide status, advance, and/or approval_stage_assignees',
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
      await row.update({ ...assignPatch, updated_at: new Date() });
    }
  }

  if (bodyRequestsStatusUpdate(body)) {
    await row.reload();
    const current = hooks.readCurrentStatus(row);
    const stageAssignees = readMasterApprovalStageAssignees(row);
    if (!(await canApproveAtCurrentStage(req, kind, current, stageAssignees))) {
      sendApprovalForbidden(
        res,
        'Only the person assigned to this approval stage (or an admin) may advance the status.'
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
    await hooks.applyStatus(row, resolved.status);
    if (fromStatus !== toStatus) {
      const masterId = hooks.readMasterId
        ? hooks.readMasterId(row)
        : parseInt(String(row.get('id') ?? row.get('product_id') ?? ''), 10);
      await recordMasterApprovalStatusHistory({
        kind,
        masterId,
        masterCode: hooks.readMasterCode ? hooks.readMasterCode(row) : null,
        fromStatus,
        toStatus,
        actor: readActorFromReq(req),
        source: body.advance === true ? 'advance' : 'status_set',
      });
    }
  }

  await row.reload();
  res.json(hooks.formatResponse(row));
  return true;
}

function rmApprovalHooks(formatRawMaterial) {
  return {
    readCurrentStatus(row) {
      const d = row.get({ plain: true });
      return d.status ?? 'Draft';
    },
    readMasterId(row) {
      return row.get('id');
    },
    readMasterCode(row) {
      const d = row.get({ plain: true });
      return d.code ?? null;
    },
    async applyStatus(row, status) {
      await row.update({ status, updated_at: new Date() });
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
      return {
        product_id: d.product_id,
        product_code: d.product_code,
        product_name: d.product_name,
        status: d.status,
        lifecycle_status: d.lifecycle_status,
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

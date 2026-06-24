/**
 * Approval status change audit trail for RM / PM / PR masters.
 */
const { Op } = require('sequelize');
const MasterApprovalStatusHistory = require('./masterApprovalStatusHistoryModel');
const { normalizeMasterApprovalStatus } = require('./masterApprovalStatus');

/** @typedef {'RM' | 'PM' | 'PR'} MasterApprovalKind */

/**
 * @param {import('express').Request} req
 */
function readActorFromReq(req) {
  const u = req && req.user ? req.user : null;
  if (!u) return { userId: null, displayName: null };
  const userId = u.id != null ? parseInt(String(u.id), 10) : null;
  const displayName =
    String(u.fullName || u.display_name || u.email || '').trim() || null;
  return {
    userId: Number.isFinite(userId) && userId > 0 ? userId : null,
    displayName,
  };
}

function formatHistoryRow(row) {
  const plain = row && typeof row.get === 'function' ? row.get({ plain: true }) : row;
  return {
    id: plain.id,
    masterKind: plain.master_kind,
    masterId: plain.master_id,
    masterCode: plain.master_code ?? null,
    fromStatus: plain.from_status ?? null,
    toStatus: plain.to_status,
    changedByUserId: plain.changed_by_user_id ?? null,
    changedByDisplayName: plain.changed_by_display_name ?? null,
    source: plain.source ?? null,
    note: plain.note ?? null,
    createdAt: plain.created_at,
  };
}

/**
 * @param {{
 *   kind: MasterApprovalKind,
 *   masterId: number | string,
 *   masterCode?: string | null,
 *   fromStatus: unknown,
 *   toStatus: unknown,
 *   actor?: { userId?: number | null, displayName?: string | null },
 *   source?: string,
 *   note?: string | null,
 *   transaction?: import('sequelize').Transaction,
 * }} opts
 */
async function recordMasterApprovalStatusHistory(opts) {
  const masterId = parseInt(String(opts.masterId ?? ''), 10);
  if (!Number.isFinite(masterId) || masterId <= 0) return null;

  const fromNorm = opts.fromStatus != null && String(opts.fromStatus).trim() !== ''
    ? normalizeMasterApprovalStatus(opts.fromStatus)
    : null;
  const toNorm = normalizeMasterApprovalStatus(opts.toStatus, 'Draft');
  if (fromNorm === toNorm && !opts.allowSameStatus) return null;

  const actor = opts.actor ?? {};
  try {
    const row = await MasterApprovalStatusHistory.create(
      {
        master_kind: opts.kind,
        master_id: masterId,
        master_code: opts.masterCode != null ? String(opts.masterCode).trim() || null : null,
        from_status: fromNorm,
        to_status: toNorm,
        changed_by_user_id:
          actor.userId != null && Number.isFinite(actor.userId) ? actor.userId : null,
        changed_by_display_name: actor.displayName ?? null,
        source: opts.source != null ? String(opts.source).trim() || null : 'approval_status_patch',
        note: opts.note != null && String(opts.note).trim() ? String(opts.note).trim() : null,
        created_at: new Date(),
      },
      opts.transaction ? { transaction: opts.transaction } : {}
    );
    return row;
  } catch (err) {
    console.error('[master-approval-history] Failed to record status change', err);
    return null;
  }
}

/**
 * @param {MasterApprovalKind} kind
 * @param {number | string} masterId
 * @param {{ limit?: number }} [opts]
 */
async function listMasterApprovalStatusHistory(kind, masterId, opts = {}) {
  const id = parseInt(String(masterId ?? ''), 10);
  if (!Number.isFinite(id) || id <= 0) return [];

  const limit = Math.min(Math.max(parseInt(String(opts.limit ?? 50), 10) || 50, 1), 200);

  const rows = await MasterApprovalStatusHistory.findAll({
    where: { master_kind: kind, master_id: id },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit,
  });

  return rows.map(formatHistoryRow);
}

/**
 * Express handler factory — GET …/:id/approval-status/history
 * @param {MasterApprovalKind} kind
 * @param {(req: import('express').Request) => Promise<import('sequelize').Model | null>} loadRow
 */
function createMasterApprovalStatusHistoryHandler(kind, loadRow) {
  return async function getMasterApprovalStatusHistory(req, res) {
    try {
      const row = await loadRow(req);
      if (!row) {
        return res.status(404).json({ error: 'Master record not found', code: 'MASTER_NOT_FOUND' });
      }
      const d = row.get({ plain: true });
      const masterId = kind === 'PR' ? d.product_id : d.id;
      const entries = await listMasterApprovalStatusHistory(kind, masterId, {
        limit: req.query.limit,
      });
      return res.json({ success: true, data: { entries } });
    } catch (err) {
      console.error(`GET approval-status/history (${kind}) error`, err);
      return res.status(500).json({ error: err.message || 'Failed to load approval status history' });
    }
  };
}

module.exports = {
  readActorFromReq,
  formatHistoryRow,
  recordMasterApprovalStatusHistory,
  listMasterApprovalStatusHistory,
  createMasterApprovalStatusHistoryHandler,
};

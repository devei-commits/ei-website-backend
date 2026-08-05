/**
 * PO Approval workflow controller (Flowchart Sub-flow E).
 *
 * Approval is a SEPARATE axis from purchase_orders.status (Draft/Released/…), so
 * the existing release + GRN sync is untouched. approval_status moves:
 *
 *   (null | changes_requested | rejected)
 *        --submit_review-->  under_review
 *   under_review  --forward-->        under_approval   (two-step / CFO only)
 *   under_review  --approve-->        approved         (single-step)
 *   under_approval --approve-->       approved         (two-step)
 *   under_review|under_approval --request_changes--> changes_requested
 *   under_review|under_approval --reject-->          rejected
 */
const PurchaseOrder = require('./models');
const PoApprovalLog = require('./poApprovalLog.model');
const {
  resolvePoApprovalRoute,
  computePoAmountFromItems,
  normalizePoType,
  ROLE,
} = require('./poApprovalMatrix');
const { userCanActAs, roleLabel } = require('./poApprovalRoles');

const APPROVAL_ATTRS = [
  'id', 'order_id', 'vendor_name', 'status', 'items', 'form_data',
  'po_type', 'approval_status', 'approval_required_role', 'approval_amount',
  'submitted_for_review_at', 'approved_at',
];

const ACTIONS = ['submit_review', 'forward', 'approve', 'request_changes', 'reject'];

function isMissingColumnError(err) {
  const code = err?.original?.code ?? err?.parent?.code;
  return code === '42703';
}

function actorFromReq(req) {
  const u = req.user || {};
  return {
    id: Number.isFinite(Number(u.id)) ? Number(u.id) : null,
    name: u.fullName || u.email || 'Unknown',
    role: String(u.role || '').trim().toLowerCase() || null,
  };
}

function poTypeOf(row) {
  const fd = row.get('form_data');
  const fromForm = fd && typeof fd === 'object' ? fd.poType : null;
  return normalizePoType(row.get('po_type') || fromForm || 'regular');
}

function amountOf(row) {
  const items = row.get('items');
  const fromItems = computePoAmountFromItems(items);
  if (fromItems > 0) return fromItems;
  const snap = Number(row.get('approval_amount'));
  if (Number.isFinite(snap) && snap > 0) return snap;
  // H10: never let a real PO route as amount 0 (which would skip the CFO/threshold gate
  // and single-step-approve a large PO). Fall back to any denormalized total we can find.
  const fd = row.get('form_data');
  const fdObj = fd && typeof fd === 'object' && !Array.isArray(fd) ? fd : {};
  const candidates = [
    row.get('grand_total'),
    row.get('po_value'),
    fdObj.grandTotal,
    fdObj.grand_total,
    fdObj.total,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

async function writeLog(row, { action, fromStatus, toStatus, route, actor, note }) {
  try {
    await PoApprovalLog.create({
      purchase_order_id: row.get('id'),
      action,
      from_status: fromStatus || null,
      to_status: toStatus || null,
      required_role: route ? route.finalApprover : null,
      po_type: route ? route.poType : null,
      amount: route ? route.amount : null,
      actor_id: actor.id,
      actor_name: actor.name,
      actor_role: actor.role,
      note: note ? String(note).slice(0, 1000) : null,
    });
  } catch (err) {
    if (!isMissingColumnError(err)) {
      console.warn('[poApproval] writeLog failed:', err && err.message ? err.message : err);
    }
  }
}

function schemaError(res) {
  return res.status(409).json({
    error: 'PO approval workflow columns are not migrated on this database yet.',
    code: 'APPROVAL_SCHEMA_MISSING',
  });
}

async function loadPo(id) {
  try {
    return await PurchaseOrder.findByPk(id, { attributes: APPROVAL_ATTRS });
  } catch (err) {
    if (isMissingColumnError(err)) return '__SCHEMA__';
    throw err;
  }
}

/**
 * POST /purchase-orders/:id/approval/submit
 * Buyer submits a Draft PO into the approval workflow.
 */
async function submitPoForReview(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await loadPo(id);
    if (row === '__SCHEMA__') return schemaError(res);
    if (!row) return res.status(404).json({ error: 'Purchase order not found' });

    const current = String(row.get('approval_status') || '').trim();
    if (['under_review', 'under_approval', 'approved'].includes(current)) {
      return res.status(409).json({
        error: `PO is already in the approval workflow (${current}).`,
        code: 'ALREADY_IN_WORKFLOW',
      });
    }

    const route = resolvePoApprovalRoute({ poType: poTypeOf(row), amount: amountOf(row) });
    const note = req.body && req.body.note ? String(req.body.note) : null;
    const actor = actorFromReq(req);

    try {
      await row.update({
        approval_status: 'under_review',
        approval_required_role: route.finalApprover,
        approval_amount: route.amount,
        submitted_for_review_at: new Date(),
        approved_at: null,
      });
    } catch (err) {
      if (isMissingColumnError(err)) return schemaError(res);
      throw err;
    }

    await writeLog(row, { action: 'submit_review', fromStatus: current || null, toStatus: 'under_review', route, actor, note });
    return res.json(buildResult(row, route));
  } catch (err) {
    console.error('submitPoForReview error', err);
    return res.status(500).json({ error: 'Failed to submit PO for review' });
  }
}

/**
 * POST /purchase-orders/:id/approval/action  { action, note }
 * forward | approve | request_changes | reject
 */
async function actOnPoApproval(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const action = String((req.body && req.body.action) || '').trim();
    if (!ACTIONS.includes(action) || action === 'submit_review') {
      return res.status(400).json({ error: `Invalid action. Use one of: forward, approve, request_changes, reject.` });
    }

    const row = await loadPo(id);
    if (row === '__SCHEMA__') return schemaError(res);
    if (!row) return res.status(404).json({ error: 'Purchase order not found' });

    const current = String(row.get('approval_status') || '').trim();
    if (!['under_review', 'under_approval'].includes(current)) {
      return res.status(409).json({
        error: `PO is not awaiting an approval decision (current: ${current || 'not submitted'}).`,
        code: 'NOT_IN_DECISION_STATE',
      });
    }

    const route = resolvePoApprovalRoute({ poType: poTypeOf(row), amount: amountOf(row) });
    const actor = actorFromReq(req);
    const note = req.body && req.body.note ? String(req.body.note) : null;

    // ── Permission + transition per action ──────────────────────────────────
    let nextStatus = null;
    const patch = {};

    if (action === 'forward') {
      if (!route.twoStep) {
        return res.status(409).json({ error: 'This PO is single-step — no CFO forward needed. Approve directly.', code: 'NO_FORWARD_NEEDED' });
      }
      if (current !== 'under_review') {
        return res.status(409).json({ error: 'Only an under-review PO can be forwarded.', code: 'BAD_TRANSITION' });
      }
      if (!userCanActAs(actor.role, ROLE.PROC_HEAD)) {
        return res.status(403).json({ error: 'Only the Procurement Head (or admin) can forward for approval.', code: 'ROLE_REQUIRED' });
      }
      nextStatus = 'under_approval';
    } else if (action === 'approve') {
      if (!userCanActAs(actor.role, route.finalApprover)) {
        return res.status(403).json({
          error: `${roleLabel(route.finalApprover)} approval required for this PO (${route.note}).`,
          code: 'ROLE_REQUIRED',
        });
      }
      nextStatus = 'approved';
      patch.approved_at = new Date();
    } else if (action === 'request_changes') {
      if (!userCanActAs(actor.role, ROLE.PROC_HEAD) && !userCanActAs(actor.role, route.finalApprover)) {
        return res.status(403).json({ error: 'Only a reviewer/approver can request changes.', code: 'ROLE_REQUIRED' });
      }
      nextStatus = 'changes_requested';
    } else if (action === 'reject') {
      if (!userCanActAs(actor.role, ROLE.PROC_HEAD) && !userCanActAs(actor.role, route.finalApprover)) {
        return res.status(403).json({ error: 'Only a reviewer/approver can reject.', code: 'ROLE_REQUIRED' });
      }
      nextStatus = 'rejected';
    }

    patch.approval_status = nextStatus;
    try {
      await row.update(patch);
    } catch (err) {
      if (isMissingColumnError(err)) return schemaError(res);
      throw err;
    }

    await writeLog(row, { action, fromStatus: current, toStatus: nextStatus, route, actor, note });
    return res.json(buildResult(row, route));
  } catch (err) {
    console.error('actOnPoApproval error', err);
    return res.status(500).json({ error: 'Failed to record approval decision' });
  }
}

/** GET /purchase-orders/:id/approval — current state + full trail. */
async function getPoApprovalTrail(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await loadPo(id);
    if (row === '__SCHEMA__') return schemaError(res);
    if (!row) return res.status(404).json({ error: 'Purchase order not found' });

    let logs = [];
    try {
      logs = await PoApprovalLog.findAll({
        where: { purchase_order_id: id },
        order: [['id', 'ASC']],
      });
    } catch (err) {
      if (!isMissingColumnError(err)) throw err;
    }
    const route = resolvePoApprovalRoute({ poType: poTypeOf(row), amount: amountOf(row) });
    const out = buildResult(row, route);
    out.trail = logs.map((l) => {
      const d = l.get ? l.get({ plain: true }) : l;
      return {
        id: d.id,
        action: d.action,
        fromStatus: d.from_status,
        toStatus: d.to_status,
        requiredRole: d.required_role,
        actorName: d.actor_name,
        actorRole: d.actor_role,
        amount: d.amount != null ? Number(d.amount) : null,
        note: d.note,
        at: d.created_at,
      };
    });
    return res.json(out);
  } catch (err) {
    console.error('getPoApprovalTrail error', err);
    return res.status(500).json({ error: 'Failed to load approval trail' });
  }
}

function buildResult(row, route) {
  return {
    id: String(row.get('id')),
    orderId: row.get('order_id'),
    poType: route.poType,
    approvalStatus: row.get('approval_status') ?? null,
    approvalRequiredRole: row.get('approval_required_role') ?? route.finalApprover,
    approvalAmount: amountOf(row),
    submittedForReviewAt: row.get('submitted_for_review_at') ?? null,
    approvedAt: row.get('approved_at') ?? null,
    route: {
      finalApprover: route.finalApprover,
      finalApproverLabel: roleLabel(route.finalApprover),
      reviewers: route.reviewers,
      requiresCfo: route.requiresCfo,
      twoStep: route.twoStep,
      deviationFlag: route.deviationFlag,
      note: route.note,
    },
  };
}

module.exports = {
  submitPoForReview,
  actOnPoApproval,
  getPoApprovalTrail,
};

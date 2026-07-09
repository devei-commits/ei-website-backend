/**
 * PR master dual-track approval — independent RM + PM tracks.
 *
 * Each PR carries two approval tracks stored in `products.pr_track_approvals`:
 *   { rm: TrackState, pm: TrackState }
 *   TrackState = { status, sent_at, sent_by, approved_at, approved_by, note }
 *   status ∈ 'Draft' → 'Sent for Approval' → 'Approved'
 *
 * Rules (see product spec):
 *  - Editing the RM section (formula/SKU BOM, production-kind process steps) while the rm_team
 *    slot is OPEN auto-assigns the editor as the RM owner; likewise the PM section (pack BOM,
 *    packaging-kind process steps) → pack_team. Once a section is owned, only that owner (or an
 *    admin) may edit it.
 *  - "Send for RM/PM approval" moves that track Draft → Sent for Approval.
 *  - "Approve RM/PM status" moves Sent for Approval → Approved (owner of that track, or admin).
 *  - The PR is Active only when BOTH tracks are Approved. Any RM/PM section edit resets BOTH
 *    tracks back to Draft (whole PR must be re-approved).
 */
const { isPrivilegedRole } = require('../middleware/security');
const { hasMasterApprovalTeamAccess } = require('./masterApprovalAuth');
const { readMasterApprovalStageAssignees } = require('./masterApprovalAssignee');
const { readActorFromReq } = require('./masterApprovalStatusHistory');

/** @typedef {'rm' | 'pm'} PrTrackKey */

const TRACK_KEYS = /** @type {const} */ (['rm', 'pm']);
const TRACK_STATUSES = /** @type {const} */ (['Draft', 'Sent for Approval', 'Approved']);
/** Which approval_stage_assignees slot owns each track. */
const TRACK_STAGE_KEY = /** @type {const} */ ({ rm: 'rm_team', pm: 'pack_team' });
/** Which master-approval resource kind gates fallback team access per track. */
const TRACK_KIND = /** @type {const} */ ({ rm: 'RM', pm: 'PM' });
const TRACK_LABEL = /** @type {const} */ ({ rm: 'RM', pm: 'PM' });

function emptyTrackState() {
  return {
    status: 'Draft',
    sent_at: null,
    sent_by: null,
    approved_at: null,
    approved_by: null,
    note: null,
  };
}

/** @returns {{ rm: ReturnType<typeof emptyTrackState>, pm: ReturnType<typeof emptyTrackState> }} */
function emptyTrackApprovals() {
  return { rm: emptyTrackState(), pm: emptyTrackState() };
}

function normalizeTrackStatus(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 'Draft';
  const found = TRACK_STATUSES.find((x) => x.toLowerCase() === s.toLowerCase());
  return found || 'Draft';
}

/**
 * @param {unknown} raw
 * @returns {{ user_id: number, display_name: string } | null}
 */
function normalizeActorSlot(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = /** @type {Record<string, unknown>} */ (raw);
  const id = parseInt(String(o.user_id ?? o.userId ?? ''), 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  const name = String(o.display_name ?? o.displayName ?? `User #${id}`).trim();
  return { user_id: id, display_name: name || `User #${id}` };
}

function normalizeTrackState(raw) {
  const base = emptyTrackState();
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const o = /** @type {Record<string, unknown>} */ (raw);
  return {
    status: normalizeTrackStatus(o.status),
    sent_at: o.sent_at ?? o.sentAt ?? null,
    sent_by: normalizeActorSlot(o.sent_by ?? o.sentBy),
    approved_at: o.approved_at ?? o.approvedAt ?? null,
    approved_by: normalizeActorSlot(o.approved_by ?? o.approvedBy),
    note: o.note != null && String(o.note).trim() !== '' ? String(o.note).trim() : null,
  };
}

/**
 * @param {import('sequelize').Model | Record<string, unknown>} record
 */
function readTrackApprovals(record) {
  const d = record && typeof record.get === 'function' ? record.get({ plain: true }) : record || {};
  let json = d.pr_track_approvals;
  if (typeof json === 'string') {
    try {
      json = JSON.parse(json);
    } catch {
      json = null;
    }
  }
  const out = emptyTrackApprovals();
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    out.rm = normalizeTrackState(/** @type {Record<string, unknown>} */ (json).rm);
    out.pm = normalizeTrackState(/** @type {Record<string, unknown>} */ (json).pm);
  }
  return out;
}

function formatTrackApprovalsForApi(tracks) {
  const t = tracks || emptyTrackApprovals();
  return { rm: { ...t.rm }, pm: { ...t.pm } };
}

/**
 * PR overall approval status derived from the two tracks.
 * Active only when both Approved; Under Approval when either is Sent for Approval; else Draft.
 * @returns {'Active' | 'Under Approval' | 'Draft'}
 */
function deriveOverallStatus(tracks) {
  const t = tracks || emptyTrackApprovals();
  if (t.rm.status === 'Approved' && t.pm.status === 'Approved') return 'Active';
  // Any forward progress on either track (sent or one side approved) → Under Approval.
  if (t.rm.status !== 'Draft' || t.pm.status !== 'Draft') return 'Under Approval';
  return 'Draft';
}

// ---------------------------------------------------------------------------
// Section change detection (which of the RM / PM aspects actually changed)
// ---------------------------------------------------------------------------

/** Stable JSON — sorts object keys so key ordering / whitespace never registers as a change. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function linesEqual(a, b) {
  const A = Array.isArray(a) ? a : [];
  const B = Array.isArray(b) ? b : [];
  return stableStringify(A) === stableStringify(B);
}

function numClose(a, b) {
  if (a == null && b == null) return true;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return String(a ?? '') === String(b ?? '');
  return Math.abs(na - nb) < 1e-9;
}

/** Mirrors the frontend's normalizePrProcessStepKind (EI-Admin-Dashboard/src/lib/prFormTeamAccess.ts) — unrecognized/missing kind defaults to 'production' (RM). */
function normalizeStepKind(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  return s === 'packaging' || s === 'pack' ? 'packaging' : 'production';
}

function stepsOfKind(steps, kind) {
  return (Array.isArray(steps) ? steps : []).filter(
    (s) => normalizeStepKind(s && (s.step_kind ?? s.stepKind)) === kind
  );
}

/**
 * Compare the incoming BOM payload against the stored BOM row to decide which section(s) changed.
 * RM aspects: rm_lines, sku_rm_lines, SKU limit qty/uom, production-kind process_steps.
 * PM aspects: pm_lines, packaging-kind process_steps.
 * Only keys actually present in the payload are considered (absent key = unchanged section field).
 * @param {Record<string, unknown> | null | undefined} bomPayload
 * @param {import('sequelize').Model | Record<string, unknown> | null | undefined} existingBom
 * @returns {{ rm: boolean, pm: boolean }}
 */
function detectChangedSections(bomPayload, existingBom) {
  const result = { rm: false, pm: false };
  if (!bomPayload || typeof bomPayload !== 'object') return result;
  const bom = existingBom && typeof existingBom.get === 'function'
    ? existingBom.get({ plain: true })
    : existingBom || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(bomPayload, k);
  const p = /** @type {Record<string, any>} */ (bomPayload);

  // RM section
  if (Array.isArray(p.rm_lines) && !linesEqual(p.rm_lines, bom.rm_lines)) result.rm = true;
  if (Array.isArray(p.sku_rm_lines) && !linesEqual(p.sku_rm_lines, bom.sku_rm_lines)) result.rm = true;
  if ((has('sku_bom_limit_qty') || has('skuBomLimitQty')) &&
    !numClose(p.sku_bom_limit_qty ?? p.skuBomLimitQty, bom.sku_bom_limit_qty)) {
    result.rm = true;
  }
  if ((has('sku_bom_limit_uom') || has('skuBomLimitUom')) &&
    String(p.sku_bom_limit_uom ?? p.skuBomLimitUom ?? '') !== String(bom.sku_bom_limit_uom ?? '')) {
    result.rm = true;
  }

  // PM section
  if (Array.isArray(p.pm_lines) && !linesEqual(p.pm_lines, bom.pm_lines)) result.pm = true;

  // process_steps holds both production (RM) and packaging (PM) rows — compare each kind
  // independently so editing one team's steps never gets attributed to the other's track.
  if (Array.isArray(p.process_steps)) {
    if (!linesEqual(stepsOfKind(p.process_steps, 'production'), stepsOfKind(bom.process_steps, 'production'))) {
      result.rm = true;
    }
    if (!linesEqual(stepsOfKind(p.process_steps, 'packaging'), stepsOfKind(bom.process_steps, 'packaging'))) {
      result.pm = true;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Ownership & permissions
// ---------------------------------------------------------------------------

/**
 * @param {import('sequelize').Model | Record<string, unknown>} row
 * @param {PrTrackKey} track
 * @returns {{ userId: number, displayName: string } | null}
 */
function readTrackOwner(row, track) {
  const stages = readMasterApprovalStageAssignees(row);
  const slot = stages[TRACK_STAGE_KEY[track]];
  return slot && slot.userId ? { userId: slot.userId, displayName: slot.displayName } : null;
}

function callerIdFromReq(req) {
  const id = req && req.user ? parseInt(String(req.user.id), 10) : NaN;
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * May this caller edit the given section right now?
 * Admins always may. Otherwise: if the slot is open, anyone with team access (they'll be
 * auto-assigned); if owned, only the owner.
 * @param {import('express').Request} req
 * @param {import('sequelize').Model | Record<string, unknown>} row
 * @param {PrTrackKey} track
 */
async function canEditTrackSection(req, row, track) {
  if (!req || !req.user) return false;
  if (isPrivilegedRole(req.user)) return true;
  const owner = readTrackOwner(row, track);
  const callerId = callerIdFromReq(req);
  if (owner) return owner.userId === callerId;
  // Open slot — anyone with team access may take it.
  return hasMasterApprovalTeamAccess(req, TRACK_KIND[track]);
}

/**
 * May this caller act (send / approve / revert) on the given track?
 * @param {import('express').Request} req
 * @param {import('sequelize').Model | Record<string, unknown>} row
 * @param {PrTrackKey} track
 */
async function canActOnTrack(req, row, track) {
  if (!req || !req.user) return false;
  if (isPrivilegedRole(req.user)) return true;
  const owner = readTrackOwner(row, track);
  const callerId = callerIdFromReq(req);
  if (owner) return owner.userId === callerId;
  return hasMasterApprovalTeamAccess(req, TRACK_KIND[track]);
}

// ---------------------------------------------------------------------------
// Track transitions (send / approve / revert)
// ---------------------------------------------------------------------------

const { recordMasterApprovalStatusHistory } = require('./masterApprovalStatusHistory');

function actorSlotFromReq(req) {
  const actor = readActorFromReq(req);
  if (!actor.userId) return null;
  return { user_id: actor.userId, display_name: actor.displayName || `User #${actor.userId}` };
}

/**
 * Apply a send / approve / revert action to one track, recompute the PR overall status,
 * persist, and record history.
 * @param {{
 *   req: import('express').Request,
 *   row: import('sequelize').Model,
 *   track: PrTrackKey,
 *   action: 'send' | 'approve' | 'revert',
 *   note?: string | null,
 *   hooks: {
 *     readMasterId: (row: import('sequelize').Model) => number,
 *     readMasterCode: (row: import('sequelize').Model) => string | null,
 *   },
 * }} opts
 */
async function applyTrackAction(opts) {
  const { req, row, track, action, hooks } = opts;
  const note = opts.note ?? null;
  if (!TRACK_KEYS.includes(track)) {
    return { error: `Invalid track "${track}" (expected rm or pm)`, code: 'PR_TRACK_INVALID' };
  }
  if (!['send', 'approve', 'revert'].includes(action)) {
    return { error: `Invalid track action "${action}"`, code: 'PR_TRACK_ACTION_INVALID' };
  }

  const tracks = readTrackApprovals(row);
  const state = tracks[track];
  const label = TRACK_LABEL[track];
  const actor = actorSlotFromReq(req);

  if (action === 'send') {
    if (state.status === 'Sent for Approval') {
      return { error: `${label} approval has already been requested.`, code: 'PR_TRACK_ALREADY_SENT' };
    }
    if (state.status === 'Approved') {
      return { error: `${label} track is already approved.`, code: 'PR_TRACK_ALREADY_APPROVED' };
    }
    state.status = 'Sent for Approval';
    state.sent_at = new Date().toISOString();
    state.sent_by = actor;
    state.approved_at = null;
    state.approved_by = null;
    state.note = note;
  } else if (action === 'approve') {
    if (state.status === 'Draft') {
      return { error: `${label} approval must be requested before it can be approved.`, code: 'PR_TRACK_NOT_SENT' };
    }
    if (state.status === 'Approved') {
      return { error: `${label} track is already approved.`, code: 'PR_TRACK_ALREADY_APPROVED' };
    }
    state.status = 'Approved';
    state.approved_at = new Date().toISOString();
    state.approved_by = actor;
    state.note = note;
  } else {
    // revert
    if (state.status === 'Approved') {
      state.status = 'Sent for Approval';
      state.approved_at = null;
      state.approved_by = null;
    } else if (state.status === 'Sent for Approval') {
      state.status = 'Draft';
      state.sent_at = null;
      state.sent_by = null;
    } else {
      return { error: `${label} track is already at Draft.`, code: 'PR_TRACK_NO_PREVIOUS' };
    }
    state.note = note;
  }

  const fromOverall = deriveOverallStatus(readTrackApprovals(row));
  const toOverall = deriveOverallStatus(tracks);

  await row.update({
    pr_track_approvals: formatTrackApprovalsForApi(tracks),
    status: toOverall,
    lifecycle_status: toOverall,
    updated_at: new Date(),
  });

  await recordMasterApprovalStatusHistory({
    kind: 'PR',
    masterId: hooks.readMasterId(row),
    masterCode: hooks.readMasterCode(row),
    fromStatus: fromOverall,
    toStatus: toOverall,
    actor: { userId: actor?.user_id ?? null, displayName: actor?.display_name ?? null },
    source: `pr_${track}_${action}`,
    allowSameStatus: true,
    note: note || `${label} ${action === 'send' ? 'sent for approval' : action === 'approve' ? 'approved' : 'reverted'}.`,
  });

  return { ok: true, tracks, overall: toOverall };
}

module.exports = {
  TRACK_KEYS,
  TRACK_STATUSES,
  TRACK_STAGE_KEY,
  TRACK_KIND,
  TRACK_LABEL,
  emptyTrackState,
  emptyTrackApprovals,
  normalizeTrackStatus,
  readTrackApprovals,
  formatTrackApprovalsForApi,
  deriveOverallStatus,
  detectChangedSections,
  readTrackOwner,
  canEditTrackSection,
  canActOnTrack,
  callerIdFromReq,
  stableStringify,
  applyTrackAction,
};

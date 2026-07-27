/**
 * Per-line transfer phases for outbound MTR (WH → MU). Stored in DB as line_transfer_status JSON:
 * { [lineItemId]: 'not_initiated' | 'in_transit' | 'received_at_mu' | 'completed' }
 */

const PHASE = {
  NOT_INITIATED: 'not_initiated',
  IN_TRANSIT: 'in_transit',
  RECEIVED_AT_MU: 'received_at_mu',
  COMPLETED: 'completed',
};

const PHASE_RANK = {
  [PHASE.NOT_INITIATED]: 0,
  [PHASE.IN_TRANSIT]: 1,
  [PHASE.RECEIVED_AT_MU]: 2,
  [PHASE.COMPLETED]: 3,
};

function lineItemId(line, idx) {
  return String(line?.id || `m${idx + 1}`);
}

function getLineItemIds(lineItems) {
  if (!Array.isArray(lineItems)) return [];
  return lineItems.map((li, i) => lineItemId(li, i));
}

function normalizeMrnHeaderStatus(status) {
  const s = String(status || '').trim();
  if (s.toLowerCase() === 'succeeded') return 'Completed';
  return s;
}

/** When DB has no map, infer per-line phase from legacy header status (all lines same). */
function legacyPhaseForAllLines(headerStatus) {
  const s = normalizeMrnHeaderStatus(headerStatus) || 'Pending';
  if (s === 'Completed') return PHASE.COMPLETED;
  if (s === 'Received at MU') return PHASE.RECEIVED_AT_MU;
  if (s === 'In Transit' || s === 'In Transfer') return PHASE.IN_TRANSIT;
  // 'Picked' means picked and READY to dispatch — the transfer hasn't been initiated yet, so
  // its lines are not_initiated. (Inferring in_transit here blocked dispatch from advancing them,
  // so the status silently reverted to In Pick on reload.)
  return PHASE.NOT_INITIATED;
}

/**
 * @param {Array} lineItems
 * @param {Record<string, string>|null|undefined} storedRaw
 * @param {string} headerStatus
 */
function normalizeLineTransferMap(lineItems, storedRaw, headerStatus) {
  const ids = getLineItemIds(lineItems);
  const out = {};
  const stored =
    storedRaw && typeof storedRaw === 'object' && !Array.isArray(storedRaw) ? { ...storedRaw } : {};
  const hasStoredKeys = Object.keys(stored).length > 0;
  const legacyAll = legacyPhaseForAllLines(headerStatus);

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const v = stored[id];
    if (v && PHASE_RANK[v] !== undefined) {
      out[id] = v;
    } else if (hasStoredKeys) {
      out[id] = PHASE.NOT_INITIATED;
    } else {
      out[id] = legacyAll;
    }
  }
  return out;
}

/**
 * Aggregate header status from per-line map (non-completed lines drive workflow).
 * @param {Array} lineItems
 * @param {Record<string, string>} map
 * @param {string} previousHeaderStatus — preserve Picked when no line has left WH yet
 */
function recomputeOutboundMtrAggregateStatus(lineItems, map, previousHeaderStatus) {
  const ids = getLineItemIds(lineItems);
  if (ids.length === 0) return normalizeMrnHeaderStatus(previousHeaderStatus) || 'Pending';

  const prev = normalizeMrnHeaderStatus(previousHeaderStatus) || 'Pending';
  const nonTerminal = ids.filter((id) => map[id] !== PHASE.COMPLETED);
  if (nonTerminal.length === 0) return 'Completed';

  let max = 0;
  for (const id of nonTerminal) {
    const r = PHASE_RANK[map[id]] ?? 0;
    if (r > max) max = r;
  }

  if (max === 0) {
    if (prev === 'Picked') return 'Picked';
    return 'Pending';
  }
  if (max === 1) return 'In Transit';
  if (max === 2) return 'Received at MU';
  return 'Received at MU';
}

function assertSubset(ids, allowedSet) {
  for (const id of ids) {
    if (!allowedSet.has(String(id))) return `Unknown line id: ${id}`;
  }
  return null;
}

module.exports = {
  PHASE,
  PHASE_RANK,
  lineItemId,
  getLineItemIds,
  normalizeLineTransferMap,
  recomputeOutboundMtrAggregateStatus,
  legacyPhaseForAllLines,
  assertSubset,
};

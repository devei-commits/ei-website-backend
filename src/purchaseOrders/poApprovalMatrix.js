/**
 * PO Approval threshold matrix (mirrors EI_PO_Flowchart.html · Sub-flow E).
 *
 * Routes a Draft PO to the correct reviewer/approver based on PO type + amount.
 * The frontend keeps a parallel copy in src/constants/procurement.ts — keep the
 * thresholds in sync if they change.
 */

// Approver roles (abstract — mapped to real usertypes in poApprovalRoles.js).
const ROLE = {
  PROC_HEAD: 'proc_head',
  CFO: 'cfo',
  QA_HEAD: 'qa_head',
  RND_HEAD: 'rnd_head',
};

// Amount gates (INR).
const REGULAR_CFO_THRESHOLD = 500000; // > ₹5L Regular needs CFO
const SAMPLE_CFO_THRESHOLD = 50000; // > ₹50k Sample needs CFO + R&D

const PO_TYPES = ['regular', 'blanket', 'spot', 'consignment', 'sample'];

function normalizePoType(poType) {
  const t = String(poType || '').trim().toLowerCase();
  return PO_TYPES.includes(t) ? t : 'regular';
}

/**
 * Resolve the approval route for a PO.
 * @param {{ poType?: string, amount?: number, creditBreach?: boolean }} args
 * @returns {{
 *   poType: string,
 *   amount: number,
 *   reviewers: string[],
 *   finalApprover: string,
 *   requiresCfo: boolean,
 *   twoStep: boolean,
 *   deviationFlag: boolean,
 *   note: string,
 * }}
 */
function resolvePoApprovalRoute(args) {
  const poType = normalizePoType(args && args.poType);
  const amount = Number(args && args.amount) || 0;
  const creditBreach = !!(args && args.creditBreach);

  let reviewers = [ROLE.PROC_HEAD];
  let finalApprover = ROLE.PROC_HEAD;
  let deviationFlag = false;
  let note = 'Single-step — Procurement Head reviews and approves.';

  switch (poType) {
    case 'regular':
      if (amount > REGULAR_CFO_THRESHOLD) {
        finalApprover = ROLE.CFO;
        note = `Regular PO above ₹${REGULAR_CFO_THRESHOLD.toLocaleString('en-IN')} — CFO approval required.`;
      }
      break;
    case 'blanket':
      finalApprover = ROLE.CFO;
      note = 'Blanket (umbrella) PO — CFO approval required.';
      break;
    case 'spot':
      finalApprover = ROLE.CFO;
      deviationFlag = true;
      note = 'Spot / Emergency PO — deviation flagged, CFO approval required.';
      break;
    case 'consignment':
      reviewers = [ROLE.PROC_HEAD, ROLE.QA_HEAD];
      finalApprover = ROLE.CFO;
      note = 'Consignment PO — QA Head review + CFO approval (vendor stock at EI).';
      break;
    case 'sample':
      if (amount > SAMPLE_CFO_THRESHOLD) {
        reviewers = [ROLE.PROC_HEAD, ROLE.RND_HEAD];
        finalApprover = ROLE.CFO;
        note = `Sample / Trial above ₹${SAMPLE_CFO_THRESHOLD.toLocaleString('en-IN')} — R&D review + CFO approval.`;
      } else {
        note = 'Sample / Trial — Procurement Head approves (auto-links to Trial Batch).';
      }
      break;
    default:
      break;
  }

  // Credit-limit breach forces CFO regardless of type/amount (payables risk gate).
  if (creditBreach && finalApprover !== ROLE.CFO) {
    finalApprover = ROLE.CFO;
    note = `${note} Credit-limit breach — escalated to CFO.`;
  }

  const requiresCfo = finalApprover === ROLE.CFO;
  return {
    poType,
    amount,
    reviewers,
    finalApprover,
    requiresCfo,
    // Two-step = a distinct approver beyond the reviewing Procurement Head.
    twoStep: requiresCfo,
    deviationFlag,
    note,
  };
}

/** Sum a PO's line items (qty × rate, + tax) to an inclusive amount for routing. */
function computePoAmountFromItems(items) {
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const raw of items) {
    const ln = raw || {};
    const qty = Number(ln.quantity ?? ln.qty ?? 0) || 0;
    const rate = Number(ln.rate ?? ln.pricePerUnit ?? ln.unitPrice ?? 0) || 0;
    const taxPct = Number(ln.tax ?? ln.gstPercent ?? 0) || 0;
    const sub = qty * rate;
    total += sub + sub * (taxPct / 100);
  }
  return Math.round(total * 100) / 100;
}

module.exports = {
  ROLE,
  PO_TYPES,
  REGULAR_CFO_THRESHOLD,
  SAMPLE_CFO_THRESHOLD,
  normalizePoType,
  resolvePoApprovalRoute,
  computePoAmountFromItems,
};

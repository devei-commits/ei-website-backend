/**
 * Treasury → BD Customer Tracker reflect-back (Phase 7).
 * On inward-payment actions we drop a timeline event onto the client's BD record
 * (bd_events) so the relationship owner sees receivable activity. Best-effort:
 * never throws, never blocks the treasury action.
 */
const { num, plain } = require('./helpers');

let BdEvent = null;
try { ({ BdEvent } = require('../bd/models')); } catch (_e) { /* BD module optional */ }

function inr(n) {
  return `₹${new Intl.NumberFormat('en-IN').format(Math.round(num(n)))}`;
}

/**
 * @param {'created'|'confirmed'|'rescheduled'|'write_off'} action
 * @param {object} inwardPlain  the inward payment (plain object)
 * @param {object} req          for actor identity
 * @param {object} [extra]      { newDate, actualAmount } etc.
 */
async function reflectInward(action, inwardPlain, req, extra = {}) {
  if (!BdEvent || !inwardPlain || !inwardPlain.client_id) return;
  const code = inwardPlain.inward_code;
  let title;
  let body;
  if (action === 'created') {
    title = `Next inflow expected: ${inr(inwardPlain.net_expected_amount || inwardPlain.expected_amount)} on ${String(inwardPlain.expected_date).slice(0, 10)}`;
    body = `Treasury recorded ${code} (${inwardPlain.type}).`;
  } else if (action === 'confirmed') {
    title = `Payment received: ${inr(extra.actualAmount ?? inwardPlain.actual_amount)}`;
    body = `Treasury confirmed & reconciled ${code}.`;
  } else if (action === 'rescheduled') {
    title = `Inflow rescheduled to ${String(extra.newDate || inwardPlain.expected_date).slice(0, 10)}`;
    body = `Treasury rescheduled ${code}. Reschedule count: ${num(inwardPlain.reschedule_count)}.`;
  } else if (action === 'write_off') {
    title = `Receivable written off: ${inr(inwardPlain.write_off_amount)}`;
    body = `Treasury wrote off ${code}.`;
  } else {
    return;
  }

  try {
    await BdEvent.create({
      client_id: inwardPlain.client_id,
      type: 'treasury',
      title,
      body,
      ref_type: 'TreasuryInward',
      ref_id: String(inwardPlain.id),
      actor_id: req && req.user ? req.user.id : null,
      actor_name: req && req.user ? req.user.fullName : 'Treasury',
    });
  } catch (e) {
    console.warn('[treasury] reflectInward failed:', e && e.message ? e.message : e);
  }
}

module.exports = { reflectInward };

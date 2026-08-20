/**
 * Idempotent schema patch: add the planner-set commitment date, separate from due_date.
 *
 *   planning_extracted.committed_date  DATE
 *
 * due_date is copied once from the SO's expected_shipment_date at creation and is never edited
 * afterwards. committed_date is the planner's own target, set once they know the real production
 * schedule for that plan — it can diverge from the customer-facing due date.
 *
 * Uses ADD COLUMN IF NOT EXISTS, so a re-run is a no-op. Ships as a merge-time patch that applies
 * on boot to every environment (local == live image).
 */
const db = require('../../db');

let ran = false;

async function ensurePlanningExtractedCommittedDateColumn() {
  if (ran) return { ok: true, skipped: true };
  ran = true;
  try {
    await db.query(
      `ALTER TABLE planning_extracted
         ADD COLUMN IF NOT EXISTS committed_date DATE`,
    );
    return { ok: true };
  } catch (e) {
    console.warn(
      '[schema-patch] ensurePlanningExtractedCommittedDateColumn failed:',
      e && e.message ? e.message : e,
    );
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { ensurePlanningExtractedCommittedDateColumn };

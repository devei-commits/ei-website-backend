/**
 * Idempotent schema patch: BOM confirmation moves from the planning row to the BATCH.
 *
 *   planning_batches.bom_confirmed_at  TIMESTAMPTZ NULL
 *
 * Each planning batch carries its own BOM copy (`rm_lines` / `pm_lines`), so confirmation belongs
 * with the copy being executed. Confirming once on the planning row meant batch 2 inherited batch
 * 1's sign-off even though its BOM can be edited independently — nobody ever re-checked the formula
 * that actually went to the floor.
 *
 * Backfill copies the planning row's `bom_confirmed_at` onto every EXISTING batch, so nothing
 * already planned or in production is suddenly unconfirmed. Batches created after this patch start
 * NULL and must be confirmed on their own.
 */
const db = require('../../db');

let ran = false;

async function ensurePlanningBatchBomConfirmedColumn() {
  if (ran) return { ok: true, skipped: true };
  ran = true;
  try {
    await db.query(
      `ALTER TABLE planning_batches
         ADD COLUMN IF NOT EXISTS bom_confirmed_at TIMESTAMPTZ`,
    );
    // Existing batches inherit the planning row's confirmation — they were planned under it.
    // Only rows that have never been stamped are touched, so a re-run cannot overwrite a real
    // per-batch confirmation with the (older) planning-level one.
    await db.query(
      `UPDATE planning_batches pb
          SET bom_confirmed_at = pe.bom_confirmed_at
         FROM planning_extracted pe
        WHERE pb.planning_extracted_id = pe.id
          AND pb.bom_confirmed_at IS NULL
          AND pe.bom_confirmed_at IS NOT NULL`,
    );
    await db.query(
      `CREATE INDEX IF NOT EXISTS planning_batches_bom_unconfirmed_idx
         ON planning_batches (planning_extracted_id)
       WHERE bom_confirmed_at IS NULL`,
    );
    return { ok: true };
  } catch (e) {
    console.warn(
      '[schema-patch] ensurePlanningBatchBomConfirmedColumn failed:',
      e && e.message ? e.message : e,
    );
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { ensurePlanningBatchBomConfirmedColumn };

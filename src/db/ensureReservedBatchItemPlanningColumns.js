/**
 * Idempotent schema patch: add the columns that let a reservation be tied to ONE specific
 * planning batch (not just the whole planning-extracted row), and mark manual reservations.
 *
 *   reserved_batch_items.planning_batch_id  FK -> planning_batches(id) ON DELETE CASCADE
 *   reserved_batch_items.is_manual          BOOLEAN DEFAULT false
 *
 * `planning_batch_id` powers the Planning "Batches" RM/PM Status popup reserve/un-reserve
 * (per-batch, mirroring Production's per-production_batch reservation). `is_manual` lets the
 * automatic PI-level rebuild (refreshReservationsFromPlanningBatches) leave user-made
 * reservations alone ("manual wins").
 *
 * Uses ADD COLUMN IF NOT EXISTS + a guarded FK/index add, so a re-run is a no-op. Ships as a
 * merge-time patch that applies on boot to every environment (local == live image).
 */
const db = require('../../db');

let ran = false;

async function ensureReservedBatchItemPlanningColumns() {
  if (ran) return { ok: true, skipped: true };
  ran = true;
  try {
    // Columns (nullable / defaulted → safe on a populated table).
    await db.query(
      `ALTER TABLE reserved_batch_items
         ADD COLUMN IF NOT EXISTS planning_batch_id INTEGER,
         ADD COLUMN IF NOT EXISTS is_manual BOOLEAN DEFAULT false`,
    );
    // FK (guarded — Postgres has no ADD CONSTRAINT IF NOT EXISTS).
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'reserved_batch_items_planning_batch_id_fkey'
        ) THEN
          ALTER TABLE reserved_batch_items
            ADD CONSTRAINT reserved_batch_items_planning_batch_id_fkey
            FOREIGN KEY (planning_batch_id) REFERENCES planning_batches(id) ON DELETE CASCADE;
        END IF;
      END $$;`);
    await db.query(
      `CREATE INDEX IF NOT EXISTS reserved_batch_items_planning_batch_id_idx
         ON reserved_batch_items (planning_batch_id)`,
    );
    return { ok: true };
  } catch (e) {
    console.warn(
      '[schema-patch] ensureReservedBatchItemPlanningColumns failed:',
      e && e.message ? e.message : e,
    );
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { ensureReservedBatchItemPlanningColumns };

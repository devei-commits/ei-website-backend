/**
 * Idempotent schema patch: add the column that lets a reservation be made BEFORE the stock
 * physically exists ("reserve now, allocate on arrival").
 *
 *   reserved_batch_items.quantity_requested  NUMERIC(28,16)
 *
 * Split of meaning:
 *   quantity_requested — what the batch actually needs (the full demand the user reserved for).
 *   quantity_reserved  — the portion of that demand currently BACKED BY STOCK in the facility.
 *   pending            — quantity_requested − quantity_reserved (awaiting arrival).
 *
 * Keeping `quantity_reserved` stock-backed is what makes this safe: every existing consumer
 * (warehouse_inventory.reserved sync, `available = SIH − reserved`, coverage maths) keeps working
 * untouched and never goes negative. The pending part lives only in the gap between the two
 * columns, and `src/lib/pendingReservationAllocator.js` closes that gap FIFO as stock lands.
 *
 * Backfill sets quantity_requested = quantity_reserved for pre-existing rows, so nothing that was
 * reserved before this patch is suddenly reported as pending.
 *
 * Uses ADD COLUMN IF NOT EXISTS, so a re-run is a no-op. Ships as a merge-time patch that applies
 * on boot to every environment (local == live image).
 */
const db = require('../../db');

let ran = false;

async function ensureReservedBatchItemRequestedColumn() {
  if (ran) return { ok: true, skipped: true };
  ran = true;
  try {
    await db.query(
      `ALTER TABLE reserved_batch_items
         ADD COLUMN IF NOT EXISTS quantity_requested NUMERIC(28,16)`,
    );
    // Pre-existing rows were fully stock-backed by definition (the old code refused to reserve
    // otherwise), so requested == reserved for them → zero pending.
    await db.query(
      `UPDATE reserved_batch_items
          SET quantity_requested = quantity_reserved
        WHERE quantity_requested IS NULL`,
    );
    // Partial index: the allocator only ever scans rows that still have something pending.
    await db.query(
      `CREATE INDEX IF NOT EXISTS reserved_batch_items_pending_idx
         ON reserved_batch_items (raw_material_id, pack_material_id)
       WHERE quantity_requested > quantity_reserved`,
    );
    return { ok: true };
  } catch (e) {
    console.warn(
      '[schema-patch] ensureReservedBatchItemRequestedColumn failed:',
      e && e.message ? e.message : e,
    );
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { ensureReservedBatchItemRequestedColumn };

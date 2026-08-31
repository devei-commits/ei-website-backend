/**
 * Idempotent schema patch: create the single-row-per-prefix atomic counter table backing
 * system-generated Vendor Batch Nos (format B126-#####) in the GRN "Batch Details" step.
 *
 *   vendor_batch_sequences.prefix       VARCHAR(20) UNIQUE  — e.g. 'B126'
 *   vendor_batch_sequences.last_value   INTEGER             — last number handed out
 *
 * See allocateNextVendorBatchNos in src/grn/controller.js — a Postgres advisory lock plus
 * this row is how concurrent GRN creations never get handed the same number.
 *
 * Uses CREATE TABLE IF NOT EXISTS, so a re-run is a no-op. Ships as a merge-time patch that
 * applies on boot to every environment (local == live image) — schema is patch-driven now,
 * there is no db.sync({ alter: true }).
 */
const db = require('../../db');

let ran = false;

async function ensureVendorBatchSequenceTable() {
  if (ran) return { ok: true, skipped: true };
  ran = true;
  try {
    await db.query(
      `CREATE TABLE IF NOT EXISTS vendor_batch_sequences (
         id SERIAL PRIMARY KEY,
         prefix VARCHAR(20) NOT NULL UNIQUE,
         last_value INTEGER NOT NULL DEFAULT 0,
         created_at TIMESTAMP WITH TIME ZONE,
         updated_at TIMESTAMP WITH TIME ZONE
       )`,
    );
    return { ok: true };
  } catch (e) {
    console.warn(
      '[schema-patch] ensureVendorBatchSequenceTable failed:',
      e && e.message ? e.message : e,
    );
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { ensureVendorBatchSequenceTable };

/**
 * Idempotent schema patch: `goods_received_notes.mrn_id` links a GRN back to the source MRN
 * (material_request_notes) when it was auto-created from a completed transfer.
 *
 *   goods_received_notes.mrn_id  INTEGER  — see src/grn/transferGrnFromMrn.js
 *
 * The column was added to the Sequelize model (src/grn/models.js) after the switch away from
 * `sequelize.sync({ alter: true })`, so it never got created on the live DB — every insert/return
 * on goods_received_notes fails with `column "mrn_id" does not exist`. Uses ADD COLUMN IF NOT
 * EXISTS, so a re-run is a no-op. Ships as a merge-time patch that applies on boot to every
 * environment (local == live image) — see src/grn/models.js for the matching Sequelize attribute.
 */
const db = require('../../db');

let ran = false;

async function ensureGrnMrnIdColumn() {
  if (ran) return { ok: true, skipped: true };
  ran = true;
  try {
    await db.query(
      `ALTER TABLE goods_received_notes
         ADD COLUMN IF NOT EXISTS mrn_id INTEGER`,
    );
    return { ok: true };
  } catch (e) {
    console.warn(
      '[schema-patch] ensureGrnMrnIdColumn failed:',
      e && e.message ? e.message : e,
    );
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { ensureGrnMrnIdColumn };

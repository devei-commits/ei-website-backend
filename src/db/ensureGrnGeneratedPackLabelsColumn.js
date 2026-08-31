/**
 * Idempotent schema patch: persist the exact pack labels printed at GRN "Generate Labels" (step 5)
 * so a later reprint (the "Print pack labels" button, available from any step) always shows the
 * same QR + fields that were actually generated and stuck on the physical packs — never a
 * recomputation from source_documents.batches/packaging, which could have since been edited.
 *
 *   goods_received_notes.generated_pack_labels  JSON  — [{ packagingNo, qrPayload,
 *     qrImageDataUrl, fields: [{label, value}] }], written by POST /:id/pack-labels
 *
 * Uses ADD COLUMN IF NOT EXISTS, so a re-run is a no-op. Ships as a merge-time patch that applies
 * on boot to every environment (local == live image) — see src/grn/models.js for the matching
 * Sequelize attribute.
 */
const db = require('../../db');

let ran = false;

async function ensureGrnGeneratedPackLabelsColumn() {
  if (ran) return { ok: true, skipped: true };
  ran = true;
  try {
    await db.query(
      `ALTER TABLE goods_received_notes
         ADD COLUMN IF NOT EXISTS generated_pack_labels JSON`,
    );
    return { ok: true };
  } catch (e) {
    console.warn(
      '[schema-patch] ensureGrnGeneratedPackLabelsColumn failed:',
      e && e.message ? e.message : e,
    );
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { ensureGrnGeneratedPackLabelsColumn };

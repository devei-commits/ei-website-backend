'use strict';

const db = require('../../db');

/**
 * Idempotently ensure the newer `production_batches` columns exist.
 *
 * Dev auto-adds these via db.sync({ alter: true }), but managed production SKIPS sync — so without
 * this, reads/writes that reference production_batches.priority / need_by_note (Edit Batch modal)
 * fail with Postgres 42703. A boot-time `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` converges dev and
 * prod with no manual migration. Fully idempotent and safe to run every boot.
 *
 * Types mirror src/production/models.js (STRING(10) → VARCHAR(10), TEXT → TEXT).
 */
async function ensureProductionBatchColumns() {
  try {
    await db.query(`
      ALTER TABLE production_batches
        ADD COLUMN IF NOT EXISTS priority            VARCHAR(10) NOT NULL DEFAULT 'MEDIUM',
        ADD COLUMN IF NOT EXISTS need_by_note        TEXT,
        ADD COLUMN IF NOT EXISTS bmr_qa_status       VARCHAR(20) NOT NULL DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS bmr_qa_approved_by  VARCHAR(120),
        ADD COLUMN IF NOT EXISTS bmr_qa_reviewed_at  TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS bpr_qa_status       VARCHAR(20) NOT NULL DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS bpr_qa_approved_by  VARCHAR(120),
        ADD COLUMN IF NOT EXISTS bpr_qa_reviewed_at  TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS pre_production_gate JSONB;
    `);
    return { ensured: true };
  } catch (err) {
    // Never block boot on this — Edit Batch degrades until the columns are present.
    console.warn('[production] ensureProductionBatchColumns failed:', err && err.message ? err.message : err);
    return { ensured: false };
  }
}

module.exports = { ensureProductionBatchColumns };

'use strict';

const db = require('../../db');

/**
 * Idempotently ensure the newer Procurement Request columns exist on `procurement_requests`.
 *
 * Dev auto-adds these via db.sync({ alter: true }), but managed production SKIPS sync — so without
 * this, listProcurementRequests and related reads fail with Postgres 42703
 * ("column ProcurementRequest.source does not exist"). A boot-time
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (like ensureLeadTimeStatsTable) converges dev and prod
 * with no manual migration. Fully idempotent and safe to run every boot.
 *
 * Columns + types mirror src/procurementRequests/models.js (STRING(n) → VARCHAR(n), TEXT → TEXT,
 * DATEONLY → DATE). Only additive, nullable feature columns are ensured here.
 */
async function ensureProcurementRequestColumns() {
  try {
    await db.query(`
      ALTER TABLE procurement_requests
        ADD COLUMN IF NOT EXISTS source                  VARCHAR(20) DEFAULT 'planning',
        ADD COLUMN IF NOT EXISTS planning_batch_id       INTEGER,
        ADD COLUMN IF NOT EXISTS preferred_vendor        VARCHAR(300),
        ADD COLUMN IF NOT EXISTS requested_by            VARCHAR(200),
        ADD COLUMN IF NOT EXISTS stock_check_assigned_to VARCHAR(200),
        ADD COLUMN IF NOT EXISTS stock_check_status      VARCHAR(50),
        ADD COLUMN IF NOT EXISTS stock_check_due_date    DATE,
        ADD COLUMN IF NOT EXISTS stock_check_notes       TEXT;
    `);
    return { ensured: true };
  } catch (err) {
    // Never block boot on this — reads degrade until the columns are present.
    console.warn('[proc-request] ensureProcurementRequestColumns failed:', err && err.message ? err.message : err);
    return { ensured: false };
  }
}

module.exports = { ensureProcurementRequestColumns };

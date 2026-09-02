'use strict';

const db = require('../../db');

/**
 * Idempotently ensure the Request-Quotation columns exist on `planning_quotation_asks` and that the
 * planning link is nullable (a quotation can now be requested from Procurement with no planning line).
 *
 * Dev auto-adds these via db.sync({ alter: true }); managed production SKIPS sync, so without this the
 * shared Request Quotation form would 42703 on `moq_bands` / `expected_required_date` / `source`, or
 * 23502 (NOT NULL) on a Procurement-origin request. Fully idempotent; safe to run every boot.
 */
async function ensureQuotationAskColumns() {
  try {
    // Only touch it if the table exists (it may not on a very old prod).
    const [tbl] = await db.query("SELECT to_regclass('public.planning_quotation_asks') AS t");
    if (!tbl || !tbl[0] || !tbl[0].t) return { ensured: false };
    await db.query(`
      ALTER TABLE planning_quotation_asks
        ADD COLUMN IF NOT EXISTS source                 VARCHAR(20) DEFAULT 'planning',
        ADD COLUMN IF NOT EXISTS moq_bands              JSON,
        ADD COLUMN IF NOT EXISTS expected_required_date DATE;
    `);
    await db.query('ALTER TABLE planning_quotation_asks ALTER COLUMN planning_extracted_id DROP NOT NULL;');
    return { ensured: true };
  } catch (err) {
    console.warn('[quotation-asks] ensureQuotationAskColumns failed:', err && err.message ? err.message : err);
    return { ensured: false };
  }
}

module.exports = { ensureQuotationAskColumns };

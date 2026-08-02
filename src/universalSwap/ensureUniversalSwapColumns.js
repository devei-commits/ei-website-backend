'use strict';

const db = require('../../db');

/**
 * Idempotently ensure the `status` column exists on `universal_swap_history` (draft | applied).
 * Dev auto-adds it via db.sync({ alter: true }); managed prod SKIPS sync, so without this a draft/finalize
 * write fails with Postgres 42703. Existing rows default to 'applied' (they were applied on create).
 */
async function ensureUniversalSwapColumns() {
  try {
    await db.query(`
      ALTER TABLE universal_swap_history
        ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'applied';
    `);
    return { ensured: true };
  } catch (err) {
    console.warn('[universal-swap] ensureUniversalSwapColumns failed:', err && err.message ? err.message : err);
    return { ensured: false };
  }
}

module.exports = { ensureUniversalSwapColumns };

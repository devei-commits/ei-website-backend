'use strict';

const db = require('../../db');

/**
 * Idempotently ensure the `is_kit` column exists on `boms`.
 *
 * Dev auto-adds this via db.sync({ alter: true }), but managed production SKIPS sync — so without
 * this, reads/writes that reference boms.is_kit (kit BOM expansion in Items Involved, product
 * save/detail) fail with Postgres 42703 ("column BOM.is_kit does not exist"). A boot-time
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` converges dev and prod with no manual migration.
 * Fully idempotent and safe to run every boot.
 *
 * Type mirrors src/bom/models.js (BOOLEAN NOT NULL DEFAULT false).
 */
async function ensureBomIsKitColumn() {
  try {
    await db.query(`
      ALTER TABLE boms
        ADD COLUMN IF NOT EXISTS is_kit BOOLEAN NOT NULL DEFAULT false;
    `);
    return { ensured: true };
  } catch (err) {
    // Never block boot on this — kit reads degrade until the column is present.
    console.warn('[bom] ensureBomIsKitColumn failed:', err && err.message ? err.message : err);
    return { ensured: false };
  }
}

module.exports = { ensureBomIsKitColumn };

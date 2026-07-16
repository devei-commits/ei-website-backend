'use strict';

const db = require('../../db');

/**
 * Idempotently ensure the `lead_time_stats` cache table (spec §10.4) exists.
 *
 * Dev auto-creates it via db.sync({ alter: true }), but managed production SKIPS sync — so without
 * this the table is missing there and the actual-from-history lead-time engine has nowhere to write.
 * Running a `CREATE TABLE IF NOT EXISTS` on boot (like ensureTreasuryDefaults / *Presets) makes dev
 * and prod converge with no manual migration. Fully idempotent and safe to run every boot.
 *
 * Column set mirrors src/leadTime/leadTimeStatModel.js. Uniqueness is on `item_key`
 * (`${item_type}:${itemId}:${vendor}`) so LeadTimeStat.upsert has a conflict target.
 */
async function ensureLeadTimeStatsTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS lead_time_stats (
        id               SERIAL PRIMARY KEY,
        item_key         VARCHAR(320) NOT NULL UNIQUE,
        item_type        VARCHAR(4)   NOT NULL,
        raw_material_id  INTEGER,
        pack_material_id INTEGER,
        vendor_name      VARCHAR(300),
        avg_actual_days  NUMERIC(10,2),
        p50              NUMERIC(10,2),
        p90              NUMERIC(10,2),
        trend_pct        NUMERIC(10,2) DEFAULT 0,
        trend_up         BOOLEAN       DEFAULT FALSE,
        sample_size      INTEGER       DEFAULT 0,
        source           VARCHAR(20),
        computed_at      TIMESTAMPTZ,
        created_at       TIMESTAMPTZ,
        updated_at       TIMESTAMPTZ,
        deleted_at       TIMESTAMPTZ,
        lifecycle_status VARCHAR(255) DEFAULT 'active'
      );
    `);
    // Belt-and-braces: if an older table exists without the unique constraint, add a unique index.
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS lead_time_stats_item_key_uq ON lead_time_stats (item_key);
    `);
    return { ensured: true };
  } catch (err) {
    // Never block boot on this — the engine degrades gracefully when the table is absent.
    console.warn('[lead-time] ensureLeadTimeStatsTable failed:', err && err.message ? err.message : err);
    return { ensured: false };
  }
}

module.exports = { ensureLeadTimeStatsTable };

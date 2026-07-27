'use strict';

const db = require('../../db');

/**
 * Idempotently ensure the `warehouse_packs` pack-inventory table exists.
 *
 * Dev auto-creates it via db.sync({ alter: true }); managed production SKIPS sync, so this
 * CREATE TABLE IF NOT EXISTS on boot keeps them converged with no manual migration.
 * Column set mirrors src/warehousePacks/models.js.
 */
async function ensureWarehousePacksTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS warehouse_packs (
        id               SERIAL PRIMARY KEY,
        packaging_no     VARCHAR(160) NOT NULL UNIQUE,
        grn_id           INTEGER,
        batch_index      INTEGER,
        item_type        VARCHAR(4),
        raw_material_id  INTEGER,
        pack_material_id INTEGER,
        product_id       INTEGER,
        zone             VARCHAR(200),
        rack             VARCHAR(200),
        vendor_batch     VARCHAR(160),
        mfg_date         DATE,
        exp_date         DATE,
        qty              NUMERIC(28,16) DEFAULT 0,
        unit             VARCHAR(20) DEFAULT 'KG',
        status           VARCHAR(20) DEFAULT 'available',
        parent_pack_id   INTEGER,
        mrn_id           INTEGER,
        created_at       TIMESTAMPTZ,
        updated_at       TIMESTAMPTZ,
        deleted_at       TIMESTAMPTZ,
        lifecycle_status VARCHAR(255) DEFAULT 'active'
      );
    `);
    await db.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS warehouse_packs_packaging_no_uq ON warehouse_packs (packaging_no);'
    );
    // Availability lookups filter by item + status and FEFO-sort by expiry.
    await db.query(
      'CREATE INDEX IF NOT EXISTS warehouse_packs_avail_idx ON warehouse_packs (status, raw_material_id, pack_material_id, product_id);'
    );
    return { ensured: true };
  } catch (err) {
    console.warn('[warehouse-packs] ensureWarehousePacksTable failed:', err && err.message ? err.message : err);
    return { ensured: false };
  }
}

module.exports = { ensureWarehousePacksTable };

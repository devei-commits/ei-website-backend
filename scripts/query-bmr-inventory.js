#!/usr/bin/env node
/**
 * One-off diagnostic: BMR-2026-001 + RM codes 1000002 / 1000612
 * Usage: node scripts/query-bmr-inventory.js
 */
require('dotenv').config();
const { Sequelize } = require('sequelize');

const BMR = process.argv[2] || 'BMR-2026-001';
const CODES = (process.argv[3] || '1000002,1000612').split(',').map((c) => c.trim());

async function main() {
  const s = new Sequelize(process.env.DATABASE_URL, { logging: false });
  const codesSql = CODES.map((c) => `'${c.replace(/'/g, "''")}'`).join(',');

  const [rmRows] = await s.query(
    `SELECT id, code, name FROM raw_materials WHERE code IN (${codesSql}) ORDER BY code`
  );
  const [pbRows] = await s.query(
    `SELECT id, bmr_no, bmr_status, rm_reserved, dispensing_rm FROM production_batches WHERE bmr_no = :bmr LIMIT 1`,
    { replacements: { bmr: BMR } }
  );
  const [pbAny] = await s.query(
    `SELECT id, bmr_no, bmr_status, rm_reserved FROM production_batches ORDER BY id DESC LIMIT 5`
  );
  let rbi = [];
  let wh = [];
  let hist = [];
  const pb = pbRows;
  if (pb && pb.length) {
    const batchId = pb[0].id;
    [rbi] = await s.query(
      `SELECT rbi.id, rbi.production_batch_id, rbi.raw_material_id, rm.code,
              rbi.quantity_reserved, rbi.unit
       FROM reserved_batch_items rbi
       LEFT JOIN raw_materials rm ON rm.id = rbi.raw_material_id
       WHERE rbi.production_batch_id = :batchId`,
      { replacements: { batchId } }
    );
    [[wh]] = await s.query(
      `SELECT wi.id, rm.code, wi.wh_stock, wi.ml1_stock, wi.ml2_stock,
              wi.stock_in_hand, wi.reserved
       FROM warehouse_inventory wi
       JOIN raw_materials rm ON rm.id = wi.raw_material_id
       WHERE rm.code IN (${codesSql}) AND wi.item_type = 'RM'`
    );
    [[hist]] = await s.query(
      `SELECT h.action_type, h.reserved_delta, h.reserved_after, h.qty_delta,
              h.moved_at, h.batch_no
       FROM warehouse_inventory_location_history h
       JOIN warehouse_inventory wi ON wi.id = h.warehouse_inventory_id
       JOIN raw_materials rm ON rm.id = wi.raw_material_id
       WHERE rm.code IN (${codesSql}) AND (h.batch_no = :bmr OR h.action_type LIKE '%RESERV%' OR h.action_type LIKE '%DISPENS%')
       ORDER BY h.moved_at DESC LIMIT 15`,
      { replacements: { bmr: BMR } }
    );
  }

  const [whAll] = await s.query(
    `SELECT wi.id, rm.code, wi.wh_stock, wi.ml1_stock, wi.ml2_stock,
            wi.stock_in_hand, wi.reserved
     FROM warehouse_inventory wi
     JOIN raw_materials rm ON rm.id = wi.raw_material_id
     WHERE rm.code IN (${codesSql}) AND wi.item_type = 'RM'`
  );

  const [rbiSums] = await s.query(
    `SELECT rm.code, SUM(rbi.quantity_reserved)::text AS total_rbi
     FROM reserved_batch_items rbi
     JOIN raw_materials rm ON rm.id = rbi.raw_material_id
     WHERE rm.code IN (${codesSql}) AND rbi.production_batch_id IS NOT NULL
     GROUP BY rm.code`
  );

  const [dupWh] = await s.query(
    `SELECT raw_material_id, COUNT(*)::int AS cnt
     FROM warehouse_inventory
     WHERE item_type = 'RM' AND raw_material_id IN (2969, 3411)
     GROUP BY raw_material_id`
  );

  const out = {
    bmr: BMR,
    raw_materials: rmRows || [],
    recent_production_batches: pbAny || [],
    production_batch: pb && pb[0] ? pb[0] : null,
    reserved_batch_items: rbi || [],
    reserved_batch_items_sum_by_code: rbiSums || [],
    warehouse_inventory: whAll || wh || [],
    recent_history: hist || [],
    duplicate_wh_rows: dupWh || [],
  };

  const [mrns] = await s.query(
    `SELECT id, mrn_no, status, source, bmr_no, line_items::text
     FROM material_request_notes
     WHERE bmr_no = :bmr AND source = 'MTR'
     ORDER BY id`,
    { replacements: { bmr: BMR } }
  );
  out.mtrs_for_bmr = mrns || [];

  const [histAll] = await s.query(
    `SELECT h.action_type, rm.code, h.reserved_delta, h.reserved_after, h.qty_delta, h.moved_at
     FROM warehouse_inventory_location_history h
     JOIN warehouse_inventory wi ON wi.id = h.warehouse_inventory_id
     JOIN raw_materials rm ON rm.id = wi.raw_material_id
     WHERE rm.code IN (${codesSql})
     ORDER BY h.moved_at DESC LIMIT 25`
  );
  out.recent_history_all = histAll || [];
  console.log(JSON.stringify(out, null, 2));
  await s.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

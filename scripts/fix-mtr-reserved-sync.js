#!/usr/bin/env node
/** One-off: align reserved_batch_items + warehouse_inventory after completed outbound MTR. */
require('dotenv').config();
const { Sequelize } = require('sequelize');
const { syncWarehouseReserved } = require('../src/planningExtracted/controller');

const BMR = process.argv[2] || 'BMR-2026-001';

async function main() {
  const s = new Sequelize(process.env.DATABASE_URL, { logging: false });
  const [[batch]] = await s.query(
    `SELECT id FROM production_batches WHERE bmr_no = :bmr LIMIT 1`,
    { replacements: { bmr: BMR } }
  );
  if (!batch) {
    console.log('No batch for', BMR);
    await s.close();
    return;
  }
  const [mrns] = await s.query(
    `SELECT line_items FROM material_request_notes
     WHERE bmr_no = :bmr AND source = 'MTR' AND COALESCE(is_inbound_from_mu, false) = false
       AND status IN ('Completed', 'Succeeded')`,
    { replacements: { bmr: BMR } }
  );
  const moved = new Map();
  for (const row of mrns) {
    const lines = Array.isArray(row.line_items) ? row.line_items : [];
    for (const li of lines) {
      const qty = Number(li.quantity) || 0;
      if (qty <= 0) continue;
      const key = li.raw_material_id != null ? `rm:${li.raw_material_id}` : li.pack_material_id != null ? `pm:${li.pack_material_id}` : null;
      if (!key) continue;
      moved.set(key, (moved.get(key) || 0) + qty);
    }
  }
  const rmIds = [];
  const pmIds = [];
  for (const [key, qty] of moved) {
    const [kind, idStr] = key.split(':');
    const id = Number(idStr);
    const col = kind === 'rm' ? 'raw_material_id' : 'pack_material_id';
    const otherCol = kind === 'rm' ? 'pack_material_id' : 'raw_material_id';
    await s.query(
      `UPDATE reserved_batch_items
       SET quantity_reserved = GREATEST(0, quantity_reserved - :qty)
       WHERE production_batch_id = :batchId AND ${col} = :id AND ${otherCol} IS NULL`,
      { replacements: { qty, batchId: batch.id, id } }
    );
    if (kind === 'rm') rmIds.push(id);
    else pmIds.push(id);
  }
  await syncWarehouseReserved(rmIds, pmIds);
  const [out] = await s.query(
    `SELECT rm.code, rbi.quantity_reserved, wi.reserved, wi.wh_stock, wi.ml1_stock, wi.stock_in_hand
     FROM raw_materials rm
     LEFT JOIN reserved_batch_items rbi ON rbi.raw_material_id = rm.id AND rbi.production_batch_id = :batchId
     LEFT JOIN warehouse_inventory wi ON wi.raw_material_id = rm.id AND wi.item_type = 'RM'
     WHERE rm.code IN ('1000002','1000612')`,
    { replacements: { batchId: batch.id } }
  );
  console.log(JSON.stringify({ bmr: BMR, moved: Object.fromEntries(moved), after: out }, null, 2));
  await s.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

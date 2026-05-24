#!/usr/bin/env node
require('dotenv').config();
const { Sequelize } = require('sequelize');
const SO = process.argv[2] || 'EI-SO-2026-002';

async function main() {
  const s = new Sequelize(process.env.DATABASE_URL, { logging: false });
  const [pb] = await s.query(
    `SELECT id, bmr_no, bmr_status, bpr_status, rm_reserved, pm_reserved, planning_batch_id
     FROM production_batches WHERE so_no = :so`,
    { replacements: { so: SO } }
  );
  const prodIds = pb.map((r) => r.id);
  let rbi = [];
  if (prodIds.length) {
    [rbi] = await s.query(
      `SELECT rbi.production_batch_id, rbi.quantity_reserved,
              rm.code AS rm_code, pm.code AS pm_code
       FROM reserved_batch_items rbi
       LEFT JOIN raw_materials rm ON rm.id = rbi.raw_material_id
       LEFT JOIN pack_materials pm ON pm.id = rbi.pack_material_id
       WHERE rbi.production_batch_id IN (:ids)`,
      { replacements: { ids: prodIds } }
    );
  }
  console.log(JSON.stringify({ so: SO, production_batches: pb, reserved_batch_items: rbi }, null, 2));
  await s.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

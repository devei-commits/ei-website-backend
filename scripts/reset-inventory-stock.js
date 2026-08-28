/**
 * Reset WH/ML1/ML2/SIH warehouse inventory stock to zero — every RM/PM/PR item, across the
 * whole system. Reserved and in-transit quantities are deliberately left untouched (they track
 * live commitments/shipments, not physical stock on hand).
 *
 * What it does:
 *   1. Snapshots every warehouse_inventory row + every active warehouse_rack_items row to
 *      backups/pre_inventory_reset_<ts>.json before writing anything.
 *   2. Zeroes wh_stock, ml1_stock, ml2_stock, stock_in_hand and clears zone/rack display text
 *      on every warehouse_inventory row. Does NOT touch reserved or in_transit.
 *   3. Soft-deletes every active warehouse_rack_items row (warehouse AND production zones) —
 *      these back wh_stock/ml1_stock/ml2_stock, so they must go too or the app's own
 *      recalculation would just re-derive the old totals from them on the next inventory write.
 *   4. Verifies the result (wh/ml1/ml2/sih all zero, zero active rack items) before reporting done.
 *
 * What it does NOT touch: reserved, in_transit, PO quantities, RM/PM/PR master records,
 * warehouse zones/racks themselves, GRN/PO/production history, batch_number/expiry_date/
 * qc_status text fields.
 *
 * Safe by default: running with no flags only audits and reports what WOULD change — no writes.
 * Pass --apply --yes to actually perform the reset.
 *
 * Usage (from inside orders_app, so DATABASE_URL/DB_SSL env overrides reach the right DB):
 *   node scripts/reset-inventory-stock.js                # dry run / audit only
 *   node scripts/reset-inventory-stock.js --apply --yes   # actually reset
 */
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { QueryTypes } = require('sequelize');
const WarehouseInventory = require('../src/warehouseInventory/models');
const { WarehouseRackItem } = require('../src/warehouseLocations/models');
const { softDeleteWhere, activeRowWhere } = require('../src/lib/softDelete');

const APPLY = process.argv.includes('--apply');
const YES = process.argv.includes('--yes');

function toNum(x) {
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

async function main() {
  console.log('[reset-inventory] Connecting…');
  await db.authenticate();
  console.log('[reset-inventory] Connected.');

  const invRows = await WarehouseInventory.findAll({ where: activeRowWhere() });
  const invPlain = invRows.map((r) => (r.get ? r.get({ plain: true }) : r));
  if (invPlain.length === 0) {
    console.error('[reset-inventory] ABORT — 0 active warehouse_inventory rows found. This does not look like a populated system; refusing to proceed (wrong DB?).');
    process.exit(1);
  }

  const byType = { RM: 0, PM: 0, PR: 0, other: 0 };
  let sumWh = 0, sumMl1 = 0, sumMl2 = 0, sumSih = 0, sumReserved = 0, sumInTransit = 0;
  for (const r of invPlain) {
    byType[r.item_type] != null ? (byType[r.item_type] += 1) : (byType.other += 1);
    sumWh += toNum(r.wh_stock);
    sumMl1 += toNum(r.ml1_stock);
    sumMl2 += toNum(r.ml2_stock);
    sumSih += toNum(r.stock_in_hand);
    sumReserved += toNum(r.reserved);
    sumInTransit += toNum(r.in_transit);
  }
  const rackItemCount = await WarehouseRackItem.count({ where: activeRowWhere() });

  console.log(`[reset-inventory] Active warehouse_inventory rows: ${invPlain.length} (RM=${byType.RM}, PM=${byType.PM}, PR=${byType.PR}${byType.other ? `, other=${byType.other}` : ''})`);
  console.log(`[reset-inventory] Current totals — wh_stock=${sumWh}, ml1_stock=${sumMl1}, ml2_stock=${sumMl2}, stock_in_hand=${sumSih}  ← will be zeroed`);
  console.log(`[reset-inventory] Current totals — reserved=${sumReserved}, in_transit=${sumInTransit}  ← left untouched`);
  console.log(`[reset-inventory] Active warehouse_rack_items rows to remove: ${rackItemCount}`);

  if (!APPLY || !YES) {
    console.log('\n[reset-inventory] DRY RUN — no changes made. Re-run with --apply --yes to actually reset.');
    process.exit(0);
  }

  // ── Snapshot before any write ──
  const rackItemRows = await WarehouseRackItem.findAll({ where: activeRowWhere() });
  const rackItemsPlain = rackItemRows.map((r) => (r.get ? r.get({ plain: true }) : r));
  const snapshot = { takenAt: new Date().toISOString(), warehouseInventory: invPlain, warehouseRackItems: rackItemsPlain };
  const backupsDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const snapPath = path.join(backupsDir, `pre_inventory_reset_${Date.now()}.json`);
  fs.writeFileSync(snapPath, JSON.stringify(snapshot, null, 2));
  console.log(`[reset-inventory] Snapshot written: ${snapPath} (${invPlain.length} inventory rows, ${rackItemsPlain.length} rack-item rows)`);

  await db.transaction(async (transaction) => {
    console.log('[reset-inventory] Zeroing wh_stock / ml1_stock / ml2_stock / stock_in_hand (reserved and in_transit left as-is)…');
    const [, updateResult] = await db.query(
      `UPDATE warehouse_inventory
       SET wh_stock = 0, ml1_stock = 0, ml2_stock = 0, stock_in_hand = 0,
           zone = NULL, rack = NULL, updated_at = NOW()
       WHERE deleted_at IS NULL AND lifecycle_status = 'active'`,
      { transaction }
    );
    console.log(`[reset-inventory] Updated ${updateResult.rowCount ?? 'N/A'} warehouse_inventory rows.`);

    console.log('[reset-inventory] Removing all rack-item stock assignments…');
    const removed = await softDeleteWhere(WarehouseRackItem, {}, { transaction });
    console.log(`[reset-inventory] Soft-deleted ${removed} warehouse_rack_items rows.`);
  });

  // ── Verify ──
  const postSum = await db.query(
    `SELECT COALESCE(SUM(wh_stock),0) AS wh, COALESCE(SUM(ml1_stock),0) AS ml1, COALESCE(SUM(ml2_stock),0) AS ml2,
            COALESCE(SUM(stock_in_hand),0) AS sih, COALESCE(SUM(reserved),0) AS reserved, COALESCE(SUM(in_transit),0) AS it
     FROM warehouse_inventory WHERE deleted_at IS NULL AND lifecycle_status = 'active'`,
    { type: QueryTypes.SELECT }
  );
  const postRackCount = await WarehouseRackItem.count({ where: activeRowWhere() });
  console.log('\n[reset-inventory] DONE. Post-reset totals:', JSON.stringify(postSum[0]));
  console.log(`[reset-inventory] Active warehouse_rack_items remaining: ${postRackCount}`);
  const targetFieldsZero = ['wh', 'ml1', 'ml2', 'sih'].every((k) => toNum(postSum[0][k]) === 0);
  if (!targetFieldsZero || postRackCount !== 0) {
    console.error('[reset-inventory] WARNING — wh_stock/ml1_stock/ml2_stock/stock_in_hand did not fully zero out. Investigate before trusting this result.');
    process.exit(1);
  }
  console.log('[reset-inventory] wh_stock/ml1_stock/ml2_stock/stock_in_hand confirmed zero, all rack items removed. reserved/in_transit left unchanged as requested.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[reset-inventory] FAILED:', err);
  process.exit(1);
});

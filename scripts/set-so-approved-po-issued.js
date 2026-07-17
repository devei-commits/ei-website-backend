#!/usr/bin/env node
/**
 * Bulk-set order statuses:
 *   - all sales_orders    → status = 'Approved'
 *   - all purchase_orders → status = 'Released'   (the DB value the UI renders as "Issued")
 *
 * Only active (deleted_at IS NULL) rows are touched, and only those not already at the target
 * (so counts are meaningful and the run is idempotent). All changes are in ONE transaction.
 *
 * NOTE: this sets the `status` column directly. It does NOT run the normal release/approve
 * workflow side effects (e.g. po_released_at, procurement-request sync, approval history).
 * It's intended for data setup / demo, not to simulate the real approve/release actions.
 *
 * Usage:
 *   node scripts/set-so-approved-po-issued.js            # DRY RUN (default) — shows counts, writes nothing
 *   node scripts/set-so-approved-po-issued.js --commit   # apply the changes
 */
require('dotenv').config();

const db = require('../db');

const SO_TARGET = 'Approved';
const PO_TARGET = 'Released'; // shown as "Issued" in the UI

const COMMIT = process.argv.includes('--commit');

async function countByStatus(table) {
  const [rows] = await db.query(
    `SELECT status, COUNT(*)::int AS n FROM ${table} WHERE deleted_at IS NULL GROUP BY status ORDER BY n DESC`
  );
  return rows;
}

async function main() {
  await db.authenticate();
  console.log(`Mode: ${COMMIT ? 'COMMIT (writing to DB)' : 'DRY RUN (no writes)'}\n`);

  console.log('BEFORE — sales_orders:', JSON.stringify(await countByStatus('sales_orders')));
  console.log('BEFORE — purchase_orders:', JSON.stringify(await countByStatus('purchase_orders')));

  // How many would change (active rows not already at target)
  const [[soPending]] = await db.query(
    `SELECT COUNT(*)::int AS n FROM sales_orders WHERE deleted_at IS NULL AND (status IS DISTINCT FROM :t)`,
    { replacements: { t: SO_TARGET } }
  );
  const [[poPending]] = await db.query(
    `SELECT COUNT(*)::int AS n FROM purchase_orders WHERE deleted_at IS NULL AND (status IS DISTINCT FROM :t)`,
    { replacements: { t: PO_TARGET } }
  );
  console.log(`\nWill update: ${soPending.n} sales_orders → '${SO_TARGET}', ${poPending.n} purchase_orders → '${PO_TARGET}'`);

  if (!COMMIT) {
    console.log('\nDRY RUN — nothing written. Re-run with --commit to apply.');
    await db.close();
    return;
  }

  const tx = await db.transaction();
  try {
    const [, soMeta] = await db.query(
      `UPDATE sales_orders SET status = :t, updated_at = NOW() WHERE deleted_at IS NULL AND (status IS DISTINCT FROM :t)`,
      { replacements: { t: SO_TARGET }, transaction: tx }
    );
    const [, poMeta] = await db.query(
      `UPDATE purchase_orders SET status = :t, updated_at = NOW() WHERE deleted_at IS NULL AND (status IS DISTINCT FROM :t)`,
      { replacements: { t: PO_TARGET }, transaction: tx }
    );
    await tx.commit();
    console.log(`\nCommitted. sales_orders updated: ${soMeta.rowCount}, purchase_orders updated: ${poMeta.rowCount}`);
  } catch (e) {
    await tx.rollback();
    console.error('\nRolled back due to error:', e && e.message ? e.message : e);
    process.exitCode = 1;
  }

  console.log('\nAFTER — sales_orders:', JSON.stringify(await countByStatus('sales_orders')));
  console.log('AFTER — purchase_orders:', JSON.stringify(await countByStatus('purchase_orders')));
  await db.close();
}

main().catch(async (e) => {
  console.error('FATAL:', e && e.message ? e.message : e);
  try { await db.close(); } catch (_) {}
  process.exit(1);
});

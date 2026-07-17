#!/usr/bin/env node
/**
 * Bulk-set order statuses:
 *   - all sales_orders        → status = 'Approved'   (except rows already 'Cancelled')
 *   - all purchase_orders     → status = 'Released'    (the DB value the UI renders as "Issued")
 *   - all fulfillment_orders  → commercial_status = 'approved'   (drives the "Approved" pill in the
 *                               Sale Orders / fulfillment view — CommercialBadge reads this column,
 *                               NOT sales_orders.status), EXCEPT rows already 'cancelled'.
 *
 * Only active (deleted_at IS NULL) rows are touched, and only those not already at the target
 * (so counts are meaningful and the run is idempotent). All changes are in ONE transaction.
 *
 * NOTE: this sets the columns directly. It does NOT run the normal release/approve workflow side
 * effects (e.g. po_released_at, procurement-request sync, approval history). Data setup / demo only.
 *
 * Usage:
 *   node scripts/set-so-approved-po-issued.js            # DRY RUN (default) — shows counts, writes nothing
 *   node scripts/set-so-approved-po-issued.js --commit   # apply the changes
 */
require('dotenv').config();

const db = require('../db');

const SO_TARGET = 'Approved';
const PO_TARGET = 'Released'; // shown as "Issued" in the UI
const FO_TARGET = 'approved'; // fulfillment_orders.commercial_status — shown as "Approved" pill

const COMMIT = process.argv.includes('--commit');

async function countByColumn(table, column) {
  const [rows] = await db.query(
    `SELECT ${column} AS v, COUNT(*)::int AS n FROM ${table} WHERE deleted_at IS NULL GROUP BY ${column} ORDER BY n DESC`
  );
  return rows;
}

async function main() {
  await db.authenticate();
  console.log(`Mode: ${COMMIT ? 'COMMIT (writing to DB)' : 'DRY RUN (no writes)'}\n`);

  console.log('BEFORE — sales_orders.status:', JSON.stringify(await countByColumn('sales_orders', 'status')));
  console.log('BEFORE — purchase_orders.status:', JSON.stringify(await countByColumn('purchase_orders', 'status')));
  console.log('BEFORE — fulfillment_orders.commercial_status:', JSON.stringify(await countByColumn('fulfillment_orders', 'commercial_status')));

  // How many would change (active rows not already at target)
  const [[soPending]] = await db.query(
    `SELECT COUNT(*)::int AS n FROM sales_orders
       WHERE deleted_at IS NULL
         AND (status IS DISTINCT FROM :t)
         AND (status IS DISTINCT FROM 'Cancelled')`,
    { replacements: { t: SO_TARGET } }
  );
  const [[poPending]] = await db.query(
    `SELECT COUNT(*)::int AS n FROM purchase_orders WHERE deleted_at IS NULL AND (status IS DISTINCT FROM :t)`,
    { replacements: { t: PO_TARGET } }
  );
  // fulfillment: skip already-approved AND never touch cancelled orders.
  const [[foPending]] = await db.query(
    `SELECT COUNT(*)::int AS n FROM fulfillment_orders
       WHERE deleted_at IS NULL
         AND (commercial_status IS DISTINCT FROM :t)
         AND (commercial_status IS DISTINCT FROM 'cancelled')`,
    { replacements: { t: FO_TARGET } }
  );
  console.log(
    `\nWill update: ${soPending.n} sales_orders → '${SO_TARGET}', ` +
    `${poPending.n} purchase_orders → '${PO_TARGET}', ` +
    `${foPending.n} fulfillment_orders → commercial_status '${FO_TARGET}' (cancelled left as-is)`
  );

  if (!COMMIT) {
    console.log('\nDRY RUN — nothing written. Re-run with --commit to apply.');
    await db.close();
    return;
  }

  const tx = await db.transaction();
  try {
    const [, soMeta] = await db.query(
      `UPDATE sales_orders SET status = :t, updated_at = NOW()
         WHERE deleted_at IS NULL
           AND (status IS DISTINCT FROM :t)
           AND (status IS DISTINCT FROM 'Cancelled')`,
      { replacements: { t: SO_TARGET }, transaction: tx }
    );
    const [, poMeta] = await db.query(
      `UPDATE purchase_orders SET status = :t, updated_at = NOW() WHERE deleted_at IS NULL AND (status IS DISTINCT FROM :t)`,
      { replacements: { t: PO_TARGET }, transaction: tx }
    );
    const [, foMeta] = await db.query(
      `UPDATE fulfillment_orders SET commercial_status = :t, updated_at = NOW()
         WHERE deleted_at IS NULL
           AND (commercial_status IS DISTINCT FROM :t)
           AND (commercial_status IS DISTINCT FROM 'cancelled')`,
      { replacements: { t: FO_TARGET }, transaction: tx }
    );
    await tx.commit();
    console.log(
      `\nCommitted. sales_orders updated: ${soMeta.rowCount}, ` +
      `purchase_orders updated: ${poMeta.rowCount}, ` +
      `fulfillment_orders updated: ${foMeta.rowCount}`
    );
  } catch (e) {
    await tx.rollback();
    console.error('\nRolled back due to error:', e && e.message ? e.message : e);
    process.exitCode = 1;
  }

  console.log('\nAFTER — sales_orders.status:', JSON.stringify(await countByColumn('sales_orders', 'status')));
  console.log('AFTER — purchase_orders.status:', JSON.stringify(await countByColumn('purchase_orders', 'status')));
  console.log('AFTER — fulfillment_orders.commercial_status:', JSON.stringify(await countByColumn('fulfillment_orders', 'commercial_status')));
  await db.close();
}

main().catch(async (e) => {
  console.error('FATAL:', e && e.message ? e.message : e);
  try { await db.close(); } catch (_) {}
  process.exit(1);
});

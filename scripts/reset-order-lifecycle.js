#!/usr/bin/env node
/**
 * Clear all order lifecycle data (B2B + website + client hub), including soft-deleted rows:
 * SO → planning → procurement → GRN → production/BMR/BPR → fulfillment → MRN/MTR →
 * website orders/payments → client_orders → WH reservations & in-transit.
 *
 * Keeps masters: products, RM/PM, BOMs, vendors, facility, users, items_list vendor rates.
 *
 * Usage:
 *   node scripts/reset-order-lifecycle.js --dry-run
 *   node scripts/reset-order-lifecycle.js --yes
 *   ALLOW_RESET_ORDER_LIFECYCLE=true node scripts/reset-order-lifecycle.js
 *
 * Confirmation body token (for future API): RESET_ORDER_MANAGEMENT_LIFECYCLE
 */
require('dotenv').config();
require('../registerModelsForSync');

const {
  CONFIRM_TOKEN,
  resetOrderLifecycle,
} = require('../src/admin/resetOrderLifecycle');

function assertAllowed(argv) {
  const hasYes = argv.includes('--yes') || argv.includes('-y');
  const envOk = String(process.env.ALLOW_RESET_ORDER_LIFECYCLE || '').toLowerCase() === 'true';
  if (argv.includes('--dry-run')) return;
  if (!hasYes && !envOk) {
    console.error(
      'Refusing to run: destructive lifecycle wipe.\n' +
        '  Dry run:  node scripts/reset-order-lifecycle.js --dry-run\n' +
        '  Execute:  node scripts/reset-order-lifecycle.js --yes\n' +
        `  Token:    ${CONFIRM_TOKEN}`
    );
    process.exit(1);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  assertAllowed(argv);
  const dryRun = argv.includes('--dry-run');

  console.log(
    dryRun
      ? '[reset-order-lifecycle] DRY RUN — row counts that would be deleted/zeroed:\n'
      : '[reset-order-lifecycle] Deleting lifecycle data…\n'
  );

  const { stats } = await resetOrderLifecycle({ dryRun });

  let total = 0;
  for (const row of stats) {
    console.log(`  ${row.table}: ${row.deleted}`);
    total += row.deleted;
  }
  console.log(
    dryRun
      ? `\n[reset-order-lifecycle] Dry run complete (${total} rows affected if executed).`
      : `\n[reset-order-lifecycle] Done. Masters (products, RM/PM, BOM, vendors, items_list) were not deleted.`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[reset-order-lifecycle] Failed:', err);
  process.exit(1);
});

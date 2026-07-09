/**
 * One-time script: set commercial_status = 'approved' for all active fulfillment orders.
 *
 * Run against local DB:
 *   node scripts/approve-all-sos.js
 *
 * Run with --dry-run to preview without writing:
 *   node scripts/approve-all-sos.js --dry-run
 *
 * REMOVE this file after running it live on the AWS DB.
 * The live DB is separately hosted — connect via SSH tunnel or by temporarily
 * changing DATABASE_URL in .env before running.
 */

// Load .env before overriding — db.js calls dotenv.config() internally but it won't
// overwrite vars that are already in process.env.
require('dotenv').config();

// When running from the host machine (outside Docker) the service name "db" won't resolve.
// Remap to localhost so the script can connect to the Compose postgres on its mapped port.
if (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('@db:')) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace('@db:', '@127.0.0.1:');
}

const db = require('../db');
const { FulfillmentOrder } = require('../src/fulfillment/models');
const { Op } = require('sequelize');

const DRY_RUN = process.argv.includes('--dry-run');

const SKIP_STATUSES = ['approved', 'partial_closed', 'closed', 'cancelled'];

(async () => {
  try {
    await db.authenticate();
    console.log('[approve-all-sos] DB connected.');

    // Count what will be affected
    const toUpdate = await FulfillmentOrder.findAll({
      where: {
        commercial_status: { [Op.notIn]: SKIP_STATUSES },
        deleted_at: null,
      },
      attributes: ['id', 'so_no', 'commercial_status', 'customer_name'],
    });

    if (toUpdate.length === 0) {
      console.log('[approve-all-sos] Nothing to update — all SOs already at approved/closed/cancelled.');
      process.exit(0);
    }

    console.log(`\n[approve-all-sos] Will set commercial_status → 'approved' on ${toUpdate.length} order(s):\n`);

    // Group by current status for the summary
    const byStatus = {};
    for (const o of toUpdate) {
      const s = o.commercial_status ?? 'null';
      byStatus[s] = (byStatus[s] ?? 0) + 1;
    }
    for (const [status, count] of Object.entries(byStatus)) {
      console.log(`  ${status.padEnd(20)} → approved   (${count} orders)`);
    }

    if (DRY_RUN) {
      console.log('\n[approve-all-sos] DRY RUN — no changes written. Remove --dry-run to apply.');
      process.exit(0);
    }

    const [updated] = await FulfillmentOrder.update(
      { commercial_status: 'approved' },
      {
        where: {
          commercial_status: { [Op.notIn]: SKIP_STATUSES },
          deleted_at: null,
        },
      }
    );

    console.log(`\n[approve-all-sos] ✓ Updated ${updated} fulfillment_orders to commercial_status='approved'.`);
    console.log('[approve-all-sos] Done. Delete this script file once run on the live AWS DB.');
  } catch (err) {
    console.error('[approve-all-sos] Error:', err?.stack ?? err);
    process.exit(1);
  } finally {
    await db.close();
  }
})();

#!/usr/bin/env node
/**
 * Revive production_batches rows soft-deleted on a given date (default: yesterday, server-clock
 * relative) — i.e. undo a soft-delete by clearing deleted_at + lifecycle_status. Unlike
 * planning_batches (hard-deleted, no soft-delete — see revive-planning-batches.js), production_batches
 * really is soft-deleted here, so the row is just sitting there with deleted_at set: no backup needed,
 * no data reconstruction, just clearing the flag.
 *
 * SAFE BY DEFAULT: prints a report and writes nothing unless you pass --yes.
 *
 * Usage:
 *   node scripts/revive-production-batches.js                    # dry run — defaults to "yesterday"
 *   node scripts/revive-production-batches.js --date=2026-09-17  # dry run for a specific date
 *   node scripts/revive-production-batches.js --date=2026-09-17 --yes   # actually revive them
 *
 * What it does NOT do:
 *   - Does not touch planning_batches at all, or try to relink planning_batch_id. If a revived batch
 *     shows planning_batch_id = NULL below, it'll come back visible in Production but disconnected
 *     from Planning — ask for a follow-up once you've confirmed which ones need relinking, rather
 *     than guessing the mapping here.
 */
require('dotenv').config();

if (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('host.docker.internal')) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace('host.docker.internal', 'localhost');
  console.log('Rewrote DATABASE_URL host: host.docker.internal -> localhost (script-local only, .env unchanged)');
}

require('../registerModelsForSync');

function parseArgs(argv) {
  const apply = argv.includes('--yes') || argv.includes('-y');
  const dateArg = argv.find((a) => a.startsWith('--date='));
  let targetDate;
  if (dateArg) {
    targetDate = dateArg.split('=')[1];
  } else {
    const d = new Date();
    d.setDate(d.getDate() - 1); // "yesterday" relative to THIS machine's clock — pass --date= to override
    targetDate = d.toISOString().slice(0, 10);
  }
  return { apply, targetDate };
}

async function main() {
  const { apply, targetDate } = parseArgs(process.argv.slice(2));
  const { ProductionBatch } = require('../src/production/models');
  const db = require('../db');
  const { Op } = require('sequelize');

  await db.authenticate();
  console.log('Connected to DATABASE_URL:', String(process.env.DATABASE_URL || '').replace(/:[^:@/]+@/, ':***@'));
  console.log(`Target date: ${targetDate} (pass --date=YYYY-MM-DD to use a different one)\n`);

  const dayStart = new Date(`${targetDate}T00:00:00`);
  const dayEnd = new Date(`${targetDate}T23:59:59.999`);

  const rows = await ProductionBatch.findAll({
    where: { deleted_at: { [Op.gte]: dayStart, [Op.lte]: dayEnd } },
    attributes: ['id', 'bmr_no', 'bpr_no', 'so_no', 'product_name', 'planning_batch_id', 'bmr_status', 'bpr_status', 'deleted_at'],
    order: [['deleted_at', 'ASC']],
  });

  if (rows.length === 0) {
    console.log(`No production_batches rows have deleted_at on ${targetDate}. Nothing to do.`);
    console.log('(If the server/DB clock is off from what you consider "yesterday", re-run with --date=YYYY-MM-DD.)');
    await db.close();
    return;
  }

  console.log(`${rows.length} production_batches row(s) soft-deleted on ${targetDate}:\n`);
  let linkedCount = 0;
  for (const r of rows) {
    const linked = r.planning_batch_id != null;
    if (linked) linkedCount += 1;
    console.log(
      `  id=${r.id}  ${r.bmr_no}  so_no=${r.so_no}  ${r.product_name}  `
      + `planning_batch_id=${r.planning_batch_id ?? 'NULL (orphaned — will revive disconnected from Planning)'}  `
      + `deleted_at=${r.deleted_at.toISOString()}`
    );
  }
  console.log(`\n${linkedCount} of ${rows.length} still have a planning_batch_id — those will come back fully linked.`);
  console.log(`${rows.length - linkedCount} have planning_batch_id = NULL — those will come back but not linked to any Planning batch.`);

  if (!apply) {
    console.log(`\nDRY RUN — nothing was written. Re-run with --yes to actually revive the ${rows.length} row(s) above.`);
    await db.close();
    return;
  }

  console.log('\nReviving...');
  const [updated] = await ProductionBatch.update(
    { deleted_at: null, lifecycle_status: 'active' },
    { where: { id: rows.map((r) => r.id) } }
  );
  console.log(`Done. Revived ${updated} row(s).`);
  await db.close();
}

main().catch((e) => {
  console.error('revive-production-batches failed:', e);
  process.exit(1);
});

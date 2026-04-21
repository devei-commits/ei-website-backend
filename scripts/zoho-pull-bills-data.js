#!/usr/bin/env node
/**
 * Pull Zoho Books vendor bills (GET /bills) and write JSON.
 *
 * Usage: node scripts/zoho-pull-bills-data.js [--out path.json] [--pretty] [--max-pages=N] [--limit=N] [--filter-by=...]
 */

const { listAllBills, getOrgId } = require('../src/services/zohoBooks');
const { parseZohoPullArgs, writeZohoPullOutput } = require('./lib/zoho-export-pull');

async function main() {
  const opts = parseZohoPullArgs(process.argv.slice(2));
  if (opts.dryRun) {
    console.log('[zoho-pull-bills-data] dry-run', {
      org: getOrgId(),
      filterBy: opts.filterBy,
      maxPages: opts.maxPages,
      limit: opts.limit,
    });
    return;
  }
  const rows = await listAllBills({
    filterBy: opts.filterBy,
    maxPages: opts.maxPages,
    limit: opts.limit,
  });
  const payload = {
    pulledAt: new Date().toISOString(),
    entity: 'bills',
    count: rows.length,
    organizationId: getOrgId(),
    filterBy: opts.filterBy || null,
    rows,
  };
  const written = await writeZohoPullOutput(payload, { out: opts.out, pretty: opts.pretty });
  console.error(`[zoho-pull-bills-data] wrote ${rows.length} bill(s)${written ? ` → ${written}` : ' to stdout'}`);
}

main().catch((e) => {
  console.error('[zoho-pull-bills-data]', e.message || e);
  process.exit(1);
});

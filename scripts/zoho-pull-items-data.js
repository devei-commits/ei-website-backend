#!/usr/bin/env node
/**
 * Pull all Zoho Books items (GET /items) and write JSON.
 * Does not upsert into Postgres — use `npm run zoho:pull-items` (zoho-pull-items-to-products.js) for that.
 *
 * Usage: node scripts/zoho-pull-items-data.js [--out path.json] [--pretty] [--max-pages=N] [--limit=N] [--filter-by=Status.Active]
 * Env: same Zoho OAuth/org as other scripts (see docs/zoho-seed-and-sync-reference.md).
 */

const { listAllItems, getOrgId } = require('../src/services/zohoBooks');
const { parseZohoPullArgs, writeZohoPullOutput } = require('./lib/zoho-export-pull');

async function main() {
  const opts = parseZohoPullArgs(process.argv.slice(2));
  if (opts.dryRun) {
    console.log('[zoho-pull-items-data] dry-run: would list items', {
      org: getOrgId(),
      filterBy: opts.filterBy,
      maxPages: opts.maxPages,
      limit: opts.limit,
    });
    return;
  }
  const rows = await listAllItems({
    filterBy: opts.filterBy,
    maxPages: opts.maxPages,
    limit: opts.limit,
  });
  const payload = {
    pulledAt: new Date().toISOString(),
    entity: 'items',
    count: rows.length,
    organizationId: getOrgId(),
    rows,
  };
  const written = await writeZohoPullOutput(payload, { out: opts.out, pretty: opts.pretty });
  console.error(`[zoho-pull-items-data] wrote ${rows.length} item(s)${written ? ` → ${written}` : ' to stdout'}`);
}

main().catch((e) => {
  console.error('[zoho-pull-items-data]', e.message || e);
  process.exit(1);
});

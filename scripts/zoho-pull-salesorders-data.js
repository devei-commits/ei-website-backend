#!/usr/bin/env node
/**
 * Pull Zoho Books sales orders (GET /salesorders) and write JSON.
 *
 * Usage: node scripts/zoho-pull-salesorders-data.js [--out path.json] [--pretty] [--max-pages=N] [--limit=N] [--filter-by=...]
 */

const { listAllSalesorders, getOrgId } = require('../src/services/zohoBooks');
const { parseZohoPullArgs, writeZohoPullOutput } = require('./lib/zoho-export-pull');

async function main() {
  const opts = parseZohoPullArgs(process.argv.slice(2));
  if (opts.dryRun) {
    console.log('[zoho-pull-salesorders-data] dry-run', {
      org: getOrgId(),
      filterBy: opts.filterBy,
      maxPages: opts.maxPages,
      limit: opts.limit,
    });
    return;
  }
  const rows = await listAllSalesorders({
    filterBy: opts.filterBy,
    maxPages: opts.maxPages,
    limit: opts.limit,
  });
  const payload = {
    pulledAt: new Date().toISOString(),
    entity: 'salesorders',
    count: rows.length,
    organizationId: getOrgId(),
    filterBy: opts.filterBy || null,
    rows,
  };
  const written = await writeZohoPullOutput(payload, { out: opts.out, pretty: opts.pretty });
  console.error(`[zoho-pull-salesorders-data] wrote ${rows.length} sales order(s)${written ? ` → ${written}` : ' to stdout'}`);
}

main().catch((e) => {
  console.error('[zoho-pull-salesorders-data]', e.message || e);
  process.exit(1);
});

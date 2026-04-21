#!/usr/bin/env node
/**
 * Pull Zoho Books estimates / quotes (GET /estimates) and write JSON.
 *
 * Usage: node scripts/zoho-pull-estimates-data.js [--out path.json] [--pretty] [--max-pages=N] [--limit=N] [--filter-by=...]
 */

const { listAllEstimates, getOrgId } = require('../src/services/zohoBooks');
const { parseZohoPullArgs, writeZohoPullOutput } = require('./lib/zoho-export-pull');

async function main() {
  const opts = parseZohoPullArgs(process.argv.slice(2));
  if (opts.dryRun) {
    console.log('[zoho-pull-estimates-data] dry-run', {
      org: getOrgId(),
      filterBy: opts.filterBy,
      maxPages: opts.maxPages,
      limit: opts.limit,
    });
    return;
  }
  const rows = await listAllEstimates({
    filterBy: opts.filterBy,
    maxPages: opts.maxPages,
    limit: opts.limit,
  });
  const payload = {
    pulledAt: new Date().toISOString(),
    entity: 'estimates',
    count: rows.length,
    organizationId: getOrgId(),
    filterBy: opts.filterBy || null,
    rows,
  };
  const written = await writeZohoPullOutput(payload, { out: opts.out, pretty: opts.pretty });
  console.error(`[zoho-pull-estimates-data] wrote ${rows.length} estimate(s)${written ? ` → ${written}` : ' to stdout'}`);
}

main().catch((e) => {
  console.error('[zoho-pull-estimates-data]', e.message || e);
  process.exit(1);
});

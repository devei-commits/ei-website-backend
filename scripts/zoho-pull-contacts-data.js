#!/usr/bin/env node
/**
 * Pull all Zoho Books contacts (GET /contacts) and write JSON.
 * Optional filter: `--filter-by=ContactType.Customer` or env ZOHO_PULL_FILTER_BY.
 *
 * Usage: node scripts/zoho-pull-contacts-data.js [--out path.json] [--pretty] [--max-pages=N] [--limit=N] [--filter-by=...]
 */

const { listAllContacts, getOrgId } = require('../src/services/zohoBooks');
const { parseZohoPullArgs, writeZohoPullOutput } = require('./lib/zoho-export-pull');

async function main() {
  const opts = parseZohoPullArgs(process.argv.slice(2));
  if (opts.dryRun) {
    console.log('[zoho-pull-contacts-data] dry-run', {
      org: getOrgId(),
      filterBy: opts.filterBy,
      maxPages: opts.maxPages,
      limit: opts.limit,
    });
    return;
  }
  const rows = await listAllContacts({
    filterBy: opts.filterBy,
    maxPages: opts.maxPages,
    limit: opts.limit,
  });
  const payload = {
    pulledAt: new Date().toISOString(),
    entity: 'contacts',
    count: rows.length,
    organizationId: getOrgId(),
    filterBy: opts.filterBy || null,
    rows,
  };
  const written = await writeZohoPullOutput(payload, { out: opts.out, pretty: opts.pretty });
  console.error(`[zoho-pull-contacts-data] wrote ${rows.length} contact(s)${written ? ` → ${written}` : ' to stdout'}`);
}

main().catch((e) => {
  console.error('[zoho-pull-contacts-data]', e.message || e);
  process.exit(1);
});

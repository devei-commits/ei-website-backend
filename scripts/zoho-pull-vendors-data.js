#!/usr/bin/env node
/**
 * Pull Zoho Books vendors only (contacts with ContactType.Vendor).
 *
 * Usage: node scripts/zoho-pull-vendors-data.js [--out path.json] [--pretty] [--max-pages=N] [--limit=N] [--filter-by=ContactType.Vendor]
 */

const { listAllContacts, getOrgId } = require('../src/services/zohoBooks');
const { parseZohoPullArgs, writeZohoPullOutput } = require('./lib/zoho-export-pull');

async function main() {
  const opts = parseZohoPullArgs(process.argv.slice(2));
  const filterBy = opts.filterBy || 'ContactType.Vendor';
  if (opts.dryRun) {
    console.log('[zoho-pull-vendors-data] dry-run', {
      org: getOrgId(),
      filterBy,
      maxPages: opts.maxPages,
      limit: opts.limit,
    });
    return;
  }
  const rows = await listAllContacts({
    filterBy,
    maxPages: opts.maxPages,
    limit: opts.limit,
  });
  const payload = {
    pulledAt: new Date().toISOString(),
    entity: 'vendors',
    count: rows.length,
    organizationId: getOrgId(),
    filterBy,
    rows,
  };
  const written = await writeZohoPullOutput(payload, { out: opts.out, pretty: opts.pretty });
  console.error(`[zoho-pull-vendors-data] wrote ${rows.length} row(s)${written ? ` → ${written}` : ' to stdout'}`);
}

main().catch((e) => {
  console.error('[zoho-pull-vendors-data]', e.message || e);
  process.exit(1);
});

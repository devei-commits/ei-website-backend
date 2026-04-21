#!/usr/bin/env node
/**
 * Pull Zoho Books customers only (contacts with ContactType.Customer).
 * Override with `--filter-by=...` if your org uses a different Books filter string.
 *
 * Usage: node scripts/zoho-pull-customers-data.js [--out path.json] [--pretty] [--max-pages=N] [--limit=N]
 */

const { listAllContacts, getOrgId } = require('../src/services/zohoBooks');
const { parseZohoPullArgs, writeZohoPullOutput } = require('./lib/zoho-export-pull');

async function main() {
  const opts = parseZohoPullArgs(process.argv.slice(2));
  const filterBy = opts.filterBy || 'ContactType.Customer';
  if (opts.dryRun) {
    console.log('[zoho-pull-customers-data] dry-run', {
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
    entity: 'customers',
    count: rows.length,
    organizationId: getOrgId(),
    filterBy,
    rows,
  };
  const written = await writeZohoPullOutput(payload, { out: opts.out, pretty: opts.pretty });
  console.error(`[zoho-pull-customers-data] wrote ${rows.length} row(s)${written ? ` → ${written}` : ' to stdout'}`);
}

main().catch((e) => {
  console.error('[zoho-pull-customers-data]', e.message || e);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Pull Zoho vendor contacts and upsert into local `vendor_clients` (type='vendor').
 *
 * Usage: node scripts/zoho-pull-vendors-to-vendor-clients.js [--dry-run] [--max-pages=N] [--limit=N] [--filter-by=...]
 * `--limit=N` caps how many contact rows are fetched from Zoho (then filtered to vendors).
 *
 * Core upsert logic lives in src/vendorClient/zohoVendorPull.js, shared with the in-app
 * "Import from Zoho" button (POST /api/v1/vendor-clients/import-zoho-vendors).
 */
require('dotenv').config();

const { pullZohoVendorsIntoVendorClients } = require('../src/vendorClient/zohoVendorPull');
const { parseZohoPullArgs } = require('./lib/zoho-export-pull');

async function main() {
  const opts = parseZohoPullArgs(process.argv.slice(2));
  const summary = await pullZohoVendorsIntoVendorClients(opts);
  const { createdVendors, updatedVendors, ...rest } = summary;
  console.log(JSON.stringify({ dryRun: !!opts.dryRun, limit: opts.limit ?? null, ...rest }, null, 2));
}

main().catch((e) => {
  console.error('[zoho-pull-vendors-to-vendor-clients]', e?.message || e);
  process.exit(1);
});

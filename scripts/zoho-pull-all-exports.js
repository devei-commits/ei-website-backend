#!/usr/bin/env node
/**
 * Run all Zoho “pull JSON” exports in one process (items, contacts, customers, vendors,
 * invoices, sales orders, estimates, bills, purchase orders).
 *
 * Usage: node scripts/zoho-pull-all-exports.js [--dir exports/zoho-pull] [--pretty] [--max-pages=N] [--limit=N]
 * Default dir: ./exports/zoho-pull-<ISO-date>
 */

const fs = require('fs').promises;
const path = require('path');

require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const {
  listAllItems,
  listAllContacts,
  listAllInvoices,
  listAllSalesorders,
  listAllEstimates,
  listAllBills,
  listAllPurchaseorders,
  getOrgId,
} = require('../src/services/zohoBooks');

function isInvalidFilterByError(error) {
  const msg = String(error && error.message ? error.message : '').toLowerCase();
  return msg.includes('invalid value passed for filter_by');
}

function getNormalizedContactType(row) {
  const v = row && (row.contact_type || row.contactType || row.contactTypeName);
  return String(v || '').trim().toLowerCase();
}

async function listAllContactsByTypeWithFallback(common, filterBy, expectedType) {
  try {
    return await listAllContacts({ ...common, filterBy });
  } catch (error) {
    if (!isInvalidFilterByError(error)) throw error;
    process.stderr.write(
      `[zoho-pull-all-exports] filter_by=${filterBy} not accepted; pulling all contacts and filtering ${expectedType} locally\n`,
    );
    const contacts = await listAllContacts(common);
    const wanted = String(expectedType).trim().toLowerCase();
    return contacts.filter((row) => getNormalizedContactType(row) === wanted);
  }
}

function parseDir(argv) {
  const a = argv.find((x) => String(x).startsWith('--dir='));
  if (a) return path.resolve(process.cwd(), String(a).slice('--dir='.length).trim());
  const idx = argv.indexOf('--dir');
  if (idx >= 0 && argv[idx + 1]) return path.resolve(process.cwd(), String(argv[idx + 1]).trim());
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.resolve(process.cwd(), 'exports', `zoho-pull-${stamp}`);
}

function parsePretty(argv) {
  return argv.includes('--pretty');
}

function parseMaxPages(argv) {
  const a = argv.find((x) => String(x).startsWith('--max-pages='));
  if (!a) return undefined;
  const n = parseInt(String(a).split('=')[1], 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseLimit(argv) {
  const a = argv.find((x) => String(x).startsWith('--limit='));
  if (a) {
    const n = parseInt(String(a).split('=')[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (process.env.ZOHO_PULL_LIMIT != null && String(process.env.ZOHO_PULL_LIMIT).trim() !== '') {
    const n = parseInt(String(process.env.ZOHO_PULL_LIMIT).trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

async function writeFile(dir, name, payload, pretty) {
  const fp = path.join(dir, name);
  await fs.writeFile(fp, `${JSON.stringify(payload, null, pretty ? 2 : undefined)}\n`, 'utf8');
  return fp;
}

async function main() {
  const argv = process.argv.slice(2);
  const dir = parseDir(argv);
  const pretty = parsePretty(argv);
  const maxPages = parseMaxPages(argv);
  const limit = parseLimit(argv);
  const common = { maxPages, limit };
  const orgId = getOrgId();

  await fs.mkdir(dir, { recursive: true });
  console.error(`[zoho-pull-all-exports] org=${orgId} → ${dir}${limit != null ? ` limit=${limit}` : ''}`);

  const jobs = [
    { file: 'items.json', label: 'items', fn: () => listAllItems(common) },
    { file: 'contacts.json', label: 'contacts', fn: () => listAllContacts(common) },
    {
      file: 'customers.json',
      label: 'customers',
      fn: () => listAllContactsByTypeWithFallback(common, 'ContactType.Customer', 'customer'),
    },
    {
      file: 'vendors.json',
      label: 'vendors',
      fn: () => listAllContactsByTypeWithFallback(common, 'ContactType.Vendor', 'vendor'),
    },
    { file: 'invoices.json', label: 'invoices', fn: () => listAllInvoices(common) },
    { file: 'salesorders.json', label: 'salesorders', fn: () => listAllSalesorders(common) },
    { file: 'estimates.json', label: 'estimates', fn: () => listAllEstimates(common) },
    { file: 'bills.json', label: 'bills', fn: () => listAllBills(common) },
    { file: 'purchaseorders.json', label: 'purchaseorders', fn: () => listAllPurchaseorders(common) },
  ];

  for (const j of jobs) {
    process.stderr.write(`[zoho-pull-all-exports] pulling ${j.label}…\n`);
    const rows = await j.fn();
    const payload = {
      pulledAt: new Date().toISOString(),
      entity: j.label,
      count: rows.length,
      organizationId: orgId,
      rows,
    };
    const fp = await writeFile(dir, j.file, payload, pretty);
    process.stderr.write(`[zoho-pull-all-exports] ${j.label}: ${rows.length} → ${fp}\n`);
  }

  console.error('[zoho-pull-all-exports] done.');
}

main().catch((e) => {
  console.error('[zoho-pull-all-exports]', e.message || e);
  process.exit(1);
});

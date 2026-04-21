/**
 * Shared CLI helpers for Zoho Books “pull & export JSON” scripts.
 * Loads `.env` from cwd; optional `--out`, `--pretty`, `--max-pages=N`, `--filter-by=...`, `--limit=N`
 *
 * `--limit=N` (or env `ZOHO_PULL_LIMIT`): stop after N rows from the Zoho list API (fewer pages / less data).
 * Import scripts should pass this through to `listAll*` in `zohoBooks.js`.
 */

const fs = require('fs').promises;
const path = require('path');

require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

/**
 * @param {string[]} argv
 * @returns {{ out: string | null, pretty: boolean, dryRun: boolean, maxPages?: number, filterBy?: string, limit?: number }}
 */
function parseZohoPullArgs(argv) {
  const outIdx = argv.indexOf('--out');
  const out = outIdx >= 0 && argv[outIdx + 1] ? String(argv[outIdx + 1]).trim() : null;
  const pretty = argv.includes('--pretty');
  const dryRun = argv.includes('--dry-run');
  const maxArg = argv.find((a) => String(a).startsWith('--max-pages='));
  const maxPages = maxArg ? Math.max(1, parseInt(String(maxArg).split('=')[1], 10) || 0) : undefined;
  const filterArg = argv.find((a) => String(a).startsWith('--filter-by='));
  const filterBy = filterArg
    ? String(filterArg)
        .slice('--filter-by='.length)
        .trim() || undefined
    : process.env.ZOHO_PULL_FILTER_BY
      ? String(process.env.ZOHO_PULL_FILTER_BY).trim() || undefined
      : undefined;
  const limitArg = argv.find((a) => String(a).startsWith('--limit='));
  let limit;
  if (limitArg) {
    const n = parseInt(String(limitArg).split('=')[1], 10);
    if (Number.isFinite(n) && n > 0) limit = n;
  } else if (process.env.ZOHO_PULL_LIMIT != null && String(process.env.ZOHO_PULL_LIMIT).trim() !== '') {
    const n = parseInt(String(process.env.ZOHO_PULL_LIMIT).trim(), 10);
    if (Number.isFinite(n) && n > 0) limit = n;
  }
  return { out, pretty, dryRun, maxPages, filterBy, limit };
}

/**
 * @param {unknown} data
 * @param {{ out: string | null, pretty: boolean }} opts
 */
async function writeZohoPullOutput(data, opts) {
  const body = `${JSON.stringify(data, null, opts.pretty ? 2 : undefined)}\n`;
  if (opts.out) {
    const abs = path.resolve(process.cwd(), opts.out);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, 'utf8');
    return abs;
  }
  process.stdout.write(body);
  return null;
}

module.exports = {
  parseZohoPullArgs,
  writeZohoPullOutput,
};

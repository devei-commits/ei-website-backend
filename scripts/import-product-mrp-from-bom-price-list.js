#!/usr/bin/env node
/**
 * Update products.mrp_price from "BOM Price List" Excel (SKU + Selling Price/Unit).
 *
 * Usage:
 *   node scripts/import-product-mrp-from-bom-price-list.js <path-to.xlsx>
 *   node scripts/import-product-mrp-from-bom-price-list.js <path-to.xlsx> --dry-run
 *
 * Path must be readable inside the process (container path when using docker exec).
 * For a Windows host file + Docker DB, use:
 *   npm run import:product-mrp-bom:docker -- "D:\downloads\file.xlsx"
 *
 * Requires DATABASE_URL (or .env) like other backend scripts.
 */
require('dotenv').config();

const fs = require('fs');
const db = require('../db');
const {
  parseBomPriceListFile,
  applyBomPriceListMrpUpdates,
} = require('../src/products/bomPriceListMrpImport');
const {
  resolveExcelFilePath,
  resolveExistingExcelFilePath,
  isWindowsDrivePath,
} = require('./lib/resolveExcelFilePath');

function parseArgs(argv) {
  const fileArg = argv.find((a) => !a.startsWith('-'));
  const dryRun = argv.includes('--dry-run');
  const filePath = fileArg ? resolveExistingExcelFilePath(fileArg) : null;
  const { tried } = fileArg ? resolveExcelFilePath(fileArg) : { tried: [] };
  return { fileArg, filePath, triedPaths: tried, dryRun };
}

function printSummary(parsed, result) {
  const { rows, sheetName } = parsed;
  const { updated, skipped, not_found, invalid_price, dryRun } = result;

  console.log(`Sheet: ${sheetName}`);
  console.log(`Rows with SKU + price: ${rows.length}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no DB writes)' : 'APPLY'}`);
  console.log(`Updated: ${updated.length}`);
  console.log(`Skipped (unchanged): ${skipped.length}`);
  console.log(`Not found in products: ${not_found.length}`);
  console.log(`Invalid price in sheet: ${invalid_price.length}`);

  if (updated.length) {
    console.log('\nUpdated:');
    for (const u of updated.slice(0, 50)) {
      console.log(
        `  row ${u.excel_row} ${u.sku} product_id=${u.product_id} ${u.old_mrp ?? 'null'} -> ${u.new_mrp}`
      );
    }
    if (updated.length > 50) console.log(`  ... and ${updated.length - 50} more`);
  }

  if (not_found.length) {
    console.log('\nNot found (check zoho_sku_code / product_code):');
    for (const n of not_found.slice(0, 30)) {
      console.log(`  row ${n.excel_row} SKU=${n.sku} price=${n.mrp_price}`);
    }
    if (not_found.length > 30) console.log(`  ... and ${not_found.length - 30} more`);
  }
}

async function main() {
  const { fileArg, filePath, triedPaths, dryRun } = parseArgs(process.argv.slice(2));
  if (!fileArg) {
    console.error(
      'Usage: node scripts/import-product-mrp-from-bom-price-list.js <path-to.xlsx> [--dry-run]'
    );
    process.exit(1);
  }
  if (!filePath || !fs.existsSync(filePath)) {
    console.error('File not found:', fileArg);
    if (triedPaths.length) console.error('Tried:', triedPaths.join(', '));
    if (isWindowsDrivePath(fileArg) && fs.existsSync('/.dockerenv')) {
      console.error(
        'Host paths like D:\\downloads\\... are not visible inside the container.',
        'Run from the host instead:',
        '  npm run import:product-mrp-bom:docker -- "<your-path>"',
        'Or copy the file into this repo (e.g. data/BOM_Master_Price_List.xlsx) and pass that path.'
      );
    }
    process.exit(1);
  }

  let parsed;
  try {
    parsed = parseBomPriceListFile(filePath);
  } catch (err) {
    console.error('Parse error:', err.message);
    process.exit(1);
  }

  if (!parsed.rows.length) {
    console.error('No data rows with SKU and Selling Price/Unit found.');
    process.exit(1);
  }

  try {
    await db.authenticate();
    const result = await applyBomPriceListMrpUpdates(parsed.rows, { dryRun });
    printSummary(parsed, result);
    process.exit(result.not_found.length && !result.updated.length ? 2 : 0);
  } catch (err) {
    console.error('Import failed:', err.message);
    process.exit(1);
  } finally {
    await db.close().catch(() => {});
  }
}

if (require.main === module) {
  main();
}

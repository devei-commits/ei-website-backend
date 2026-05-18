/**
 * Import product MRP from "BOM Price List" workbook tab (SKU + Selling Price/Unit).
 */
const XLSX = require('xlsx');
const { findProductByCompositeSku } = require('./formulaBomProductResolve');
const { Product } = require('./models');

const BOM_PRICE_LIST_SHEET = 'BOM Price List';

const SKU_HEADER_ALIASES = ['sku', 'item sku', 'composite sku', 'zoho sku', 'item code'];
const PRICE_HEADER_ALIASES = [
  'selling price/unit',
  'selling price per unit',
  'selling price',
  'price/unit',
  'price per unit',
  'unit price',
  'mrp',
  'mrp price',
];

function normHeader(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normSheetName(s) {
  return normHeader(s);
}

function matchHeaderAlias(cellText, aliases) {
  const h = normHeader(cellText);
  return aliases.some((a) => h === a || h.includes(a));
}

function findColumnIndex(headers, aliases) {
  for (let i = 0; i < headers.length; i += 1) {
    if (matchHeaderAlias(headers[i], aliases)) return i;
  }
  return -1;
}

/** @param {unknown} raw */
function parseMrpPrice(raw) {
  if (raw == null || raw === '') return null;
  const n = parseFloat(String(raw).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * @param {import('xlsx').WorkBook} workbook
 * @returns {{ rows: Array<{ excel_row: number, sku: string, mrp_price: number }>, sheetName: string, headers: string[] }}
 */
function parseBomPriceListWorkbook(workbook) {
  const sheetName =
    workbook.SheetNames.find((n) => normSheetName(n) === normSheetName(BOM_PRICE_LIST_SHEET)) ||
    BOM_PRICE_LIST_SHEET;
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    const available = workbook.SheetNames.join(', ');
    throw new Error(`Worksheet "${BOM_PRICE_LIST_SHEET}" not found. Available: ${available}`);
  }

  const raw = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });
  if (!raw.length) {
    return { rows: [], sheetName, headers: [] };
  }

  const headers = raw[0].map((h) => (h != null ? String(h).trim() : ''));
  const skuCol = findColumnIndex(headers, SKU_HEADER_ALIASES);
  const priceCol = findColumnIndex(headers, PRICE_HEADER_ALIASES);
  if (skuCol < 0) {
    throw new Error(`SKU column not found on "${sheetName}". Headers: ${headers.join(' | ')}`);
  }
  if (priceCol < 0) {
    throw new Error(
      `Selling Price/Unit column not found on "${sheetName}". Headers: ${headers.join(' | ')}`
    );
  }

  const rows = [];
  for (let i = 1; i < raw.length; i += 1) {
    const line = raw[i];
    const sku = line[skuCol] != null ? String(line[skuCol]).trim() : '';
    if (!sku) continue;
    const priceRaw = line[priceCol];
    const mrp_price = parseMrpPrice(priceRaw);
    if (mrp_price == null) continue;
    rows.push({ excel_row: i + 1, sku, mrp_price });
  }

  return { rows, sheetName, headers };
}

/**
 * @param {string} filePath
 */
function parseBomPriceListFile(filePath) {
  const workbook = XLSX.readFile(filePath, { type: 'file', cellDates: true });
  return parseBomPriceListWorkbook(workbook);
}

/**
 * @param {Buffer|ArrayBuffer} buffer
 */
function parseBomPriceListBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  return parseBomPriceListWorkbook(workbook);
}

/**
 * @param {Array<{ excel_row: number, sku: string, mrp_price: number }>} rows
 * @param {{ dryRun?: boolean }} [opts]
 */
async function applyBomPriceListMrpUpdates(rows, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const updated = [];
  const skipped = [];
  const not_found = [];
  const invalid_price = [];

  for (const row of rows) {
    const sku = String(row.sku || '').trim();
    const mrp_price = parseMrpPrice(row.mrp_price);
    if (!sku) continue;
    if (mrp_price == null) {
      invalid_price.push({ ...row, sku, reason: 'invalid_price' });
      continue;
    }

    const product = await findProductByCompositeSku(sku);
    if (!product) {
      not_found.push({ excel_row: row.excel_row, sku, mrp_price });
      continue;
    }

    const oldVal = product.mrp_price != null ? Number(product.mrp_price) : null;
    if (oldVal != null && Math.abs(oldVal - mrp_price) < 0.005) {
      skipped.push({
        excel_row: row.excel_row,
        sku,
        product_id: product.product_id,
        mrp_price,
        reason: 'unchanged',
      });
      continue;
    }

    if (!dryRun) {
      await Product.update(
        { mrp_price, updated_at: new Date() },
        { where: { product_id: product.product_id } }
      );
    }

    updated.push({
      excel_row: row.excel_row,
      sku,
      product_id: product.product_id,
      product_name: product.product_name,
      old_mrp: oldVal,
      new_mrp: mrp_price,
    });
  }

  return { updated, skipped, not_found, invalid_price, dryRun };
}

module.exports = {
  BOM_PRICE_LIST_SHEET,
  parseMrpPrice,
  parseBomPriceListWorkbook,
  parseBomPriceListFile,
  parseBomPriceListBuffer,
  applyBomPriceListMrpUpdates,
};

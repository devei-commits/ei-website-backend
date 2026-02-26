/**
 * Read an Excel file and extract headers (first row) and all row data.
 *
 * Usage:
 *   node scripts/excel.js <path-to-file.xlsx>
 *   node scripts/excel.js                    (uses ./data/sample.xlsx if present)
 *
 * Output: JSON with { headers, rows } or { headers, rowsAsObjects }.
 */

const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

function getFilePath() {
  const arg = process.argv[2];
  if (arg) return path.resolve(process.cwd(), arg);
  const defaultPath = path.resolve(process.cwd(), 'data', 'sample.xlsx');
  if (fs.existsSync(defaultPath)) return defaultPath;
  return null;
}

/**
 * Read Excel file and return sheet data.
 * @param {string} filePath - Path to .xlsx or .xls file
 * @param {object} options - { sheetIndex: 0 } or { sheetName: 'Sheet1' }
 * @returns {{ headers: string[], rows: any[][], rowsAsObjects: object[] }}
 */
function readExcel(filePath, options = {}) {
  const workbook = XLSX.readFile(filePath, { type: 'file', cellDates: true });
  const sheetName = options.sheetName || workbook.SheetNames[options.sheetIndex ?? 0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`Sheet not found: ${sheetName}. Available: ${workbook.SheetNames.join(', ')}`);
  }

  // Convert to array of arrays (raw rows)
  const raw = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });

  if (!raw.length) {
    return { headers: [], rows: [], rowsAsObjects: [] };
  }

  const headers = raw[0].map((h) => (h != null ? String(h).trim() : ''));
  const rows = raw.slice(1).filter((row) => row.some((cell) => cell != null && String(cell).trim() !== ''));

  // Rows as objects: each row is { [header]: value }
  const rowsAsObjects = rows.map((row) => {
    const obj = {};
    headers.forEach((header, i) => {
      const key = header || `column_${i}`;
      obj[key] = row[i] != null ? row[i] : '';
    });
    return obj;
  });

  return { headers, rows, rowsAsObjects };
}

function main() {
  const filePath = getFilePath();
  if (!filePath) {
    console.error('Usage: node scripts/excel.js <path-to-file.xlsx>');
    console.error('Example: node scripts/excel.js ./uploads/items.xlsx');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error('File not found:', filePath);
    process.exit(1);
  }

  try {
    const { headers, rows, rowsAsObjects } = readExcel(filePath);
    console.log(JSON.stringify({ headers, rows, rowsAsObjects }, null, 2));
  } catch (err) {
    console.error('Error reading Excel:', err.message);
    process.exit(1);
  }
}

// Export for use as module; run main when executed directly
if (require.main === module) {
  main();
}

module.exports = { readExcel, getFilePath };

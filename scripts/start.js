const path = require('path');
const fs = require('fs');

const { readExcel } = require('./excel');

// Excel file path (relative to project root) – change this to your file
const EXCEL_FILE = path.join(__dirname, '..' , 'Composite_Item.xlsx');
console.log(EXCEL_FILE);


if (!fs.existsSync(EXCEL_FILE)) {
  console.error('Excel file not found:', EXCEL_FILE);
  process.exit(1);
}

const { headers, rows, rowsAsObjects } = readExcel(EXCEL_FILE);
console.log(JSON.stringify({ headers, rows, rowsAsObjects }, null, 2));

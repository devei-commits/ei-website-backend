const fs = require('fs').promises;
const path = require('path');

function isPresent(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function evaluateRequiredFields(row, fieldDefinitions) {
  const missingFields = [];
  for (const field of fieldDefinitions) {
    const value = typeof field.getValue === 'function' ? field.getValue(row) : row?.[field.key];
    if (!isPresent(value)) {
      missingFields.push(field.key);
    }
  }
  return missingFields;
}

async function writeMissingFieldsReport({
  outputPath,
  entity,
  requiredFields,
  missingRecords,
  meta = {},
}) {
  const absPath = path.resolve(process.cwd(), outputPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    entity,
    requiredFields,
    totalMissingRecords: Array.isArray(missingRecords) ? missingRecords.length : 0,
    meta,
    missingRecords: Array.isArray(missingRecords) ? missingRecords : [],
  };
  await fs.writeFile(absPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return absPath;
}

async function cleanOutputFile(outputPath) {
  const absPath = path.resolve(process.cwd(), outputPath);
  try {
    await fs.unlink(absPath);
  } catch (e) {
    // Ignore "file not found" so imports can run on first ever execution.
    if (!(e && e.code === 'ENOENT')) throw e;
  }
}

module.exports = {
  evaluateRequiredFields,
  writeMissingFieldsReport,
  cleanOutputFile,
};

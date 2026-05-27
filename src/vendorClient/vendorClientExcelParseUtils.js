const XLSX = require('xlsx');
const { Op, where, fn, literal } = require('sequelize');
const { cellToText } = require('../masterBulk/masterExcelFlexibleParse');

const MAX_SCAN_ROWS = 10000;
const ZOHO_ID_DIGITS_RE = /^\d{10,22}$/;

/**
 * ExcelJS often under-reports actualRowCount; use dimensions.bottom and a trailing scan.
 * @param {import('exceljs').Worksheet} worksheet
 * @param {number} headerRow
 */
function getWorksheetScanEndRow(worksheet, headerRow) {
  const bottom = Number(worksheet.dimensions?.bottom ?? 0);
  const reported = Number(worksheet.actualRowCount || worksheet.rowCount || 0);
  const base = Math.max(bottom, reported, headerRow + 1);
  return Math.min(base + 150, headerRow + MAX_SCAN_ROWS);
}

/**
 * @param {import('exceljs').Worksheet} worksheet
 * @param {number} headerRow
 * @param {(row: import('exceljs').Row) => boolean} rowHasData
 */
function findLastDataRow(worksheet, headerRow, rowHasData) {
  const end = getWorksheetScanEndRow(worksheet, headerRow);
  let lastDataRow = headerRow;
  let emptyStreak = 0;

  for (let r = headerRow + 1; r <= end; r += 1) {
    const row = worksheet.getRow(r);
    if (rowHasData(row)) {
      lastDataRow = r;
      emptyStreak = 0;
    } else {
      emptyStreak += 1;
      if (emptyStreak >= 40 && r > lastDataRow + 40) break;
    }
  }

  return lastDataRow;
}

function normalizeHeaderLabel(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s.]/g, '');
}

function normalizeSheetNameForMatch(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function headerLabelMatchesAlias(label, aliases) {
  const normalized = normalizeHeaderLabel(label);
  if (!normalized) return false;
  return aliases.some((alias) => {
    const a = normalizeHeaderLabel(alias);
    return a === normalized || normalized.includes(a) || a.includes(normalized);
  });
}

/**
 * @param {import('xlsx').CellObject|undefined} cell
 */
function sheetCellHeaderLabel(cell) {
  if (!cell) return '';
  if (typeof cell.w === 'string' && cell.w.trim()) return cell.w.trim();
  if (cell.t === 's' && typeof cell.v === 'string') return cell.v.trim();
  if (cell.t === 'str') return String(cell.v ?? '').trim();
  if (cell.t === 'n' && typeof cell.v === 'number') return String(cell.v);
  return '';
}

/**
 * Read Zoho id from raw XLSX cell (SheetJS). String cells keep full precision.
 * @param {import('xlsx').CellObject|undefined} cell
 * @returns {{ id: string, reliable: boolean, source: string }}
 */
function readZohoIdFromXlsxCell(cell) {
  const empty = { id: '', reliable: false, source: 'empty' };
  if (!cell) return empty;

  if (cell.t === 's' || cell.t === 'str') {
    const id = String(cell.v ?? cell.w ?? '')
      .trim()
      .replace(/\s/g, '');
    if (!id) return empty;
    const reliable = ZOHO_ID_DIGITS_RE.test(id);
    return { id, reliable, source: 'string' };
  }

  if (cell.t === 'n' && typeof cell.v === 'number' && Number.isFinite(cell.v)) {
    const id = Number.isSafeInteger(cell.v) ? String(cell.v) : String(Math.trunc(cell.v));
    return { id, reliable: false, source: 'number' };
  }

  const display = typeof cell.w === 'string' ? cell.w.trim() : '';
  if (display && /[eE]/.test(display)) {
    const n = Number(display);
    const id = Number.isFinite(n) ? String(Math.trunc(n)) : '';
    return id ? { id, reliable: false, source: 'scientific' } : empty;
  }

  if (display) {
    const id = display.replace(/\s/g, '');
    if (ZOHO_ID_DIGITS_RE.test(id)) return { id, reliable: true, source: 'formatted' };
    if (/[eE]/.test(id)) {
      const n = Number(id);
      return Number.isFinite(n)
        ? { id: String(Math.trunc(n)), reliable: false, source: 'scientific' }
        : empty;
    }
    return { id, reliable: false, source: 'formatted' };
  }

  return empty;
}

/**
 * Map excel row (1-based) → Zoho id read from file XML (avoids ExcelJS double rounding).
 * @param {Buffer} buffer
 * @param {string} preferredSheetName
 * @param {string[]} zohoHeaderAliases
 */
function buildZohoColumnOverlayFromXlsx(buffer, preferredSheetName, zohoHeaderAliases) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellText: true, cellNF: true, cellDates: false });
  const target = normalizeSheetNameForMatch(preferredSheetName);
  const sheetName =
    wb.SheetNames.find((n) => normalizeSheetNameForMatch(n) === target) ||
    wb.SheetNames.find((n) => normalizeSheetNameForMatch(n).includes(target)) ||
    null;
  const sheet = sheetName ? wb.Sheets[sheetName] : null;
  if (!sheet || !sheet['!ref']) {
    return { byRow: {}, sheetName, unreliableCount: 0 };
  }

  const range = XLSX.utils.decode_range(sheet['!ref']);
  let zohoCol = -1;
  let headerRow0 = -1;

  for (let r = range.s.r; r <= Math.min(range.s.r + 7, range.e.r); r += 1) {
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const label = sheetCellHeaderLabel(sheet[addr]);
      if (headerLabelMatchesAlias(label, zohoHeaderAliases)) {
        zohoCol = c;
        headerRow0 = r;
        break;
      }
    }
    if (zohoCol >= 0) break;
  }

  if (zohoCol < 0) {
    return { byRow: {}, sheetName, unreliableCount: 0 };
  }

  const byRow = {};
  let unreliableCount = 0;

  for (let r = headerRow0 + 1; r <= range.e.r; r += 1) {
    const addr = XLSX.utils.encode_cell({ r, c: zohoCol });
    const info = readZohoIdFromXlsxCell(sheet[addr]);
    if (!info.id) continue;
    byRow[r + 1] = info;
    if (!info.reliable) unreliableCount += 1;
  }

  return { byRow, sheetName, zohoCol, headerRow: headerRow0 + 1, unreliableCount };
}

/**
 * @param {Record<string, string|boolean>} fields
 * @param {{ byRow?: Record<number, { id: string, reliable: boolean }> }} overlay
 * @param {number} excelRow
 */
function applyZohoOverlayToFields(fields, overlay, excelRow) {
  const info = overlay?.byRow?.[excelRow];
  if (!info?.id) return fields;
  return {
    ...fields,
    zohoContactId: info.id,
    zohoContactIdReliable: info.reliable,
  };
}

/**
 * Zoho contact IDs are 15–20 digit strings. Excel often stores them as numbers and
 * loses precision (e.g. 3628277000000250123 → 3628277000000250000), which merges
 * distinct vendors on import.
 * @param {import('exceljs').Cell} cell
 * @returns {{ id: string, reliable: boolean }}
 */
function readZohoContactIdMetaFromCell(cell) {
  const empty = { id: '', reliable: false };
  if (!cell || (cell.value == null && cell.value !== 0)) return empty;

  const fromText = cell.text != null ? String(cell.text).trim() : '';
  if (fromText && !/[eE]/.test(fromText)) {
    const id = fromText.replace(/\s/g, '');
    return { id, reliable: id.length > 0 };
  }

  if (typeof cell.value === 'string') {
    const id = cell.value.trim().replace(/\s/g, '');
    return { id, reliable: id.length > 0 && !/[eE]/.test(id) };
  }

  if (typeof cell.value === 'number' && Number.isFinite(cell.value)) {
    const id = Number.isSafeInteger(cell.value) ? String(cell.value) : String(cell.value);
    return { id, reliable: false };
  }

  const fallback = String(cellToText(cell)).trim().replace(/\s/g, '');
  if (!fallback) return empty;
  if (/[eE]/.test(fallback)) {
    const n = Number(fallback);
    return Number.isFinite(n) ? { id: String(Math.trunc(n)), reliable: false } : empty;
  }
  if (/[eE]/.test(fallback)) {
    const n = Number(fallback);
    return Number.isFinite(n) ? { id: String(Math.trunc(n)), reliable: false } : empty;
  }
  return { id: fallback, reliable: fallback.length > 0 };
}

/**
 * @param {import('exceljs').Cell} cell
 */
function readZohoContactIdFromCell(cell) {
  return readZohoContactIdMetaFromCell(cell).id;
}

/**
 * @param {Record<string, string|boolean>} fields
 */
function resolveZohoFromExcelFields(fields) {
  const displayId = String(fields.zohoContactId || '')
    .trim()
    .replace(/\s/g, '');
  let reliable = false;
  if (fields.zohoContactIdReliable === true) {
    reliable = true;
  } else if (fields.zohoContactIdReliable === false) {
    reliable = false;
  } else if (displayId && !/[eE]/.test(displayId)) {
    reliable = true;
  }
  const upsertId = reliable && displayId ? displayId : null;
  return {
    displayId,
    upsertId,
    unreliable: Boolean(displayId && !reliable),
  };
}

/**
 * @param {{ name?: string, email?: string|null, data?: Record<string, unknown> }} payload
 */
function buildMasterImportFingerprint(payload) {
  const d = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const parts = [
    String(payload?.name || '').trim().toLowerCase(),
    String(d.legalName || '').trim().toLowerCase(),
    String(d.tradeName || '').trim().toLowerCase(),
    String(payload?.email || '').trim().toLowerCase(),
    String(d.gstin || '').trim().toLowerCase(),
    String(d.pan || '').trim().toUpperCase(),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('|') : '';
}

/**
 * @param {{ zoho_id?: string|null, data?: Record<string, unknown> }} incoming
 */
function resolveZohoLookupKey(incoming) {
  const columnZoho = String(incoming?.zoho_id || '').trim();
  if (columnZoho) return columnZoho;
  const dataZoho = incoming?.data && typeof incoming.data === 'object' ? incoming.data.zohoId : '';
  return String(dataZoho || '').trim() || null;
}

/**
 * @param {'vendor'|'client'} type
 * @param {object} incoming
 * @param {import('sequelize').ModelStatic} VendorClientModel
 */
async function findExistingMasterImportRow(type, incoming, VendorClientModel) {
  if (incoming.zoho_id) {
    const byZoho = await VendorClientModel.findOne({
      where: { type, zoho_id: incoming.zoho_id },
    });
    if (byZoho) return byZoho;
  }

  const data = incoming.data && typeof incoming.data === 'object' ? incoming.data : {};
  const fingerprint = String(data.importFingerprint || '').trim();
  if (fingerprint) {
    const byFingerprint = await VendorClientModel.findOne({
      where: {
        type,
        [Op.and]: [where(literal("data->>'importFingerprint'"), fingerprint)],
      },
    });
    if (byFingerprint) return byFingerprint;
  }

  const gstin = String(data.gstin || '').trim();
  if (gstin && !incoming.zoho_id) {
    const byGstin = await VendorClientModel.findOne({
      where: {
        type,
        [Op.and]: [
          where(fn('lower', literal("COALESCE(data->>'gstin','')")), gstin.toLowerCase()),
        ],
      },
    });
    if (byGstin) return byGstin;
  }

  if (incoming.email && !incoming.zoho_id) {
    return VendorClientModel.findOne({
      where: { type, email: { [Op.iLike]: incoming.email } },
    });
  }

  return null;
}

function readRowFields(row, colMap, headerKeys) {
  const fields = {};
  for (const key of headerKeys) {
    const idx = colMap[key];
    if (!idx) {
      fields[key] = '';
      continue;
    }
    const cell = row.getCell(idx);
    if (key === 'zohoContactId') {
      const meta = readZohoContactIdMetaFromCell(cell);
      fields.zohoContactId = meta.id;
      fields.zohoContactIdReliable = meta.reliable;
      continue;
    }
    fields[key] = cellToText(cell);
  }
  return fields;
}

function rowNameKey(payload) {
  return [
    String(payload?.name || '').trim().toLowerCase(),
    String(payload?.email || '').trim().toLowerCase(),
  ].join('|');
}

/**
 * Collapse duplicate Excel lines and split rows that share a rounded Zoho id but differ by name.
 * @param {Array<{ excel_row: number, sheet_name: string, payload: object }>} rows
 */
function prepareMasterImportRows(rows) {
  const byZoho = new Map();
  const noZoho = [];

  for (const row of rows) {
    const zid = String(row.payload?.zoho_id || '').trim();
    if (!zid) {
      noZoho.push(row);
      continue;
    }
    if (!byZoho.has(zid)) byZoho.set(zid, []);
    byZoho.get(zid).push(row);
  }

  const prepared = [...noZoho];
  let merged_duplicate_rows = 0;
  let zoho_id_collisions_cleared = 0;

  for (const [, group] of byZoho) {
    const nameKeys = new Set(group.map((r) => rowNameKey(r.payload)));

    if (nameKeys.size === 1) {
      prepared.push(group[group.length - 1]);
      merged_duplicate_rows += Math.max(0, group.length - 1);
      continue;
    }

    for (let i = 0; i < group.length; i += 1) {
      const row = group[i];
      if (i === 0) {
        prepared.push(row);
        continue;
      }
      zoho_id_collisions_cleared += 1;
      prepared.push({
        ...row,
        payload: {
          ...row.payload,
          zoho_id: null,
          data: {
            ...(row.payload.data && typeof row.payload.data === 'object' ? row.payload.data : {}),
            zohoId: '',
          },
        },
      });
    }
  }

  const unique_zoho_ids = byZoho.size;

  return {
    rows: prepared,
    stats: {
      unique_zoho_ids,
      merged_duplicate_rows,
      zoho_id_collisions_cleared,
    },
  };
}

/**
 * Mirror missing legal ↔ trade name; build display name from either, email, or Zoho id.
 * @param {{ legalName?: string, tradeName?: string, email?: string, zohoId?: string, fallbackPrefix?: string }} opts
 */
function resolveLegalTradeNames(opts) {
  const email = String(opts.email || '').trim().toLowerCase();
  const zohoId = String(opts.zohoId || '').trim();
  let legalName = String(opts.legalName || '').trim();
  let tradeName = String(opts.tradeName || '').trim();

  if (tradeName && !legalName) legalName = tradeName;
  if (legalName && !tradeName) tradeName = legalName;

  const prefix = opts.fallbackPrefix || 'Contact';
  const displayName =
    tradeName || legalName || email || (zohoId ? `${prefix} ${zohoId}` : '');

  return { legalName, tradeName, displayName, email, zohoId };
}

/**
 * @param {Record<string, string>} fields
 * @param {string[]} identityKeys
 */
function rowHasMasterIdentity(fields, identityKeys) {
  for (const key of identityKeys) {
    if (String(fields[key] || '').trim()) return true;
  }
  return false;
}

module.exports = {
  MAX_SCAN_ROWS,
  getWorksheetScanEndRow,
  findLastDataRow,
  buildZohoColumnOverlayFromXlsx,
  applyZohoOverlayToFields,
  readZohoContactIdFromCell,
  readZohoContactIdMetaFromCell,
  readZohoIdFromXlsxCell,
  resolveZohoFromExcelFields,
  buildMasterImportFingerprint,
  resolveZohoLookupKey,
  findExistingMasterImportRow,
  readRowFields,
  resolveLegalTradeNames,
  rowHasMasterIdentity,
  prepareMasterImportRows,
};

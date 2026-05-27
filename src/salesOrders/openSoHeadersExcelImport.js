/**
 * POST /api/v1/sales-orders/import-excel
 * Workbook sheet "Open SO Headers" — header-level sales order fields from Zoho export.
 * Line items are not on this sheet; items stay [] until a lines sheet is added later.
 */
const ExcelJS = require('exceljs');
const multer = require('multer');
const { Op } = require('sequelize');
const db = require('../../db');
const SalesOrder = require('./models');
const VendorClient = require('../vendorClient/models');
const { cellToText } = require('../masterBulk/masterExcelFlexibleParse');
const {
  findLastDataRow,
  readRowFields,
  readZohoContactIdMetaFromCell,
  buildZohoColumnOverlayFromXlsx,
} = require('../vendorClient/vendorClientExcelParseUtils');
const {
  toDateOnly,
  mapZohoSoStatus,
} = require('../../scripts/lib/zoho-sales-order-import');

const OPEN_SO_HEADERS_SHEET = 'open so headers';
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_DATA_ROWS = 10000;
const CHUNK_SIZE = 100;
const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

const ZOHO_SO_NUMBER_ALIASES = ['zoho so number', 'zoho sales order number', 'zoho so no'];
const ZOHO_CUSTOMER_ID_ALIASES = ['zoho customer id', 'customer id'];

/** Columns read from "Open SO Headers". Skipped: EI SO Reference, Status (Zoho) read-only, Active Clients flag, Payment Terms Days, SO Subtotal. */
const HEADER_ALIASES = {
  zohoSoNumber: ZOHO_SO_NUMBER_ALIASES,
  customerName: ['customer name'],
  zohoCustomerId: ZOHO_CUSTOMER_ID_ALIASES,
  orderDate: ['order date'],
  expectedShipmentDate: [
    'expected shipment / due date',
    'expected shipment date',
    'expected shipment',
    'due date',
  ],
  salesperson: ['salesperson', 'sales person'],
  placeOfSupply: ['place of supply'],
  gstTreatment: ['gst treatment'],
  gstin: ['gstin (on so)', 'gstin on so', 'gstin'],
  billingAddress: ['billing address'],
  billingCity: ['billing city'],
  billingState: ['billing state'],
  billingCountry: ['billing country'],
  billingPincode: ['billing pincode', 'billing zip', 'billing postal code'],
  billingPhone: ['billing phone'],
  shippingAddress: ['shipping address'],
  shippingCity: ['shipping city', 'shippng city'],
  shippingState: ['shipping state', 'shippng state', 'shipping state'],
  shippingCountry: ['shipping country', 'shippng country', 'shipping country'],
  shippingPincode: ['shipping pincode', 'shippng pincode', 'shipping zip'],
  shippingPhone: ['shipping phone', 'shippng phone'],
  paymentTerms: ['payment terms (raw)', 'payment terms raw', 'payment terms'],
  advancePercent: ['advance %', 'advance percent', 'advance'],
  preShipmentPercent: ['pre-shipment %', 'pre shipment %', 'preshipment %'],
  postShipmentPercent: ['post-shipment %', 'post shipment %', 'postshipment %'],
  creditDays: ['credit days'],
  currency: ['currency'],
  exchangeRate: ['exchange rate'],
  deliveryMethod: ['delivery method'],
  totalQtyOrdered: ['total qty ordered', 'total quantity ordered'],
  totalQtyInvoiced: ['total qty invoiced', 'total quantity invoiced'],
  totalQtyCancelled: ['total qty cancelled', 'total qty canceled', 'total quantity cancelled'],
  openQtyRemaining: ['open qty (remaining)', 'open qty remaining', 'open quantity'],
  zohoStatus: ['status (zoho)', 'status zoho', 'zoho status'],
};

const HEADER_KEYS = Object.keys(HEADER_ALIASES);

const SO_NUMBER_RE = /^SO[-\s]?\d+/i;

function normalizeHeaderLabel(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSheetName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * @param {import('exceljs').Workbook} workbook
 */
function findOpenSoHeadersWorksheet(workbook) {
  for (const ws of workbook.worksheets || []) {
    if (normalizeSheetName(ws.name) === OPEN_SO_HEADERS_SHEET) return ws;
  }
  for (const ws of workbook.worksheets || []) {
    const n = normalizeSheetName(ws.name);
    if (n.includes('open so') && n.includes('header')) return ws;
  }
  return null;
}

/**
 * @param {import('exceljs').Worksheet} worksheet
 * @param {number} [maxScanRow]
 */
function detectOpenSoHeadersColumnMap(worksheet, maxScanRow = 8) {
  const lastCol = Math.min(worksheet.columnCount || 80, 120);
  for (let r = 1; r <= maxScanRow; r += 1) {
    const row = worksheet.getRow(r);
    const map = {};
    for (let c = 1; c <= lastCol; c += 1) {
      const label = normalizeHeaderLabel(cellToText(row.getCell(c)));
      if (!label) continue;
      for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
        if (map[key]) continue;
        if (aliases.some((a) => label === a || label.includes(a) || a.includes(label))) {
          map[key] = c;
        }
      }
    }
    if (map.zohoSoNumber != null) {
      return { headerRow: r, col: map };
    }
  }
  return null;
}

/**
 * @param {import('exceljs').Row} row
 * @param {Record<string, number>} colMap
 */
function readOpenSoHeaderRowFields(row, colMap) {
  const fields = readRowFields(row, colMap, HEADER_KEYS.filter((k) => k !== 'zohoSoNumber' && k !== 'zohoCustomerId'));

  if (colMap.zohoSoNumber) {
    const meta = readZohoContactIdMetaFromCell(row.getCell(colMap.zohoSoNumber));
    fields.zohoSoNumber = meta.id;
    fields.zohoSoNumberReliable = meta.reliable;
    const display = cellToText(row.getCell(colMap.zohoSoNumber));
    if (display && SO_NUMBER_RE.test(display.trim())) {
      fields.zohoSoDisplayNumber = display.trim();
    }
  } else {
    fields.zohoSoNumber = '';
  }

  if (colMap.zohoCustomerId) {
    const meta = readZohoContactIdMetaFromCell(row.getCell(colMap.zohoCustomerId));
    fields.zohoCustomerId = meta.id;
    fields.zohoCustomerIdReliable = meta.reliable;
  } else {
    fields.zohoCustomerId = '';
  }

  return fields;
}

function parseOptionalNumber(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim().replace(/,/g, '');
  if (!s) return null;
  const n = Number(s.replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizeGstTreatment(val) {
  const s = String(val || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (!s) return '';
  if (s === 'business_gst' || s === 'business gst' || s.includes('business_gst')) return 'business_gst';
  if (s === 'business_none' || s === 'business none' || s.includes('business_none')) return 'business_none';
  return String(val).trim();
}

function resolveZohoSoIdFromFields(fields) {
  const raw = String(fields.zohoSoNumber || '')
    .trim()
    .replace(/\s/g, '');
  const display = String(fields.zohoSoDisplayNumber || '').trim();
  if (raw && /^\d{10,22}$/.test(raw)) {
    return { zohoId: raw, displayNumber: display || null, reliable: fields.zohoSoNumberReliable === true };
  }
  if (display && SO_NUMBER_RE.test(display)) {
    return { zohoId: raw || null, displayNumber: display, reliable: false };
  }
  if (raw) return { zohoId: raw, displayNumber: display || null, reliable: false };
  return { zohoId: null, displayNumber: display || null, reliable: false };
}

function rowHasSoIdentity(fields) {
  const { zohoId, displayNumber } = resolveZohoSoIdFromFields(fields);
  return Boolean(zohoId || displayNumber || String(fields.customerName || '').trim());
}

/**
 * @param {Record<string, string|boolean>} fields
 */
function excelFieldsToSalesOrderPayload(fields) {
  const { zohoId, displayNumber } = resolveZohoSoIdFromFields(fields);
  if (!zohoId && !displayNumber) return null;

  const customerName = String(fields.customerName || '').trim() || null;
  const zohoCustomerId = String(fields.zohoCustomerId || '').trim().replace(/\s/g, '') || '';

  let orderId = displayNumber || '';
  if (!orderId && zohoId) orderId = `ZOHO-SO-${zohoId}`;
  if (!orderId) return null;

  const billing = {
    address: String(fields.billingAddress || '').trim() || undefined,
    city: String(fields.billingCity || '').trim() || undefined,
    state: String(fields.billingState || '').trim() || undefined,
    country: String(fields.billingCountry || '').trim() || undefined,
    pincode: String(fields.billingPincode || '').trim() || undefined,
    phone: String(fields.billingPhone || '').trim() || undefined,
  };
  const shipping = {
    address: String(fields.shippingAddress || '').trim() || undefined,
    city: String(fields.shippingCity || '').trim() || undefined,
    state: String(fields.shippingState || '').trim() || undefined,
    country: String(fields.shippingCountry || '').trim() || undefined,
    pincode: String(fields.shippingPincode || '').trim() || undefined,
    phone: String(fields.shippingPhone || '').trim() || undefined,
  };

  const zohoStatus = String(fields.zohoStatus || '').trim();
  const qtyOrdered = parseOptionalNumber(fields.totalQtyOrdered);
  const qtyInvoiced = parseOptionalNumber(fields.totalQtyInvoiced);
  const qtyCancelled = parseOptionalNumber(fields.totalQtyCancelled);
  const qtyOpen = parseOptionalNumber(fields.openQtyRemaining);

  const form_data = {
    source: 'excel_open_so_headers',
    orderId,
    customerName: customerName || '',
    orderDate: toDateOnly(fields.orderDate) || '',
    expectedShipmentDate: toDateOnly(fields.expectedShipmentDate) || '',
    paymentTerms: String(fields.paymentTerms || '').trim() || '',
    deliveryMethod: String(fields.deliveryMethod || '').trim() || '',
    salespersonName: String(fields.salesperson || '').trim() || '',
    placeOfSupply: String(fields.placeOfSupply || '').trim() || '',
    gstTreatment: normalizeGstTreatment(fields.gstTreatment),
    gstin: String(fields.gstin || '').trim() || '',
    billingAddress: billing.address || '',
    billingCity: billing.city || '',
    billingState: billing.state || '',
    billingCountry: billing.country || '',
    billingPincode: billing.pincode || '',
    billingPhone: billing.phone || '',
    shippingAddress: shipping.address || '',
    shippingCity: shipping.city || '',
    shippingState: shipping.state || '',
    shippingCountry: shipping.country || '',
    shippingPincode: shipping.pincode || '',
    shippingPhone: shipping.phone || '',
    currencyCode: String(fields.currency || '').trim() || '',
    exchangeRate: parseOptionalNumber(fields.exchangeRate) ?? undefined,
    advancePercent: parseOptionalNumber(fields.advancePercent) ?? undefined,
    preShipmentPercent: parseOptionalNumber(fields.preShipmentPercent) ?? undefined,
    postShipmentPercent: parseOptionalNumber(fields.postShipmentPercent) ?? undefined,
    creditDays: parseOptionalNumber(fields.creditDays) ?? undefined,
    zohoStatus,
  };

  if (zohoId) {
    form_data.zohoSalesorderId = zohoId;
    if (fields.zohoSoNumberReliable === false) {
      form_data.zohoSalesorderIdUnreliable = true;
    }
  }
  if (displayNumber) {
    form_data.zohoSalesorderNumber = displayNumber;
  } else if (SO_NUMBER_RE.test(orderId)) {
    form_data.zohoSalesorderNumber = orderId;
  }
  if (zohoCustomerId) {
    form_data.zohoCustomerId = zohoCustomerId;
    if (fields.zohoCustomerIdReliable === false) {
      form_data.zohoCustomerIdUnreliable = true;
    }
  }

  const order_status = {
    orderStatus: zohoStatus,
    deliveryMethod: String(fields.deliveryMethod || '').trim() || '',
    quantity: qtyOrdered ?? undefined,
    quantityInvoiced: qtyInvoiced ?? undefined,
    quantityCancelled: qtyCancelled ?? undefined,
    quantityOpen: qtyOpen ?? undefined,
  };

  return {
    order_id: orderId,
    customer_name: customerName,
    order_date: toDateOnly(fields.orderDate),
    expected_shipment_date: toDateOnly(fields.expectedShipmentDate),
    payment_terms: String(fields.paymentTerms || '').trim() || null,
    status: mapZohoSoStatus(zohoStatus, zohoStatus),
    order_status,
    form_data,
    items: [],
  };
}

/**
 * @param {import('exceljs').Workbook} workbook
 * @param {Buffer} [buffer]
 */
function parseOpenSoHeadersWorkbook(workbook, buffer) {
  const worksheet = findOpenSoHeadersWorksheet(workbook);
  if (!worksheet) {
    throw new Error('Worksheet "Open SO Headers" not found');
  }

  const layout = detectOpenSoHeadersColumnMap(worksheet);
  if (!layout) {
    throw new Error('Could not detect header row (need column "Zoho SO Number")');
  }

  const { headerRow, col: colMap } = layout;
  const zohoOverlay = buffer
    ? buildZohoColumnOverlayFromXlsx(buffer, worksheet.name, ZOHO_SO_NUMBER_ALIASES)
    : { byRow: {}, unreliableCount: 0 };

  const lastDataRow = findLastDataRow(worksheet, headerRow, (row) => {
    const f = readOpenSoHeaderRowFields(row, colMap);
    return rowHasSoIdentity(f);
  });

  const rows = [];
  let skippedNoIdentity = 0;

  const customerOverlay = buffer
    ? buildZohoColumnOverlayFromXlsx(buffer, worksheet.name, ZOHO_CUSTOMER_ID_ALIASES)
    : { byRow: {}, unreliableCount: 0 };

  for (let r = headerRow + 1; r <= lastDataRow; r += 1) {
    const fields = readOpenSoHeaderRowFields(worksheet.getRow(r), colMap);
    if (zohoOverlay.byRow?.[r]?.id) {
      fields.zohoSoNumber = zohoOverlay.byRow[r].id;
      fields.zohoSoNumberReliable = zohoOverlay.byRow[r].reliable;
    }
    if (customerOverlay.byRow?.[r]?.id) {
      fields.zohoCustomerId = customerOverlay.byRow[r].id;
      fields.zohoCustomerIdReliable = customerOverlay.byRow[r].reliable;
    }

    if (!rowHasSoIdentity(fields)) {
      skippedNoIdentity += 1;
      continue;
    }

    const payload = excelFieldsToSalesOrderPayload(fields);
    if (!payload) {
      skippedNoIdentity += 1;
      continue;
    }

    rows.push({ excel_row: r, sheet_name: worksheet.name, payload, fields });
  }

  return {
    rows,
    sheetName: worksheet.name,
    headerRow,
    parseStats: {
      scanned_through_row: lastDataRow,
      skipped_no_identity: skippedNoIdentity,
      zoho_overlay_unreliable: zohoOverlay.unreliableCount ?? 0,
    },
  };
}

async function extractOpenSoHeadersFromBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return parseOpenSoHeadersWorkbook(workbook, buffer);
}

async function findByZohoSalesorderId(zohoId) {
  if (!zohoId) return null;
  const [found] = await db.query(
    `SELECT id FROM sales_orders WHERE (form_data->>'zohoSalesorderId') = :zid LIMIT 1`,
    { replacements: { zid: zohoId } }
  );
  const id = found && found[0] && found[0].id;
  if (!id) return null;
  return SalesOrder.findByPk(id);
}

async function resolveClientForZohoCustomer(zohoCustomerId, customerName) {
  const zid = String(zohoCustomerId || '').trim();
  if (zid) {
    const byZoho = await VendorClient.findOne({
      where: { type: 'client', zoho_id: zid },
    });
    if (byZoho) return byZoho;
  }
  const cn = String(customerName || '').trim();
  if (!cn) return null;
  let row = await VendorClient.findOne({ where: { type: 'client', name: cn } });
  if (!row) {
    row = await VendorClient.findOne({
      where: { type: 'client', name: { [Op.iLike]: cn } },
    });
  }
  return row;
}

async function allocateUniqueOrderId(preferredOrderId, zohoId, selfId) {
  let candidate = preferredOrderId;
  let n = 0;
  for (let guard = 0; guard < 5000; guard += 1) {
    const other = await SalesOrder.findOne({ where: { order_id: candidate } });
    if (!other) return candidate;
    const plain = other.get ? other.get({ plain: true }) : other;
    const otherZoho =
      plain.form_data &&
      typeof plain.form_data === 'object' &&
      plain.form_data.zohoSalesorderId != null
        ? String(plain.form_data.zohoSalesorderId)
        : '';
    if (selfId != null && plain.id === selfId) return candidate;
    if (zohoId && otherZoho === zohoId) return candidate;
    n += 1;
    candidate = `${preferredOrderId}-Z-${zohoId || 'dup'}-${n}`;
  }
  throw new Error(`Could not allocate unique order_id for ${preferredOrderId}`);
}

/**
 * @param {ReturnType<typeof excelFieldsToSalesOrderPayload>} payload
 * @param {string} createdBy
 */
async function enrichPayloadWithClient(payload, createdBy) {
  const fd = payload.form_data || {};
  const zohoCustomerId = fd.zohoCustomerId != null ? String(fd.zohoCustomerId) : '';
  const clientRow = await resolveClientForZohoCustomer(zohoCustomerId, payload.customer_name);
  const clientPlain = clientRow && clientRow.get ? clientRow.get({ plain: true }) : clientRow;

  if (clientPlain && clientPlain.id) {
    fd.vendorClientId = clientPlain.id;
    fd.clientId = clientPlain.id;
    if (clientPlain.entity_code) fd.clientEntityCode = clientPlain.entity_code;
    if (clientPlain.name) {
      payload.customer_name = clientPlain.name;
      fd.customerName = clientPlain.name;
    }
  }

  payload.form_data = fd;
  payload.created_by = createdBy;
  return payload;
}

/**
 * @param {Array<{ excel_row: number, payload: object }>} importRows
 * @param {{ details?: boolean, createdBy?: string }} opts
 */
async function executeOpenSoHeadersImportRows(importRows, opts = {}) {
  const details = !!opts.details;
  const createdBy = opts.createdBy || 'Open SO Headers import';

  const summary = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    row_log: [],
  };

  for (const entry of importRows) {
    const logBase = { excel_row: entry.excel_row, sheet: entry.sheet_name };
    try {
      let payload = { ...entry.payload };
      await enrichPayloadWithClient(payload, createdBy);

      const zohoId =
        payload.form_data && payload.form_data.zohoSalesorderId
          ? String(payload.form_data.zohoSalesorderId)
          : '';

      let existing = zohoId ? await findByZohoSalesorderId(zohoId) : null;
      if (!existing && payload.order_id) {
        existing = await SalesOrder.findOne({ where: { order_id: payload.order_id } });
      }

      payload.order_id = await allocateUniqueOrderId(
        payload.order_id,
        zohoId,
        existing ? existing.id : null
      );
      payload.form_data.orderId = payload.order_id;

      if (existing) {
        const prevFd = existing.get('form_data');
        const mergedFd =
          prevFd && typeof prevFd === 'object' && !Array.isArray(prevFd)
            ? { ...prevFd, ...payload.form_data }
            : payload.form_data;
        const prevOs = existing.get('order_status');
        const mergedOs =
          prevOs && typeof prevOs === 'object' && !Array.isArray(prevOs)
            ? { ...prevOs, ...payload.order_status }
            : payload.order_status;

        await existing.update({
          customer_name: payload.customer_name ?? existing.customer_name,
          order_date: payload.order_date ?? existing.order_date,
          expected_shipment_date:
            payload.expected_shipment_date ?? existing.expected_shipment_date,
          payment_terms: payload.payment_terms ?? existing.payment_terms,
          status: payload.status ?? existing.status,
          order_status: mergedOs,
          form_data: mergedFd,
        });

        summary.updated += 1;
        if (details) {
          summary.row_log.push({
            ...logBase,
            action: 'updated',
            order_id: existing.order_id,
            zoho_salesorder_id: zohoId || undefined,
          });
        }
        continue;
      }

      if (!zohoId && !payload.order_id) {
        summary.skipped += 1;
        if (details) {
          summary.row_log.push({
            ...logBase,
            action: 'skipped',
            reason: 'Missing Zoho SO id and order number',
          });
        }
        continue;
      }

      const row = await SalesOrder.create(payload);
      summary.created += 1;
      if (details) {
        summary.row_log.push({
          ...logBase,
          action: 'created',
          order_id: row.order_id,
          zoho_salesorder_id: zohoId || undefined,
        });
      }
    } catch (err) {
      summary.errors += 1;
      if (details) {
        summary.row_log.push({
          ...logBase,
          action: 'error',
          reason: err.message || String(err),
        });
      }
    }
  }

  return summary;
}

async function postOpenSoHeadersExcelImport(req, res) {
  try {
    if (!req.user) return res.sendStatus(401);
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Expected multipart file field "file" (.xlsx or .xlsm)' });
    }

    const details =
      req.query.details === '1' || req.query.details === 'true' || req.body?.details === true;

    let parsed;
    try {
      parsed = await extractOpenSoHeadersFromBuffer(req.file.buffer);
    } catch (loadErr) {
      console.error('[open-so-headers-excel] parse error', loadErr);
      return res.status(400).json({ error: loadErr.message || 'Invalid Excel file' });
    }

    const { rows, sheetName, headerRow, parseStats } = parsed;
    if (!rows.length) {
      return res.status(400).json({
        error: 'No sales order rows found on "Open SO Headers". Need Zoho SO Number or customer name.',
        sheet: sheetName,
        header_row: headerRow,
      });
    }
    if (rows.length > MAX_DATA_ROWS) {
      return res.status(400).json({ error: `At most ${MAX_DATA_ROWS} data rows per file` });
    }

    const createdBy =
      req.user.fullName || req.user.email || req.user.name || 'Open SO Headers import';

    const aggregated = {
      created: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      row_log: [],
    };

    const importRows = rows.map((r) => ({
      excel_row: r.excel_row,
      sheet_name: r.sheet_name,
      payload: r.payload,
    }));

    for (let offset = 0; offset < importRows.length; offset += CHUNK_SIZE) {
      const slice = importRows.slice(offset, offset + CHUNK_SIZE);
      const part = await executeOpenSoHeadersImportRows(slice, { details, createdBy });
      aggregated.created += part.created;
      aggregated.updated += part.updated;
      aggregated.skipped += part.skipped;
      aggregated.errors += part.errors;
      if (details && part.row_log?.length) aggregated.row_log.push(...part.row_log);
    }

    return res.json({
      ok: true,
      rows_total: rows.length,
      rows_imported: importRows.length,
      sheet: sheetName,
      header_row: headerRow,
      parse_stats: parseStats ?? null,
      summary: {
        sales_orders_created: aggregated.created,
        sales_orders_updated: aggregated.updated,
        skipped: aggregated.skipped,
        errors: aggregated.errors,
      },
      ...(details ? { row_log: aggregated.row_log } : {}),
    });
  } catch (err) {
    console.error('[open-so-headers-excel] import error', err);
    return res.status(500).json({ error: err.message || 'Open SO Headers import failed' });
  }
}

const uploadOpenSoHeadersExcelMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    const name = String(file?.originalname || '').toLowerCase();
    const okName = name.endsWith('.xlsx') || name.endsWith('.xlsm');
    const okMime = !file?.mimetype || ALLOWED_MIME.has(file.mimetype);
    if (okName && okMime) return cb(null, true);
    cb(new Error('Only .xlsx / .xlsm files are accepted'));
  },
}).single('file');

function uploadOpenSoHeadersExcelSafe(req, res, next) {
  uploadOpenSoHeadersExcelMiddleware(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    return next();
  });
}

module.exports = {
  OPEN_SO_HEADERS_SHEET,
  HEADER_ALIASES,
  normalizeSheetName,
  findOpenSoHeadersWorksheet,
  detectOpenSoHeadersColumnMap,
  excelFieldsToSalesOrderPayload,
  parseOpenSoHeadersWorkbook,
  extractOpenSoHeadersFromBuffer,
  executeOpenSoHeadersImportRows,
  uploadOpenSoHeadersExcelSafe,
  postOpenSoHeadersExcelImport,
};

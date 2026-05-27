/**
 * POST /api/v1/sales-orders/import-excel
 * Workbook sheets:
 * - "Open SO Headers": header-level sales order fields.
 * - "Open SO Lines": item-level rows linked by Zoho SO id / number.
 */
const ExcelJS = require('exceljs');
const multer = require('multer');
const { Op } = require('sequelize');
const db = require('../../db');
const SalesOrder = require('./models');
const VendorClient = require('../vendorClient/models');
const { FulfillmentOrder, FulfillmentOrderItem } = require('../fulfillment/models');
const { cellToText } = require('../masterBulk/masterExcelFlexibleParse');
const {
  readRowFields,
  readZohoContactIdMetaFromCell,
  buildZohoColumnOverlayFromXlsx,
} = require('../vendorClient/vendorClientExcelParseUtils');
const {
  toDateOnly,
  mapZohoSoStatus,
} = require('../../scripts/lib/zoho-sales-order-import');

const OPEN_SO_HEADERS_SHEET = 'open so headers';
const OPEN_SO_LINES_SHEET = 'open so lines';
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_DATA_ROWS = 200000;
const CHUNK_SIZE = 100;
const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

const ZOHO_SO_NUMBER_ALIASES = ['zoho so number', 'zoho sales order number', 'zoho so no'];
const ZOHO_SO_ID_ALIASES = ['zoho so id', 'zoho sales order id', 'salesorder id'];
const ZOHO_CUSTOMER_ID_ALIASES = ['zoho customer id', 'customer id'];

/** Columns read from "Open SO Headers". */
const HEADER_ALIASES = {
  eiSoReference: ['ei so reference', 'ei so reference (reference#)', 'reference#', 'reference'],
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
const LINE_HEADER_ALIASES = {
  eiSoReference: ['ei so reference', 'ei so reference (reference#)', 'reference#', 'reference'],
  zohoSoNumber: ZOHO_SO_NUMBER_ALIASES,
  zohoSoId: ZOHO_SO_ID_ALIASES,
  zohoCustomerId: ZOHO_CUSTOMER_ID_ALIASES,
  customerName: ['customer name'],
  zohoStatus: ['status (zoho)', 'status zoho', 'zoho status'],
  productName: [
    'product(item name)',
    'product (item name)',
    'item name',
    'product name',
    'product',
    'item',
    'description',
  ],
  sku: ['sku'],
  zohoProductId: ['product id (zoho)', 'zoho product id', 'item id'],
  hsnSac: ['hsn/sac', 'hsn', 'sac'],
  packSize: ['pack size', 'pack'],
  qtyOrdered: ['qty ordered', 'quantity ordered', 'qty', 'quantity', 'order qty', 'ordered qty'],
  qtyInvoiced: ['qty invoiced', 'quantity invoiced'],
  qtyCancelled: ['qty cancelled', 'qty canceled', 'quantity cancelled'],
  openQtyRemaining: ['open qty (remaining)', 'open qty remaining', 'open quantity', 'open qty', 'balance qty', 'pending qty'],
  uom: ['uom', 'unit'],
  unitPrice: ['unit price (₹)', 'unit price', 'rate', 'unit rate', 'price'],
  itemTotal: ['item total', 'line total'],
  taxPercent: ['tax %', 'tax percent'],
  taxAmount: ['tax amount'],
  cgstRatePercent: ['cgst rate %'],
  sgstRatePercent: ['sgst rate %'],
  igstRatePercent: ['igst rate %'],
  cgstAmount: ['cgst'],
  sgstAmount: ['sgst'],
  igstAmount: ['igst'],
};
const LINE_HEADER_KEYS = Object.keys(LINE_HEADER_ALIASES);

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
 * Scan full visible worksheet bounds so late rows are not missed.
 * @param {import('exceljs').Worksheet} worksheet
 * @param {number} headerRow
 */
function getWorksheetEndRow(worksheet, headerRow) {
  const bottom = Number(worksheet.dimensions?.bottom ?? 0);
  const reported = Number(worksheet.rowCount || worksheet.actualRowCount || 0);
  return Math.max(bottom, reported, headerRow + 1);
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
 * @param {import('exceljs').Workbook} workbook
 */
function findOpenSoLinesWorksheet(workbook) {
  for (const ws of workbook.worksheets || []) {
    if (normalizeSheetName(ws.name) === OPEN_SO_LINES_SHEET) return ws;
  }
  for (const ws of workbook.worksheets || []) {
    const n = normalizeSheetName(ws.name);
    if (n.includes('open so') && n.includes('line')) return ws;
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
 * @param {import('exceljs').Worksheet} worksheet
 * @param {number} [maxScanRow]
 */
function detectOpenSoLinesColumnMap(worksheet, maxScanRow = 8) {
  const lastCol = Math.min(worksheet.columnCount || 100, 160);
  for (let r = 1; r <= maxScanRow; r += 1) {
    const row = worksheet.getRow(r);
    const map = {};
    for (let c = 1; c <= lastCol; c += 1) {
      const label = normalizeHeaderLabel(cellToText(row.getCell(c)));
      if (!label) continue;
      for (const [key, aliases] of Object.entries(LINE_HEADER_ALIASES)) {
        if (map[key]) continue;
        if (aliases.some((a) => label === a || label.includes(a) || a.includes(label))) {
          map[key] = c;
        }
      }
    }
    if ((map.zohoSoId != null || map.zohoSoNumber != null || map.eiSoReference != null) && map.productName != null) {
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
  if (raw && SO_NUMBER_RE.test(raw)) {
    return { zohoId: null, displayNumber: raw, reliable: false };
  }
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

function cleanDigitsOrText(value) {
  return String(value || '').trim().replace(/\s/g, '');
}

function normalizeEiSoReference(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function normalizeSoKey(key) {
  return String(key || '').trim().toUpperCase();
}

function buildSoLookupKeys(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const keys = new Set();
  const upper = raw.toUpperCase();
  keys.add(upper);
  keys.add(upper.replace(/^'+/, ''));
  keys.add(upper.replace(/\s+/g, ''));
  keys.add(upper.replace(/[^A-Z0-9]/g, ''));
  const m = upper.match(/^SO[\s-]*([0-9]+)$/);
  if (m && m[1]) {
    keys.add(`SO-${m[1]}`);
    keys.add(`SO${m[1]}`);
  }
  return [...keys].filter(Boolean);
}

/**
 * @param {Record<string, string|boolean>} fields
 */
function resolveSoKeyFromLineFields(fields) {
  const zohoSoId = cleanDigitsOrText(fields.zohoSoId);
  if (/^\d{10,22}$/.test(zohoSoId)) return { soKey: normalizeSoKey(zohoSoId), type: 'zohoId' };
  if (SO_NUMBER_RE.test(zohoSoId)) return { soKey: normalizeSoKey(zohoSoId), type: 'orderId' };
  const zohoSoNo = cleanDigitsOrText(fields.zohoSoNumber);
  if (zohoSoNo) return { soKey: normalizeSoKey(zohoSoNo), type: 'orderId' };
  return { soKey: '', type: '' };
}

function extractLineLookupKeys(fields) {
  const keys = new Set();
  const soIdRaw = cleanDigitsOrText(fields.zohoSoId);
  const soNoRaw = cleanDigitsOrText(fields.zohoSoNumber);
  const soDisplayRaw = cleanDigitsOrText(fields.zohoSoDisplayNumber);
  [soIdRaw, soNoRaw, soDisplayRaw].forEach((v) => {
    for (const k of buildSoLookupKeys(v)) keys.add(k);
  });
  return [...keys];
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
  const eiSoReference = normalizeEiSoReference(fields.eiSoReference);
  if (eiSoReference) {
    form_data.eiSoReference = eiSoReference;
  }

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
 * @param {import('exceljs').Row} row
 * @param {Record<string, number>} colMap
 */
function readOpenSoLineRowFields(row, colMap) {
  const fields = readRowFields(
    row,
    colMap,
    LINE_HEADER_KEYS.filter((k) => k !== 'zohoSoNumber' && k !== 'zohoSoId' && k !== 'zohoCustomerId')
  );

  const soNoMeta = colMap.zohoSoNumber
    ? readZohoContactIdMetaFromCell(row.getCell(colMap.zohoSoNumber))
    : { id: '', reliable: false };
  fields.zohoSoNumber = soNoMeta.id;
  fields.zohoSoNumberReliable = soNoMeta.reliable;
  const soDisplay = colMap.zohoSoNumber ? String(cellToText(row.getCell(colMap.zohoSoNumber))).trim() : '';
  if (soDisplay && SO_NUMBER_RE.test(soDisplay)) fields.zohoSoDisplayNumber = soDisplay;

  const soIdMeta = colMap.zohoSoId
    ? readZohoContactIdMetaFromCell(row.getCell(colMap.zohoSoId))
    : { id: '', reliable: false };
  fields.zohoSoId = soIdMeta.id;
  fields.zohoSoIdReliable = soIdMeta.reliable;

  const custMeta = colMap.zohoCustomerId
    ? readZohoContactIdMetaFromCell(row.getCell(colMap.zohoCustomerId))
    : { id: '', reliable: false };
  fields.zohoCustomerId = custMeta.id;
  fields.zohoCustomerIdReliable = custMeta.reliable;

  return fields;
}

/**
 * @param {Record<string, string|boolean>} fields
 */
function excelLineFieldsToItem(fields) {
  const qty = parseOptionalNumber(fields.qtyOrdered) ?? 0;
  const unitPrice = parseOptionalNumber(fields.unitPrice) ?? 0;
  const taxPercent = parseOptionalNumber(fields.taxPercent);
  const item = {
    sku: String(fields.sku || '').trim(),
    productName: String(fields.productName || '').trim() || 'Line item',
    pack: String(fields.packSize || '').trim(),
    quantity: qty,
    unitPrice,
    orderedQty: qty,
    invoicedQty: parseOptionalNumber(fields.qtyInvoiced) ?? undefined,
    cancelledQty: parseOptionalNumber(fields.qtyCancelled) ?? undefined,
    openQty: parseOptionalNumber(fields.openQtyRemaining) ?? undefined,
    uom: String(fields.uom || '').trim() || undefined,
    itemTotal: parseOptionalNumber(fields.itemTotal) ?? undefined,
    taxPercent: taxPercent ?? undefined,
    taxAmount: parseOptionalNumber(fields.taxAmount) ?? undefined,
    cgstRatePercent: parseOptionalNumber(fields.cgstRatePercent) ?? undefined,
    sgstRatePercent: parseOptionalNumber(fields.sgstRatePercent) ?? undefined,
    igstRatePercent: parseOptionalNumber(fields.igstRatePercent) ?? undefined,
    cgstAmount: parseOptionalNumber(fields.cgstAmount) ?? undefined,
    sgstAmount: parseOptionalNumber(fields.sgstAmount) ?? undefined,
    igstAmount: parseOptionalNumber(fields.igstAmount) ?? undefined,
  };
  const zohoProductId = cleanDigitsOrText(fields.zohoProductId);
  if (zohoProductId) item.zohoItemId = zohoProductId;
  const hsnSac = String(fields.hsnSac || '').trim();
  if (hsnSac) item.hsnCode = hsnSac;
  return item;
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

  const lastDataRow = getWorksheetEndRow(worksheet, headerRow);

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

/**
 * @param {import('exceljs').Workbook} workbook
 * @param {Buffer} [buffer]
 */
function parseOpenSoLinesWorkbook(workbook, buffer) {
  const worksheet = findOpenSoLinesWorksheet(workbook);
  if (!worksheet) {
    return {
      rows: [],
      sheetName: null,
      headerRow: null,
      parseStats: { scanned_through_row: 0, skipped_no_identity: 0, zoho_overlay_unreliable: 0 },
    };
  }

  const layout = detectOpenSoLinesColumnMap(worksheet);
  if (!layout) {
    throw new Error('Could not detect "Open SO Lines" columns');
  }

  const { headerRow, col: colMap } = layout;
  const soIdOverlay = buffer
    ? buildZohoColumnOverlayFromXlsx(buffer, worksheet.name, ZOHO_SO_ID_ALIASES)
    : { byRow: {}, unreliableCount: 0 };
  const soNoOverlay = buffer
    ? buildZohoColumnOverlayFromXlsx(buffer, worksheet.name, ZOHO_SO_NUMBER_ALIASES)
    : { byRow: {}, unreliableCount: 0 };
  const customerOverlay = buffer
    ? buildZohoColumnOverlayFromXlsx(buffer, worksheet.name, ZOHO_CUSTOMER_ID_ALIASES)
    : { byRow: {}, unreliableCount: 0 };

  const lastDataRow = getWorksheetEndRow(worksheet, headerRow);

  const rows = [];
  let skippedNoIdentity = 0;
  for (let r = headerRow + 1; r <= lastDataRow; r += 1) {
    const fields = readOpenSoLineRowFields(worksheet.getRow(r), colMap);
    if (soIdOverlay.byRow?.[r]?.id) {
      fields.zohoSoId = soIdOverlay.byRow[r].id;
      fields.zohoSoIdReliable = soIdOverlay.byRow[r].reliable;
    }
    if (soNoOverlay.byRow?.[r]?.id) {
      fields.zohoSoNumber = soNoOverlay.byRow[r].id;
      fields.zohoSoNumberReliable = soNoOverlay.byRow[r].reliable;
    }
    if (customerOverlay.byRow?.[r]?.id) {
      fields.zohoCustomerId = customerOverlay.byRow[r].id;
      fields.zohoCustomerIdReliable = customerOverlay.byRow[r].reliable;
    }

    const { soKey } = resolveSoKeyFromLineFields(fields);
    const soKeys = extractLineLookupKeys(fields);
    const refKey = normalizeEiSoReference(fields.eiSoReference);
    if (!soKey && !soKeys.length && !refKey) {
      skippedNoIdentity += 1;
      continue;
    }
    const item = excelLineFieldsToItem(fields);
    rows.push({
      excel_row: r,
      sheet_name: worksheet.name,
      so_key: soKey,
      so_keys: soKeys,
      item,
      fields,
    });
  }

  return {
    rows,
    sheetName: worksheet.name,
    headerRow,
    parseStats: {
      scanned_through_row: lastDataRow,
      skipped_no_identity: skippedNoIdentity,
      zoho_overlay_unreliable:
        (soIdOverlay.unreliableCount ?? 0) + (soNoOverlay.unreliableCount ?? 0),
    },
  };
}

function groupItemsBySoKey(lineRows) {
  const out = new Map();
  for (const row of lineRows || []) {
    const keys = Array.isArray(row.so_keys) && row.so_keys.length
      ? row.so_keys
      : buildSoLookupKeys(row.so_key);
    if (!keys.length) continue;
    for (const key of keys) {
      const list = out.get(key) || [];
      list.push(row.item);
      out.set(key, list);
    }
  }
  return out;
}

function groupItemsByEiSoReference(lineRows) {
  const out = new Map();
  for (const row of lineRows || []) {
    const ref = normalizeEiSoReference(row.fields?.eiSoReference);
    if (!ref) continue;
    const list = out.get(ref) || [];
    list.push(row.item);
    out.set(ref, list);
  }
  return out;
}

async function extractOpenSoHeadersFromBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return parseOpenSoHeadersWorkbook(workbook, buffer);
}

async function extractOpenSoWorkbookFromBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const headers = parseOpenSoHeadersWorkbook(workbook, buffer);
  const lines = parseOpenSoLinesWorkbook(workbook, buffer);
  return { headers, lines };
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

function toDateOnlySafe(value) {
  const v = toDateOnly(value);
  return typeof v === 'string' && v.trim() ? v : null;
}

function mapPriorityFromSoStatus(statusRaw) {
  const s = String(statusRaw || '').trim().toLowerCase();
  if (s.includes('urgent') || s.includes('high')) return 'high';
  return 'normal';
}

function buildFulfillmentOrderPatchFromSalesPayload(payload, salesOrderId) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const soValue = items.reduce((sum, line) => {
    const qty = Number(line.quantity ?? line.orderedQty ?? 0) || 0;
    const unitPrice = Number(line.unitPrice ?? line.rate ?? 0) || 0;
    return sum + (qty * unitPrice);
  }, 0);
  return {
    so_no: String(payload.order_id || '').trim(),
    sales_order_id: salesOrderId,
    customer_name: String(payload.customer_name || '').trim() || 'Unknown Customer',
    customer_city: String(payload.form_data?.shippingCity || payload.form_data?.billingCity || '').trim() || null,
    order_date: toDateOnlySafe(payload.order_date),
    due_date: toDateOnlySafe(payload.expected_shipment_date),
    priority: mapPriorityFromSoStatus(payload.status),
    so_status: 'planned',
    so_value: Number.isFinite(soValue) ? soValue : 0,
    ship_address: String(payload.form_data?.shippingAddress || '').trim() || null,
    payment_terms: String(payload.payment_terms || payload.form_data?.paymentTerms || '').trim() || null,
    notes: 'Synced from Open SO Headers Excel import',
  };
}

function mapSoItemsToFulfillmentItems(itemsInput) {
  const items = Array.isArray(itemsInput) ? itemsInput : [];
  return items.map((line, idx) => {
    const qtyRaw = Number(line.quantity ?? line.orderedQty ?? 0);
    const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.round(qtyRaw) : 0;
    const price = Number(line.unitPrice ?? line.rate ?? 0) || 0;
    return {
      item_no: String(line.itemNo || idx + 1),
      sku: String(line.sku || '').trim() || null,
      product_name: String(line.productName || line.name || `Item ${idx + 1}`).trim(),
      pack: String(line.pack || '').trim() || null,
      ordered_qty: qty,
      rate: price,
      unit_price: price,
    };
  });
}

async function upsertFulfillmentFromSalesOrderPayload(salesOrderRow, payload) {
  if (!salesOrderRow || !payload?.order_id) return;
  const patch = buildFulfillmentOrderPatchFromSalesPayload(payload, salesOrderRow.id);
  const soNo = String(patch.so_no || '').trim();
  if (!soNo) return;

  let ff = await FulfillmentOrder.findOne({ where: { sales_order_id: salesOrderRow.id } });
  if (!ff) {
    ff = await FulfillmentOrder.findOne({ where: { so_no: soNo } });
  }

  if (ff) {
    await ff.update(patch);
  } else {
    ff = await FulfillmentOrder.create(patch);
  }

  const existingItemCount = await FulfillmentOrderItem.count({
    where: { fulfillment_order_id: ff.id },
  });

  // Preserve active fulfillment workflows: seed items only when missing.
  if (existingItemCount > 0) return;

  const salesOrderPlain = salesOrderRow.get ? salesOrderRow.get({ plain: true }) : salesOrderRow;
  const payloadItems = Array.isArray(payload?.items) ? payload.items : [];
  const persistedItems = Array.isArray(salesOrderPlain?.items) ? salesOrderPlain.items : [];
  const sourceItems = payloadItems.length > 0 ? payloadItems : persistedItems;

  const ffItems = mapSoItemsToFulfillmentItems(sourceItems)
    .filter((it) => it.ordered_qty > 0);
  if (ffItems.length === 0) return;

  await FulfillmentOrderItem.bulkCreate(
    ffItems.map((it) => ({ ...it, fulfillment_order_id: ff.id }))
  );
}

/**
 * @param {Array<{ excel_row: number, payload: object }>} importRows
 * @param {{ details?: boolean, createdBy?: string }} opts
 */
async function executeOpenSoHeadersImportRows(importRows, opts = {}) {
  const details = !!opts.details;
  const createdBy = opts.createdBy || 'Open SO Headers import';
  const itemsBySoKey = opts.itemsBySoKey instanceof Map ? opts.itemsBySoKey : new Map();
  const itemsByEiSoReference =
    opts.itemsByEiSoReference instanceof Map ? opts.itemsByEiSoReference : new Map();

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
      const soKeyFromZohoId = normalizeSoKey(
        payload.form_data && payload.form_data.zohoSalesorderId
          ? String(payload.form_data.zohoSalesorderId)
          : ''
      );
      const soKeyFromOrderId = normalizeSoKey(payload.order_id);
      const refKey = normalizeEiSoReference(entry.ei_so_reference);
      let importedItems = null;
      if (refKey && itemsByEiSoReference.has(refKey)) {
        importedItems = itemsByEiSoReference.get(refKey);
      }
      const lookupKeys = [
        ...buildSoLookupKeys(soKeyFromZohoId),
        ...buildSoLookupKeys(soKeyFromOrderId),
      ];
      if (!importedItems) {
        for (const lk of lookupKeys) {
          const hit = itemsBySoKey.get(lk);
          if (Array.isArray(hit) && hit.length > 0) {
            importedItems = hit;
            break;
          }
        }
      }
      if (Array.isArray(importedItems) && importedItems.length > 0) {
        payload.items = importedItems;
      }

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

        const mergedItems =
          Array.isArray(payload.items) && payload.items.length > 0
            ? payload.items
            : Array.isArray(existing.items)
              ? existing.items
              : [];
        await existing.update({
          customer_name: payload.customer_name ?? existing.customer_name,
          order_date: payload.order_date ?? existing.order_date,
          expected_shipment_date:
            payload.expected_shipment_date ?? existing.expected_shipment_date,
          payment_terms: payload.payment_terms ?? existing.payment_terms,
          status: payload.status ?? existing.status,
          order_status: mergedOs,
          form_data: mergedFd,
          items: mergedItems,
        });
        payload.items = mergedItems;
        await upsertFulfillmentFromSalesOrderPayload(existing, payload);

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
      await upsertFulfillmentFromSalesOrderPayload(row, payload);
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
      parsed = await extractOpenSoWorkbookFromBuffer(req.file.buffer);
    } catch (loadErr) {
      console.error('[open-so-headers-excel] parse error', loadErr);
      return res.status(400).json({ error: loadErr.message || 'Invalid Excel file' });
    }

    const { headers, lines } = parsed;
    const { rows, sheetName, headerRow, parseStats } = headers;
    if (!lines.sheetName) {
      return res.status(400).json({
        error: 'Worksheet "Open SO Lines" not found. SKU/product rows are required for import.',
      });
    }
    if (!lines.rows.length) {
      return res.status(400).json({
        error:
          'No line rows parsed from "Open SO Lines". Please verify line headers (SKU, Product, Qty Ordered, Zoho SO Number/ID).',
        sheet: lines.sheetName,
        header_row: lines.headerRow,
        lines_parse_stats: lines.parseStats ?? null,
      });
    }
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
      ei_so_reference: r.fields?.eiSoReference || '',
    }));
    const itemsBySoKey = groupItemsBySoKey(lines.rows);
    const itemsByEiSoReference = groupItemsByEiSoReference(lines.rows);

    for (let offset = 0; offset < importRows.length; offset += CHUNK_SIZE) {
      const slice = importRows.slice(offset, offset + CHUNK_SIZE);
      const part = await executeOpenSoHeadersImportRows(slice, {
        details,
        createdBy,
        itemsBySoKey,
        itemsByEiSoReference,
      });
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
      lines_parse_stats: lines.parseStats ?? null,
      lines_rows_total: lines.rows.length,
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
  OPEN_SO_LINES_SHEET,
  HEADER_ALIASES,
  LINE_HEADER_ALIASES,
  normalizeSheetName,
  findOpenSoHeadersWorksheet,
  findOpenSoLinesWorksheet,
  detectOpenSoHeadersColumnMap,
  detectOpenSoLinesColumnMap,
  excelFieldsToSalesOrderPayload,
  excelLineFieldsToItem,
  parseOpenSoHeadersWorkbook,
  parseOpenSoLinesWorkbook,
  extractOpenSoHeadersFromBuffer,
  extractOpenSoWorkbookFromBuffer,
  groupItemsBySoKey,
  groupItemsByEiSoReference,
  executeOpenSoHeadersImportRows,
  uploadOpenSoHeadersExcelSafe,
  postOpenSoHeadersExcelImport,
};

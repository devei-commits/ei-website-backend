/**
 * POST /api/v1/sales-orders/import-excel
 * Workbook sheets (preferred):
 * - "Sales Order": Zoho export — one row per line item with header fields repeated.
 * Legacy (still supported):
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
const { invalidateForModule } = require('../cache/invalidateCacheForModule');
const {
  toDateOnly,
  mapZohoSoStatus,
} = require('../../scripts/lib/zoho-sales-order-import');
const {
  applyDefaultExpectedShipmentDate,
  persistSalesOrderWithPlanning,
  updateSalesOrderWithPlanningRebuild,
} = require('./controller');

const SALES_ORDER_SHEET = 'sales order';
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

/** Header-level columns (Open SO Headers sheet or repeated on Sales Order rows). */
const HEADER_ALIASES = {
  eiSoReference: ['ei so reference', 'ei so reference (reference#)', 'reference#', 'reference'],
  zohoSoId: ['salesorder id', ...ZOHO_SO_ID_ALIASES],
  zohoSoNumber: ['salesorder number', ...ZOHO_SO_NUMBER_ALIASES],
  customerName: ['customer name'],
  zohoCustomerId: ['customer id', ...ZOHO_CUSTOMER_ID_ALIASES],
  orderDate: ['order date'],
  expectedShipmentDate: [
    'expected shipment date',
    'expected shipment / due date',
    'expected shipment',
    'due date',
  ],
  salesperson: ['sales person', 'salesperson'],
  placeOfSupply: ['place of supply'],
  placeOfSupplyWithStateCode: [
    'place of supply(with state code)',
    'place of supply (with state code)',
  ],
  gstTreatment: ['gst treatment'],
  gstin: [
    'gst identification number (gstin)',
    'gstin (on so)',
    'gstin on so',
    'gstin',
  ],
  billingAddress: ['billing address'],
  billingStreet2: ['billing street2'],
  billingCity: ['billing city'],
  billingState: ['billing state'],
  billingCountry: ['billing country'],
  billingPincode: ['billing code', 'billing pincode', 'billing zip', 'billing postal code'],
  billingPhone: ['billing phone'],
  billingFax: ['billing fax'],
  shippingAddress: ['shipping address'],
  shippingStreet2: ['shipping street2'],
  shippingCity: ['shipping city', 'shippng city'],
  shippingState: ['shipping state', 'shippng state'],
  shippingCountry: ['shipping country', 'shippng country'],
  shippingPincode: ['shipping code', 'shipping pincode', 'shippng pincode', 'shipping zip'],
  shippingPhone: ['shipping phone', 'shippng phone'],
  shippingFax: ['shipping fax'],
  paymentTerms: ['payment terms', 'payment terms (raw)', 'payment terms raw'],
  paymentTermsLabel: ['payment terms label'],
  notes: ['notes'],
  advancePercent: ['advance %', 'advance percent', 'advance'],
  preShipmentPercent: ['pre-shipment %', 'pre shipment %', 'preshipment %'],
  postShipmentPercent: ['post-shipment %', 'post shipment %', 'postshipment %'],
  creditDays: ['credit days'],
  currency: ['currency code', 'currency'],
  exchangeRate: ['exchange rate'],
  deliveryMethod: ['delivery method'],
  totalQtyOrdered: ['total qty ordered', 'total quantity ordered'],
  totalQtyInvoiced: ['total qty invoiced', 'total quantity invoiced'],
  totalQtyCancelled: ['total qty cancelled', 'total qty canceled', 'total quantity cancelled'],
  openQtyRemaining: ['open qty (remaining)', 'open qty remaining', 'open quantity'],
  zohoStatus: ['status', 'status (zoho)', 'status zoho', 'zoho status'],
  customStatus: ['custom status'],
};

const HEADER_KEYS = Object.keys(HEADER_ALIASES);
const LINE_HEADER_ALIASES = {
  eiSoReference: ['ei so reference', 'ei so reference (reference#)', 'reference#', 'reference'],
  zohoSoNumber: ['salesorder number', ...ZOHO_SO_NUMBER_ALIASES],
  zohoSoId: ['salesorder id', ...ZOHO_SO_ID_ALIASES],
  zohoCustomerId: ['customer id', ...ZOHO_CUSTOMER_ID_ALIASES],
  customerName: ['customer name'],
  zohoStatus: ['status', 'status (zoho)', 'status zoho', 'zoho status'],
  productName: [
    'item name',
    'product(item name)',
    'product (item name)',
    'product name',
    'product',
    'item',
    'description',
  ],
  itemDesc: ['item desc', 'item description'],
  sku: ['sku'],
  zohoProductId: ['product id', 'product id (zoho)', 'zoho product id', 'item id'],
  hsnSac: ['hsn/sac', 'hsn', 'sac'],
  packSize: ['pack size', 'pack'],
  qtyOrdered: [
    'quantityordered',
    'qty ordered',
    'quantity ordered',
    'qty',
    'quantity',
    'order qty',
    'ordered qty',
  ],
  qtyInvoiced: ['quantityinvoiced', 'qty invoiced', 'quantity invoiced'],
  qtyCancelled: ['quantitycancelled', 'qty cancelled', 'qty canceled', 'quantity cancelled'],
  openQtyRemaining: ['open qty (remaining)', 'open qty remaining', 'open quantity', 'open qty', 'balance qty', 'pending qty'],
  uom: ['usage unit', 'uom', 'unit'],
  unitPrice: ['item price', 'unit price (₹)', 'unit price', 'rate', 'unit rate', 'price'],
  itemTotal: ['item total', 'line total'],
  taxPercent: ['item tax %', 'tax %', 'tax percent'],
  taxAmount: ['item tax amount', 'tax amount'],
  cgstRatePercent: ['cgst rate %'],
  sgstRatePercent: ['sgst rate %'],
  igstRatePercent: ['igst rate %'],
  cessRatePercent: ['cess rate %'],
  cgstAmount: ['cgst'],
  sgstAmount: ['sgst'],
  igstAmount: ['igst'],
  cessAmount: ['cess'],
};
const LINE_HEADER_KEYS = Object.keys(LINE_HEADER_ALIASES);

/**
 * Explicit allowlist for Zoho "Sales Order" flat export.
 * All other workbook columns are ignored on import.
 */
const SALES_ORDER_FLAT_ALIASES = {
  zohoSoId: ['salesorder id'],
  zohoSoNumber: ['salesorder number'],
  orderDate: ['order date'],
  expectedShipmentDate: ['expected shipment date'],
  zohoStatus: ['status'],
  customStatus: ['custom status'],
  zohoCustomerId: ['customer id'],
  customerName: ['customer name'],
  eiSoReference: ['reference#', 'reference'],
  placeOfSupply: ['place of supply'],
  placeOfSupplyWithStateCode: ['place of supply(with state code)'],
  gstTreatment: ['gst treatment'],
  gstin: ['gst identification number (gstin)'],
  currency: ['currency code'],
  exchangeRate: ['exchange rate'],
  paymentTerms: ['payment terms'],
  paymentTermsLabel: ['payment terms label'],
  notes: ['notes'],
  deliveryMethod: ['delivery method'],
  salesperson: ['sales person'],
  billingAddress: ['billing address'],
  billingStreet2: ['billing street2'],
  billingCity: ['billing city'],
  billingState: ['billing state'],
  billingCountry: ['billing country'],
  billingPincode: ['billing code'],
  billingPhone: ['billing phone'],
  shippingAddress: ['shipping address'],
  shippingStreet2: ['shipping street2'],
  shippingCity: ['shipping city'],
  shippingState: ['shipping state'],
  shippingCountry: ['shipping country'],
  shippingPincode: ['shipping code'],
  shippingPhone: ['shipping phone'],
  productName: ['item name'],
  sku: ['sku'],
  itemDesc: ['item desc', 'item description'],
  account: ['account'],
  zohoProductId: ['product id'],
  qtyOrdered: ['quantityordered'],
  qtyInvoiced: ['quantityinvoiced'],
  qtyCancelled: ['quantitycancelled'],
  uom: ['usage unit'],
  unitPrice: ['item price'],
  hsnSac: ['hsn/sac'],
  itemTotal: ['item total'],
  taxPercent: ['item tax %'],
  taxAmount: ['item tax amount'],
  cgstRatePercent: ['cgst rate %'],
  sgstRatePercent: ['sgst rate %'],
  igstRatePercent: ['igst rate %'],
  cessRatePercent: ['cess rate %'],
  cgstAmount: ['cgst'],
  sgstAmount: ['sgst'],
  igstAmount: ['igst'],
  cessAmount: ['cess'],
};
const SALES_ORDER_FLAT_KEYS = Object.keys(SALES_ORDER_FLAT_ALIASES);

const SO_NUMBER_RE = /^SO[-\s]?\d+/i;

function normalizeHeaderLabel(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[_/.]+/g, ' ')
    .replace(/[()]/g, ' ')
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

const SALES_ORDER_ALIASES = SALES_ORDER_FLAT_ALIASES;
const SALES_ORDER_KEYS = SALES_ORDER_FLAT_KEYS;

function headerLabelMatchesAliases(label, aliases) {
  const normalized = normalizeHeaderLabel(label);
  if (!normalized) return false;
  return aliases.some((alias) => normalizeHeaderLabel(alias) === normalized);
}

/**
 * @param {import('exceljs').Workbook} workbook
 */
function findSalesOrderWorksheet(workbook) {
  for (const ws of workbook.worksheets || []) {
    if (normalizeSheetName(ws.name) === SALES_ORDER_SHEET) return ws;
  }
  for (const ws of workbook.worksheets || []) {
    const n = normalizeSheetName(ws.name);
    if (n === 'sales orders' || (n.includes('sales') && n.includes('order') && !n.includes('line') && !n.includes('header'))) {
      return ws;
    }
  }
  return null;
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
    if (map.zohoSoNumber != null || map.zohoSoId != null) {
      return { headerRow: r, col: map };
    }
  }
  return null;
}

/**
 * @param {import('exceljs').Worksheet} worksheet
 * @param {number} [maxScanRow]
 */
function detectSalesOrderColumnMap(worksheet, maxScanRow = 8) {
  const lastCol = Math.min(worksheet.columnCount || 160, 220);
  for (let r = 1; r <= maxScanRow; r += 1) {
    const row = worksheet.getRow(r);
    const map = {};
    for (let c = 1; c <= lastCol; c += 1) {
      const label = cellToText(row.getCell(c));
      if (!label) continue;
      for (const [key, aliases] of Object.entries(SALES_ORDER_FLAT_ALIASES)) {
        if (map[key]) continue;
        if (headerLabelMatchesAliases(label, aliases)) {
          map[key] = c;
        }
      }
    }
    if (map.zohoSoNumber != null && map.productName != null) {
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
  const fields = readRowFields(
    row,
    colMap,
    HEADER_KEYS.filter((k) => k !== 'zohoSoNumber' && k !== 'zohoSoId' && k !== 'zohoCustomerId')
  );

  if (colMap.zohoSoNumber) {
    const meta = readZohoContactIdMetaFromCell(row.getCell(colMap.zohoSoNumber));
    fields.zohoSoNumber = meta.id;
    fields.zohoSoNumberReliable = meta.reliable;
    const display = cellToText(row.getCell(colMap.zohoSoNumber));
    if (display && SO_NUMBER_RE.test(display.trim())) {
      fields.zohoSoDisplayNumber = display.trim();
    } else if (display && !/^\d{10,22}$/.test(display.trim().replace(/\s/g, ''))) {
      fields.zohoSoDisplayNumber = display.trim();
    }
  } else {
    fields.zohoSoNumber = '';
  }

  if (colMap.zohoSoId) {
    const meta = readZohoContactIdMetaFromCell(row.getCell(colMap.zohoSoId));
    fields.zohoSoId = meta.id;
    fields.zohoSoIdReliable = meta.reliable;
  } else {
    fields.zohoSoId = '';
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

function joinAddressLine(line1, line2) {
  const a = String(line1 || '').trim();
  const b = String(line2 || '').trim();
  if (a && b) return `${a}, ${b}`;
  return a || b || '';
}

function resolveZohoSoIdFromFields(fields) {
  const soIdRaw = cleanDigitsOrText(fields.zohoSoId);
  if (/^\d{10,22}$/.test(soIdRaw)) {
    const displayFromCell = String(fields.zohoSoDisplayNumber || '').trim();
    const numberField = String(fields.zohoSoNumber || '').trim();
    let displayNumber = displayFromCell;
    if (!displayNumber && numberField && SO_NUMBER_RE.test(numberField)) {
      displayNumber = numberField;
    } else if (!displayNumber && numberField && !/^\d{10,22}$/.test(numberField.replace(/\s/g, ''))) {
      displayNumber = numberField;
    }
    return {
      zohoId: soIdRaw,
      displayNumber: displayNumber || null,
      reliable: fields.zohoSoIdReliable === true,
    };
  }

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
  return Boolean(
    zohoId ||
      displayNumber ||
      String(fields.customerName || '').trim() ||
      normalizeEiSoReference(fields.eiSoReference)
  );
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
function excelFieldsToSalesOrderPayload(fields, opts = {}) {
  const flatFormat = opts.flatFormat === true;
  const { zohoId, displayNumber } = resolveZohoSoIdFromFields(fields);
  if (!flatFormat && !zohoId && !displayNumber && !normalizeEiSoReference(fields.eiSoReference)) {
    return null;
  }
  if (flatFormat && !displayNumber && !String(fields.zohoSoNumber || '').trim()) {
    return null;
  }

  const customerName = String(fields.customerName || '').trim() || null;
  const zohoCustomerId = String(fields.zohoCustomerId || '').trim().replace(/\s/g, '') || '';

  let orderId = displayNumber || '';
  if (!orderId && !flatFormat && zohoId) orderId = `ZOHO-SO-${zohoId}`;
  if (!orderId && flatFormat) {
    orderId = String(fields.zohoSoNumber || fields.zohoSoDisplayNumber || '').trim();
  }
  if (!orderId && !flatFormat) {
    const ref = normalizeEiSoReference(fields.eiSoReference);
    if (ref) orderId = ref;
  }
  if (!orderId) return null;

  const billing = {
    address: joinAddressLine(fields.billingAddress, fields.billingStreet2) || undefined,
    city: String(fields.billingCity || '').trim() || undefined,
    state: String(fields.billingState || '').trim() || undefined,
    country: String(fields.billingCountry || '').trim() || undefined,
    pincode: String(fields.billingPincode || '').trim() || undefined,
    phone: String(fields.billingPhone || '').trim() || undefined,
  };
  const shipping = {
    address: joinAddressLine(fields.shippingAddress, fields.shippingStreet2) || undefined,
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
  const paymentTerms = flatFormat
    ? resolveImportedPaymentTerms(fields)
    : String(fields.paymentTerms || '').trim() ||
      String(fields.paymentTermsLabel || '').trim() ||
      '';
  const placeOfSupply =
    String(fields.placeOfSupply || '').trim() ||
    String(fields.placeOfSupplyWithStateCode || '').trim() ||
    '';

  const form_data = {
    source: opts.source || 'excel_open_so_headers',
    orderId,
    customerName: customerName || '',
    orderDate: toDateOnly(fields.orderDate) || '',
    expectedShipmentDate: toDateOnly(fields.expectedShipmentDate) || '',
    paymentTerms,
    deliveryMethod: String(fields.deliveryMethod || '').trim() || '',
    salespersonName: String(fields.salesperson || '').trim() || '',
    placeOfSupply,
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
    advancePercent: flatFormat ? undefined : parseOptionalNumber(fields.advancePercent) ?? undefined,
    preShipmentPercent: flatFormat ? undefined : parseOptionalNumber(fields.preShipmentPercent) ?? undefined,
    postShipmentPercent: flatFormat ? undefined : parseOptionalNumber(fields.postShipmentPercent) ?? undefined,
    creditDays: flatFormat ? undefined : parseOptionalNumber(fields.creditDays) ?? undefined,
    zohoStatus,
  };
  const notes = String(fields.notes || '').trim();
  if (notes) form_data.notes = notes;
  const customStatus = String(fields.customStatus || '').trim();
  if (customStatus) form_data.customStatus = customStatus;
  const eiSoReference = normalizeEiSoReference(fields.eiSoReference);
  if (eiSoReference) {
    form_data.eiSoReference = eiSoReference;
  }

  if (zohoId) {
    form_data.zohoSalesorderId = zohoId;
    if (fields.zohoSoIdReliable === false || fields.zohoSoNumberReliable === false) {
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
    orderStatus: zohoStatus || (flatFormat ? 'Draft' : ''),
    deliveryMethod: String(fields.deliveryMethod || '').trim() || '',
    quantity: qtyOrdered ?? undefined,
    quantityInvoiced: qtyInvoiced ?? undefined,
    quantityCancelled: qtyCancelled ?? undefined,
    quantityOpen: qtyOpen ?? undefined,
  };
  if (flatFormat && zohoStatus) {
    order_status.zohoStatus = zohoStatus;
  }

  const referenceRaw = String(fields.eiSoReference || '').trim() || null;

  return {
    order_id: orderId,
    customer_name: customerName,
    order_date: toDateOnly(fields.orderDate),
    expected_shipment_date: toDateOnly(fields.expectedShipmentDate),
    reference: referenceRaw,
    payment_terms: paymentTerms || null,
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
function excelLineFieldsToItem(fields, opts = {}) {
  const flatFormat = opts.flatFormat === true;
  const qty = parseOptionalNumber(fields.qtyOrdered) ?? 0;
  const unitPrice = parseOptionalNumber(fields.unitPrice) ?? 0;
  const productName = String(fields.productName || '').trim() || 'Line item';
  const item = {
    sku: String(fields.sku || '').trim(),
    productName,
    pack: flatFormat ? '' : String(fields.packSize || '').trim(),
    quantity: qty,
    unitPrice,
    orderedQty: qty,
    openQty: qty || undefined,
    itemTotal: parseOptionalNumber(fields.itemTotal) ?? undefined,
  };
  {
    const invoiced = parseOptionalNumber(fields.qtyInvoiced) ?? 0;
    const cancelled = parseOptionalNumber(fields.qtyCancelled) ?? 0;
    const taxPercent = parseOptionalNumber(fields.taxPercent);
    let openQty = parseOptionalNumber(fields.openQtyRemaining);
    if (openQty == null && qty > 0) {
      openQty = Math.max(0, qty - invoiced - cancelled);
    }
    item.invoicedQty = invoiced || undefined;
    item.cancelledQty = cancelled || undefined;
    item.openQty = openQty ?? undefined;
    item.uom = String(fields.uom || '').trim() || undefined;
    item.taxPercent = taxPercent ?? undefined;
    item.taxAmount = parseOptionalNumber(fields.taxAmount) ?? undefined;
    item.cgstRatePercent = parseOptionalNumber(fields.cgstRatePercent) ?? undefined;
    item.sgstRatePercent = parseOptionalNumber(fields.sgstRatePercent) ?? undefined;
    item.igstRatePercent = parseOptionalNumber(fields.igstRatePercent) ?? undefined;
    item.cessRatePercent = parseOptionalNumber(fields.cessRatePercent) ?? undefined;
    item.cgstAmount = parseOptionalNumber(fields.cgstAmount) ?? undefined;
    item.sgstAmount = parseOptionalNumber(fields.sgstAmount) ?? undefined;
    item.igstAmount = parseOptionalNumber(fields.igstAmount) ?? undefined;
    item.cessAmount = parseOptionalNumber(fields.cessAmount) ?? undefined;
    const zohoProductId = cleanDigitsOrText(fields.zohoProductId);
    if (zohoProductId) item.zohoItemId = zohoProductId;
  }
  const hsnSac = String(fields.hsnSac || '').trim();
  if (hsnSac) item.hsnCode = hsnSac;
  return item;
}

/**
 * @param {import('exceljs').Row} row
 * @param {Record<string, number>} colMap
 */
function resolveImportedPaymentTerms(fields) {
  const label = String(fields.paymentTermsLabel || '').trim();
  const raw = String(fields.paymentTerms || '').trim();
  if (label) return label;
  if (raw && raw !== '0') return raw;
  return '';
}

function readSalesOrderFlatRowFields(row, colMap) {
  const zohoMetaKeys = new Set(['zohoSoId', 'zohoSoNumber', 'zohoCustomerId']);
  const fields = readRowFields(
    row,
    colMap,
    SALES_ORDER_FLAT_KEYS.filter((k) => !zohoMetaKeys.has(k))
  );

  if (colMap.zohoSoId) {
    const meta = readZohoContactIdMetaFromCell(row.getCell(colMap.zohoSoId));
    fields.zohoSoId =
      meta.id || String(cellToText(row.getCell(colMap.zohoSoId))).trim();
    fields.zohoSoIdReliable = meta.reliable;
  } else {
    fields.zohoSoId = '';
  }

  if (colMap.zohoSoNumber) {
    const display = String(cellToText(row.getCell(colMap.zohoSoNumber))).trim();
    fields.zohoSoNumber = display;
    if (display && SO_NUMBER_RE.test(display)) {
      fields.zohoSoDisplayNumber = display;
    } else if (display) {
      fields.zohoSoDisplayNumber = display;
    }
  } else {
    fields.zohoSoNumber = '';
  }

  if (colMap.zohoCustomerId) {
    const meta = readZohoContactIdMetaFromCell(row.getCell(colMap.zohoCustomerId));
    fields.zohoCustomerId =
      meta.id || String(cellToText(row.getCell(colMap.zohoCustomerId))).trim();
    fields.zohoCustomerIdReliable = meta.reliable;
  } else {
    fields.zohoCustomerId = '';
  }

  return fields;
}

/**
 * @param {Record<string, string|boolean>} fields
 */
function resolveSalesOrderFlatGroupKey(fields) {
  const display = String(fields.zohoSoDisplayNumber || fields.zohoSoNumber || '').trim();
  if (display) return `no:${normalizeSoKey(display)}`;
  const zohoId = cleanDigitsOrText(fields.zohoSoId);
  if (/^\d{10,22}$/.test(zohoId)) return `id:${zohoId}`;
  return '';
}

function sumItemQty(items, pick) {
  return items.reduce((sum, it) => sum + (Number(pick(it)) || 0), 0);
}

/**
 * @param {import('exceljs').Workbook} workbook
 * @param {Buffer} [buffer]
 */
function parseSalesOrderFlatWorkbook(workbook, buffer) {
  const worksheet = findSalesOrderWorksheet(workbook);
  if (!worksheet) {
    throw new Error('Worksheet "Sales Order" not found');
  }

  const layout = detectSalesOrderColumnMap(worksheet);
  if (!layout) {
    throw new Error(
      'Could not detect "Sales Order" header row (need SalesOrder Number and Item Name columns)'
    );
  }

  const { headerRow, col: colMap } = layout;
  const customerOverlay = buffer
    ? buildZohoColumnOverlayFromXlsx(buffer, worksheet.name, ['customer id'])
    : { byRow: {}, unreliableCount: 0 };
  const soIdOverlay = buffer
    ? buildZohoColumnOverlayFromXlsx(buffer, worksheet.name, ZOHO_SO_ID_ALIASES)
    : { byRow: {}, unreliableCount: 0 };

  const lastDataRow = getWorksheetEndRow(worksheet, headerRow);
  const grouped = new Map();
  let skippedNoIdentity = 0;
  let skippedNoProduct = 0;

  // Full label→column map (every source column, not just the aliased subset) for raw capture.
  const rawLabelsByCol = {};
  worksheet.getRow(headerRow).eachCell((cell, colNumber) => {
    const label = String(cellToText(cell) || '').trim();
    if (label) rawLabelsByCol[colNumber] = label;
  });
  const readRawRow = (row) => {
    const out = {};
    for (const [colNumber, label] of Object.entries(rawLabelsByCol)) {
      const v = cellToText(row.getCell(Number(colNumber)));
      const s = v == null ? '' : String(v).trim();
      if (s !== '') out[label] = s;
    }
    return out;
  };

  for (let r = headerRow + 1; r <= lastDataRow; r += 1) {
    const fields = readSalesOrderFlatRowFields(worksheet.getRow(r), colMap);
    if (customerOverlay.byRow?.[r]?.id) {
      fields.zohoCustomerId = customerOverlay.byRow[r].id;
      fields.zohoCustomerIdReliable = customerOverlay.byRow[r].reliable;
    }
    if (soIdOverlay.byRow?.[r]?.id) {
      fields.zohoSoId = soIdOverlay.byRow[r].id;
      fields.zohoSoIdReliable = soIdOverlay.byRow[r].reliable;
    }

    const groupKey = resolveSalesOrderFlatGroupKey(fields);
    if (!groupKey) {
      skippedNoIdentity += 1;
      continue;
    }

    const productName = String(fields.productName || '').trim();
    if (!productName && !String(fields.sku || '').trim()) {
      // Service / non-inventory SO line: keep as a service line so item-less orders still import.
      const hasSignal = String(fields.itemDesc || '').trim() || String(fields.account || '').trim()
        || parseOptionalNumber(fields.itemTotal) != null || parseOptionalNumber(fields.unitPrice) != null;
      if (!hasSignal) {
        skippedNoProduct += 1;
        continue;
      }
      fields.productName = String(fields.itemDesc || '').trim() || String(fields.account || '').trim() || 'Service / Non-inventory';
      fields.isServiceLine = true;
    }

    const entry = grouped.get(groupKey) || {
      headerFields: fields,
      lineRows: [],
      firstExcelRow: r,
    };
    entry.lineRows.push({
      excel_row: r,
      fields,
      item: excelLineFieldsToItem(fields, { flatFormat: true }),
      raw: readRawRow(worksheet.getRow(r)),
    });
    grouped.set(groupKey, entry);
  }

  const rows = [];
  for (const group of grouped.values()) {
    const payload = excelFieldsToSalesOrderPayload(group.headerFields, {
      source: 'excel_sales_order',
      flatFormat: true,
    });
    if (!payload) continue;

    const items = group.lineRows.map((lineRow) => lineRow.item);
    payload.items = items;
    // Preserve every source column verbatim so nothing is lost / hidden.
    const rawLines = group.lineRows.map((lr) => lr.raw).filter((x) => x && Object.keys(x).length);
    payload.raw_import = { header: rawLines[0] || {}, lines: rawLines };

    payload.order_status.quantity = sumItemQty(items, (it) => it.quantity);
    payload.order_status.quantityOpen = sumItemQty(items, (it) => it.quantity);

    rows.push({
      excel_row: group.firstExcelRow,
      sheet_name: worksheet.name,
      payload,
      fields: group.headerFields,
      line_count: group.lineRows.length,
    });
  }

  return {
    rows,
    sheetName: worksheet.name,
    headerRow,
    format: 'sales_order_flat',
    parseStats: {
      scanned_through_row: lastDataRow,
      skipped_no_identity: skippedNoIdentity,
      skipped_no_product: skippedNoProduct,
      groups_total: grouped.size,
      zoho_overlay_unreliable:
        (customerOverlay.unreliableCount ?? 0) + (soIdOverlay.unreliableCount ?? 0),
    },
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
  if (findSalesOrderWorksheet(workbook)) {
    const flat = parseSalesOrderFlatWorkbook(workbook, buffer);
    return {
      format: 'sales_order_flat',
      headers: flat,
      lines: {
        rows: [],
        sheetName: null,
        headerRow: null,
        parseStats: { scanned_through_row: 0, skipped_no_identity: 0, zoho_overlay_unreliable: 0 },
      },
    };
  }
  const headers = parseOpenSoHeadersWorkbook(workbook, buffer);
  const lines = parseOpenSoLinesWorkbook(workbook, buffer);
  return { format: 'open_so_split', headers, lines };
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
async function resolveProductIdBySku(sku) {
  const raw = String(sku || '').trim();
  if (!raw) return null;
  const { Product } = require('../products/models');
  const row =
    (await Product.findOne({ where: { zoho_sku_code: raw } })) ||
    (await Product.findOne({ where: { product_code: raw } })) ||
    (await Product.findOne({ where: { zoho_sku_code: { [Op.iLike]: raw } } })) ||
    (await Product.findOne({ where: { product_code: { [Op.iLike]: raw } } }));
  if (!row) return null;
  const plain = row.get ? row.get({ plain: true }) : row;
  const id = Number(plain.product_id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Attach local product_id to imported line items when SKU matches product master.
 * @param {Array<Record<string, unknown>>} items
 */
async function enrichPayloadItemsWithProductIds(items) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  for (const line of list) {
    const item = { ...line };
    if (!item.product_id && !item.productId) {
      const productId = await resolveProductIdBySku(item.sku);
      if (productId) {
        item.product_id = productId;
        item.productId = productId;
      }
    }
    out.push(item);
  }
  return out;
}

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
    raw_import: payload.raw_import || null,
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

async function upsertFulfillmentFromSalesOrderPayload(salesOrderRow, payload, opts = {}) {
  const replaceItems = opts.replaceItems === true;
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

  if (existingItemCount > 0 && !replaceItems) return;

  const salesOrderPlain = salesOrderRow.get ? salesOrderRow.get({ plain: true }) : salesOrderRow;
  const payloadItems = Array.isArray(payload?.items) ? payload.items : [];
  const persistedItems = Array.isArray(salesOrderPlain?.items) ? salesOrderPlain.items : [];
  const sourceItems = payloadItems.length > 0 ? payloadItems : persistedItems;

  const ffItems = mapSoItemsToFulfillmentItems(sourceItems)
    .filter((it) => it.ordered_qty > 0);
  if (ffItems.length === 0) return;

  if (existingItemCount > 0 && replaceItems) {
    await FulfillmentOrderItem.destroy({ where: { fulfillment_order_id: ff.id } });
  }

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

      const isFlatImport = payload.form_data?.source === 'excel_sales_order';

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
      // Attach product_id to the FINAL line items (after the legacy "Open SO Lines" merge above).
      // Previously enrichment ran before this merge on an empty array, so legacy-format SOs persisted
      // items with no product_id → planning extraction couldn't resolve them → SO never became a PI.
      payload.items = await enrichPayloadItemsWithProductIds(payload.items);

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

        // Rebuild planning on update for BOTH formats so re-imports keep the PI list in sync.
        const updatePayload = {
          customer_name: payload.customer_name ?? existing.customer_name,
          order_date: payload.order_date ?? existing.order_date,
          expected_shipment_date:
            payload.expected_shipment_date ?? existing.expected_shipment_date,
          reference: payload.reference ?? existing.reference,
          payment_terms: payload.payment_terms ?? existing.payment_terms,
          status: payload.status ?? existing.status,
          order_status: mergedOs,
          form_data: mergedFd,
          items: mergedItems,
          created_by: existing.created_by || createdBy,
        };
        await updateSalesOrderWithPlanningRebuild(existing, updatePayload);
        payload.items = mergedItems;
        await upsertFulfillmentFromSalesOrderPayload(existing, payload, { replaceItems: isFlatImport });

        summary.updated += 1;
        if (details) {
          summary.row_log.push({
            ...logBase,
            action: 'updated',
            order_id: existing.order_id,
            zoho_salesorder_id: zohoId || undefined,
            line_count: mergedItems.length,
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

      await applyDefaultExpectedShipmentDate(payload);
      // Both formats create planning rows on import (the legacy path used a bare SalesOrder.create,
      // so legacy-imported SOs never became PIs until a later read-time self-heal — and only if the
      // fuzzy product match happened to work).
      const row = await persistSalesOrderWithPlanning(payload);
      await upsertFulfillmentFromSalesOrderPayload(row, payload, {
        replaceItems: isFlatImport,
      });
      summary.created += 1;
      if (details) {
        summary.row_log.push({
          ...logBase,
          action: 'created',
          order_id: row.order_id,
          zoho_salesorder_id: zohoId || undefined,
          line_count: Array.isArray(payload.items) ? payload.items.length : 0,
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

    const { headers, lines, format } = parsed;
    const { rows, sheetName, headerRow, parseStats } = headers;
    const isFlatFormat = format === 'sales_order_flat';

    if (!isFlatFormat && !lines.sheetName) {
      return res.status(400).json({
        error: 'Worksheet "Open SO Lines" not found. SKU/product rows are required for import.',
      });
    }
    if (!isFlatFormat && !lines.rows.length) {
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
        error: isFlatFormat
          ? 'No sales order rows found on "Sales Order". Need SalesOrder Number and line items.'
          : 'No sales order rows found on "Open SO Headers". Need Zoho SO Number or customer name.',
        sheet: sheetName,
        header_row: headerRow,
        parse_stats: parseStats ?? null,
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
    const itemsBySoKey = isFlatFormat ? new Map() : groupItemsBySoKey(lines.rows);
    const itemsByEiSoReference = isFlatFormat
      ? new Map()
      : groupItemsByEiSoReference(lines.rows);

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

    await invalidateForModule('sales-orders');

    return res.json({
      ok: true,
      format: format || 'open_so_split',
      rows_total: rows.length,
      rows_imported: importRows.length,
      sheet: sheetName,
      header_row: headerRow,
      parse_stats: parseStats ?? null,
      lines_parse_stats: isFlatFormat ? null : lines.parseStats ?? null,
      lines_rows_total: isFlatFormat ? 0 : lines.rows.length,
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
  SALES_ORDER_SHEET,
  OPEN_SO_HEADERS_SHEET,
  OPEN_SO_LINES_SHEET,
  HEADER_ALIASES,
  LINE_HEADER_ALIASES,
  SALES_ORDER_FLAT_ALIASES,
  SALES_ORDER_ALIASES,
  normalizeSheetName,
  findSalesOrderWorksheet,
  findOpenSoHeadersWorksheet,
  findOpenSoLinesWorksheet,
  detectSalesOrderColumnMap,
  detectOpenSoHeadersColumnMap,
  detectOpenSoLinesColumnMap,
  excelFieldsToSalesOrderPayload,
  excelLineFieldsToItem,
  parseSalesOrderFlatWorkbook,
  parseOpenSoHeadersWorkbook,
  parseOpenSoLinesWorkbook,
  extractOpenSoHeadersFromBuffer,
  extractOpenSoWorkbookFromBuffer,
  groupItemsBySoKey,
  groupItemsByEiSoReference,
  enrichPayloadItemsWithProductIds,
  resolveProductIdBySku,
  executeOpenSoHeadersImportRows,
  uploadOpenSoHeadersExcelSafe,
  postOpenSoHeadersExcelImport,
};

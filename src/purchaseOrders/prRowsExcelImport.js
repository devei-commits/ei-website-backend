/**
 * POST /api/v1/purchase-orders/import-excel
 * Workbook sheets (preferred):
 * - "PurchaseOrder": Zoho export — one row per line item with header fields repeated.
 * Legacy (still supported):
 * - "PR rows" (or name containing "pr" + "rows")
 * - "Quotation rows" (or name containing "quotation" + "rows")
 * - "Raw PO Detail (reconcile)" (or name containing "raw po detail")
 */
const ExcelJS = require('exceljs');
const multer = require('multer');
const PurchaseOrder = require('./models');
const VendorClient = require('../vendorClient/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { cellToText } = require('../masterBulk/masterExcelFlexibleParse');
const { readRowFields, readZohoContactIdMetaFromCell } = require('../vendorClient/vendorClientExcelParseUtils');

const PURCHASE_ORDER_SHEET = 'purchaseorder';
const PR_ROWS_SHEET = 'pr rows';
const QUOTATION_ROWS_SHEET = 'quotation rows';
const RAW_PO_DETAIL_SHEET = 'raw po detail (reconcile)';
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_DATA_ROWS = 200000;
const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

const HEADER_ALIASES = {
  sourcePoNumber: ['source po number'],
  eiPoReference: ['ei po reference', 'po reference'],
  poStatus: ['po status'],
  category: ['category'],
  priority: ['priority'],
  requestDate: ['request date'],
  requiredDate: ['required date'],
  itemName: ['item name'],
  reqQty: ['req qty', 'required qty'],
  openQtyRemaining: ['open qty (remaining)', 'open qty remaining'],
  uom: ['uom', 'unit'],
  moq: ['moq'],
  plannedPrice: ['planned price (₹)', 'planned price'],
  packSize: ['pack size'],
  leadTimeDays: ['lead time (days)', 'lead time days'],
  preferredVendor: ['preferred vendor'],
  preferredVendorZohoId: ['prefferred vendor zoho id', 'preferred vendor zoho id'],
  hsnSac: ['hsn/sac', 'hsn', 'sac'],
  sku: ['sku'],
  zohoProductId: ['product id (zoho)', 'zoho product id'],
};
const HEADER_KEYS = Object.keys(HEADER_ALIASES);
const QUOTATION_HEADER_ALIASES = {
  sourcePoNumber: ['source po number'],
  eiPoReference: ['ei po reference', 'po reference'],
  vendor: ['vendor'],
  vendorZohoId: ['vendor zoho id', 'zoho vendor id'],
  vendorGstin: ['vendor gstin', 'gstin'],
  gstTreatment: ['gst treatment'],
  itemName: ['item name'],
  sku: ['sku'],
  hsnSac: ['hsn/sac', 'hsn', 'sac'],
  uom: ['uom', 'unit'],
  quotedQty: ['quoted qty', 'qty quoted'],
  unitPrice: ['rate / unit price (₹)', 'rate / unit price', 'unit price', 'rate'],
  itemTaxPercent: ['item tax %', 'tax %'],
  itemTaxAmount: ['item tax amount', 'tax amount'],
  itemTotal: ['item total', 'line total'],
  currency: ['currency'],
  quotationDate: ['quotation date'],
  validityExpectedArrival: ['validity / expected arrival', 'validity', 'expected arrival'],
  paymentTerms: ['payment terms'],
  confirmed: ['confirmed?','confirmed'],
};
const QUOTATION_HEADER_KEYS = Object.keys(QUOTATION_HEADER_ALIASES);
const RAW_DETAIL_HEADER_ALIASES = {
  purchaseOrderNumber: ['purchase order number', 'po number'],
  eiPoReference: ['reference#', 'reference #', 'ei po reference', 'po reference'],
  purchaseOrderDate: ['purchase order date', 'po date'],
  deliveryDate: ['delivery date'],
  expectedArrivalDate: ['expected arrival date', 'expected arrival'],
  vendorName: ['vendor name', 'vendor'],
  vendorGstin: ['gst identification number(gstin)', 'gst identification number (gstin)', 'vendor gstin', 'gstin'],
  gstTreatment: ['gst treatment'],
  itemName: ['item name'],
  sku: ['sku'],
  hsnSac: ['hsn/sac', 'hsn', 'sac'],
  itemDesc: ['item desc', 'item description'],
  quantityOrdered: ['quantityordered', 'quantity ordered'],
  quantityReceived: ['quantityrecieved', 'quantity received'],
  quantityCancelled: ['quantitycancelled', 'quantity cancelled'],
  quantityBilled: ['quantitybilled', 'quantity billed'],
  usageUnit: ['usage unit', 'uom', 'unit'],
  itemPrice: ['item price', 'unit price'],
  itemTaxPercent: ['item tax %', 'tax %'],
  itemTaxAmount: ['item tax amount', 'tax amount'],
  itemTotal: ['item total', 'line total'],
  poTotal: ['total', 'po total'],
  currencyCode: ['currency code', 'currency'],
  paymentTermsLabel: ['payment terms label', 'payment terms'],
};
const RAW_DETAIL_HEADER_KEYS = Object.keys(RAW_DETAIL_HEADER_ALIASES);

/**
 * Explicit allowlist for Zoho "PurchaseOrder" flat export.
 * All other workbook columns are ignored on import.
 */
const PURCHASE_ORDER_FLAT_ALIASES = {
  purchaseOrderNumber: ['purchase order number'],
  purchaseOrderDate: ['purchase order date'],
  deliveryDate: ['delivery date'],
  expectedArrivalDate: ['expected arrival date'],
  poStatus: ['purchase order status'],
  vendorName: ['vendor name'],
  gstin: ['gst identification number (gstin)'],
  paymentTerms: ['payment terms'],
  paymentTermsLabel: ['payment terms label'],
  attention: ['attention'],
  address: ['address'],
  city: ['city'],
  state: ['state'],
  country: ['country'],
  pincode: ['code'],
  phone: ['phone'],
  itemName: ['item name'],
  sku: ['sku'],
  hsnSac: ['hsn/sac'],
  qtyOrdered: ['quantityordered'],
  unitPrice: ['item price'],
  itemTotal: ['item total'],
};
const PURCHASE_ORDER_FLAT_KEYS = Object.keys(PURCHASE_ORDER_FLAT_ALIASES);

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

function parseOptionalNumber(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim().replace(/,/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeMaterialType(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'pm' || s.includes('pack')) return 'PM';
  return 'RM';
}

function toDateOnly(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  if (!s || s.toLowerCase() === 'invalid date') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function headerLabelMatchesAliases(label, aliases) {
  const normalized = normalizeHeaderLabel(label);
  if (!normalized) return false;
  return aliases.some((alias) => normalizeHeaderLabel(alias) === normalized);
}

function normalizePoKey(value) {
  return String(value || '').trim().toUpperCase();
}

/**
 * @param {import('exceljs').Workbook} workbook
 */
function findPurchaseOrderWorksheet(workbook) {
  for (const ws of workbook.worksheets || []) {
    const n = normalizeSheetName(ws.name).replace(/\s+/g, '');
    if (n === PURCHASE_ORDER_SHEET) return ws;
  }
  for (const ws of workbook.worksheets || []) {
    const n = normalizeSheetName(ws.name);
    if (n === 'purchase order' || n === 'purchase orders') return ws;
  }
  return null;
}

function getWorksheetEndRow(worksheet, headerRow) {
  const bottom = Number(worksheet.dimensions?.bottom ?? 0);
  const reported = Number(worksheet.rowCount || worksheet.actualRowCount || 0);
  return Math.max(bottom, reported, headerRow + 1);
}

/**
 * @param {import('exceljs').Workbook} workbook
 */
function findPrRowsWorksheet(workbook) {
  for (const ws of workbook.worksheets || []) {
    if (normalizeSheetName(ws.name) === PR_ROWS_SHEET) return ws;
  }
  for (const ws of workbook.worksheets || []) {
    const n = normalizeSheetName(ws.name);
    if (n.includes('pr') && n.includes('rows')) return ws;
  }
  return null;
}

/**
 * @param {import('exceljs').Workbook} workbook
 */
function findQuotationRowsWorksheet(workbook) {
  for (const ws of workbook.worksheets || []) {
    if (normalizeSheetName(ws.name) === QUOTATION_ROWS_SHEET) return ws;
  }
  for (const ws of workbook.worksheets || []) {
    const n = normalizeSheetName(ws.name);
    if (n.includes('quotation') && n.includes('rows')) return ws;
    if (n.includes('sheet 2') && n.includes('quotation')) return ws;
  }
  return null;
}

/**
 * @param {import('exceljs').Workbook} workbook
 */
function findRawPoDetailWorksheet(workbook) {
  for (const ws of workbook.worksheets || []) {
    if (normalizeSheetName(ws.name) === RAW_PO_DETAIL_SHEET) return ws;
  }
  for (const ws of workbook.worksheets || []) {
    const n = normalizeSheetName(ws.name);
    if (n.includes('raw po detail')) return ws;
    if (n.includes('reconcile') && n.includes('po')) return ws;
  }
  return null;
}

/**
 * @param {import('exceljs').Worksheet} worksheet
 * @param {number} [maxScanRow]
 */
function detectPurchaseOrderColumnMap(worksheet, maxScanRow = 8) {
  const lastCol = Math.min(worksheet.columnCount || 160, 220);
  for (let r = 1; r <= maxScanRow; r += 1) {
    const row = worksheet.getRow(r);
    const map = {};
    for (let c = 1; c <= lastCol; c += 1) {
      const label = cellToText(row.getCell(c));
      if (!label) continue;
      for (const [key, aliases] of Object.entries(PURCHASE_ORDER_FLAT_ALIASES)) {
        if (map[key]) continue;
        if (headerLabelMatchesAliases(label, aliases)) {
          map[key] = c;
        }
      }
    }
    if (map.purchaseOrderNumber != null && map.itemName != null) {
      return { headerRow: r, col: map };
    }
  }
  return null;
}

function readPurchaseOrderFlatRowFields(row, colMap) {
  return readRowFields(row, colMap, PURCHASE_ORDER_FLAT_KEYS);
}

function resolvePurchaseOrderFlatGroupKey(fields) {
  const poNo = String(fields.purchaseOrderNumber || '').trim();
  if (poNo) return `no:${normalizePoKey(poNo)}`;
  return '';
}

function purchaseOrderFlatFieldsToItem(fields) {
  const sku = String(fields.sku || '').trim();
  const itemName = String(fields.itemName || '').trim() || 'PO item';
  return {
    sku,
    productName: itemName,
    itemName,
    name: itemName,
    itemCode: sku || undefined,
    code: sku || undefined,
    type: 'RM',
    quantity: parseOptionalNumber(fields.qtyOrdered) ?? 0,
    unitPrice: parseOptionalNumber(fields.unitPrice) ?? 0,
    hsnCode: String(fields.hsnSac || '').trim() || undefined,
    itemTotal: parseOptionalNumber(fields.itemTotal) ?? undefined,
  };
}

function buildPoHeaderFromFlatFields(fields) {
  const orderId = String(fields.purchaseOrderNumber || '').trim();
  if (!orderId) return null;

  const paymentTerms =
    String(fields.paymentTerms || '').trim() ||
    String(fields.paymentTermsLabel || '').trim() ||
    '';

  return {
    order_id: orderId,
    vendor_name: String(fields.vendorName || '').trim() || null,
    order_date: toDateOnly(fields.purchaseOrderDate),
    expected_shipment_date:
      toDateOnly(fields.deliveryDate) || toDateOnly(fields.expectedArrivalDate),
    reference: null,
    status: String(fields.poStatus || '').trim() || 'Draft',
    payment_terms: paymentTerms || null,
    order_status: {
      orderStatus: String(fields.poStatus || '').trim() || '',
    },
    form_data: {
      source: 'excel_purchase_order',
      poNumber: orderId,
      purchaseOrderNumber: orderId,
      purchaseOrderDate: toDateOnly(fields.purchaseOrderDate) || '',
      deliveryDate: toDateOnly(fields.deliveryDate) || '',
      expectedArrivalDate: toDateOnly(fields.expectedArrivalDate) || '',
      vendorGstin: String(fields.gstin || '').trim() || '',
      paymentTerms,
      vendorAttention: String(fields.attention || '').trim() || '',
      vendorAddress: String(fields.address || '').trim() || '',
      vendorCity: String(fields.city || '').trim() || '',
      vendorState: String(fields.state || '').trim() || '',
      vendorCountry: String(fields.country || '').trim() || '',
      vendorPincode: String(fields.pincode || '').trim() || '',
      vendorPhone: String(fields.phone || '').trim() || '',
      poStatus: String(fields.poStatus || '').trim() || '',
    },
    items: [],
  };
}

/**
 * @param {import('exceljs').Workbook} workbook
 */
function parsePurchaseOrderFlatWorkbook(workbook) {
  const worksheet = findPurchaseOrderWorksheet(workbook);
  if (!worksheet) {
    throw new Error('Worksheet "PurchaseOrder" not found');
  }

  const layout = detectPurchaseOrderColumnMap(worksheet);
  if (!layout) {
    throw new Error(
      'Could not detect "PurchaseOrder" header row (need Purchase Order Number and Item Name columns)'
    );
  }

  const { headerRow, col: colMap } = layout;
  const lastDataRow = getWorksheetEndRow(worksheet, headerRow);
  const grouped = new Map();
  let skippedNoIdentity = 0;
  let skippedNoProduct = 0;

  for (let r = headerRow + 1; r <= lastDataRow; r += 1) {
    const fields = readPurchaseOrderFlatRowFields(worksheet.getRow(r), colMap);
    const groupKey = resolvePurchaseOrderFlatGroupKey(fields);
    if (!groupKey) {
      skippedNoIdentity += 1;
      continue;
    }

    const productName = String(fields.itemName || '').trim();
    if (!productName && !String(fields.sku || '').trim()) {
      skippedNoProduct += 1;
      continue;
    }

    const entry = grouped.get(groupKey) || {
      headerFields: fields,
      lineRows: [],
      firstExcelRow: r,
    };
    entry.lineRows.push({
      excel_row: r,
      fields,
      item: purchaseOrderFlatFieldsToItem(fields),
    });
    grouped.set(groupKey, entry);
  }

  const rows = [];
  for (const group of grouped.values()) {
    const payload = buildPoHeaderFromFlatFields(group.headerFields);
    if (!payload) continue;
    payload.items = group.lineRows.map((lineRow) => lineRow.item);
    rows.push({
      excel_row: group.firstExcelRow,
      sheet_name: worksheet.name,
      po_key: String(group.headerFields.purchaseOrderNumber || '').trim(),
      payload,
      fields: group.headerFields,
      line_count: group.lineRows.length,
    });
  }

  return {
    rows,
    sheetName: worksheet.name,
    headerRow,
    format: 'purchase_order_flat',
    parseStats: {
      scanned_through_row: lastDataRow,
      skipped_no_identity: skippedNoIdentity,
      skipped_no_product: skippedNoProduct,
      groups_total: grouped.size,
    },
  };
}

function groupPurchaseOrderFlatRows(rows) {
  const out = new Map();
  for (const row of rows || []) {
    const key = String(row.po_key || '').trim();
    if (!key || !row.payload) continue;
    out.set(key, {
      excel_rows: [row.excel_row],
      payload: row.payload,
    });
  }
  return out;
}

/**
 * @param {import('exceljs').Worksheet} worksheet
 * @param {number} [maxScanRow]
 */
function detectPrRowsColumnMap(worksheet, maxScanRow = 8) {
  const lastCol = Math.min(worksheet.columnCount || 100, 150);
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
    if (map.eiPoReference != null && map.itemName != null) {
      return { headerRow: r, col: map };
    }
  }
  return null;
}

/**
 * @param {import('exceljs').Worksheet} worksheet
 * @param {number} [maxScanRow]
 */
function detectQuotationRowsColumnMap(worksheet, maxScanRow = 8) {
  const lastCol = Math.min(worksheet.columnCount || 100, 160);
  for (let r = 1; r <= maxScanRow; r += 1) {
    const row = worksheet.getRow(r);
    const map = {};
    for (let c = 1; c <= lastCol; c += 1) {
      const label = normalizeHeaderLabel(cellToText(row.getCell(c)));
      if (!label) continue;
      for (const [key, aliases] of Object.entries(QUOTATION_HEADER_ALIASES)) {
        if (map[key]) continue;
        if (aliases.some((a) => label === a || label.includes(a) || a.includes(label))) {
          map[key] = c;
        }
      }
    }
    if (map.eiPoReference != null && map.itemName != null) {
      return { headerRow: r, col: map };
    }
  }
  return null;
}

/**
 * @param {import('exceljs').Worksheet} worksheet
 * @param {number} [maxScanRow]
 */
function detectRawPoDetailColumnMap(worksheet, maxScanRow = 8) {
  const lastCol = Math.min(worksheet.columnCount || 120, 200);
  for (let r = 1; r <= maxScanRow; r += 1) {
    const row = worksheet.getRow(r);
    const map = {};
    for (let c = 1; c <= lastCol; c += 1) {
      const label = normalizeHeaderLabel(cellToText(row.getCell(c)));
      if (!label) continue;
      for (const [key, aliases] of Object.entries(RAW_DETAIL_HEADER_ALIASES)) {
        if (map[key]) continue;
        if (aliases.some((a) => label === a || label.includes(a) || a.includes(label))) {
          map[key] = c;
        }
      }
    }
    if ((map.eiPoReference != null || map.purchaseOrderNumber != null) && map.itemName != null) {
      return { headerRow: r, col: map };
    }
  }
  return null;
}

function readPrRowFields(row, colMap) {
  const fields = readRowFields(
    row,
    colMap,
    HEADER_KEYS.filter((k) => k !== 'preferredVendorZohoId' && k !== 'zohoProductId')
  );

  const vendorMeta = colMap.preferredVendorZohoId
    ? readZohoContactIdMetaFromCell(row.getCell(colMap.preferredVendorZohoId))
    : { id: '', reliable: false };
  fields.preferredVendorZohoId = vendorMeta.id;
  fields.preferredVendorZohoIdReliable = vendorMeta.reliable;

  const productMeta = colMap.zohoProductId
    ? readZohoContactIdMetaFromCell(row.getCell(colMap.zohoProductId))
    : { id: '', reliable: false };
  fields.zohoProductId = productMeta.id;
  fields.zohoProductIdReliable = productMeta.reliable;
  return fields;
}

function readQuotationRowFields(row, colMap) {
  const fields = readRowFields(
    row,
    colMap,
    QUOTATION_HEADER_KEYS.filter((k) => k !== 'vendorZohoId')
  );

  const vendorMeta = colMap.vendorZohoId
    ? readZohoContactIdMetaFromCell(row.getCell(colMap.vendorZohoId))
    : { id: '', reliable: false };
  fields.vendorZohoId = vendorMeta.id;
  fields.vendorZohoIdReliable = vendorMeta.reliable;
  return fields;
}

function readRawPoDetailRowFields(row, colMap) {
  return readRowFields(row, colMap, RAW_DETAIL_HEADER_KEYS);
}

function rowHasIdentity(fields) {
  return Boolean(
    String(fields.eiPoReference || '').trim() ||
      String(fields.sourcePoNumber || '').trim() ||
      String(fields.itemName || '').trim()
  );
}

function poKeyFromFields(fields) {
  const ref = String(fields.eiPoReference || '').trim();
  if (ref) return ref;
  const src = String(fields.sourcePoNumber || '').trim();
  if (src) return src;
  return '';
}

function poKeyFromQuotationFields(fields) {
  return poKeyFromFields(fields);
}

function poKeyFromRawDetailFields(fields) {
  const poNo = String(fields.purchaseOrderNumber || '').trim();
  if (poNo) return poNo;
  const ref = String(fields.eiPoReference || '').trim();
  if (ref) return ref;
  return '';
}

function prRowFieldsToItem(fields) {
  const sku = String(fields.sku || '').trim();
  const type = normalizeMaterialType(fields.category);
  const itemName = String(fields.itemName || '').trim() || 'PO item';
  const item = {
    sku,
    productName: itemName,
    itemName,
    name: itemName,
    itemCode: sku || undefined,
    code: sku || undefined,
    type,
    pack: String(fields.packSize || '').trim(),
    quantity: parseOptionalNumber(fields.reqQty) ?? 0,
    reqQty: parseOptionalNumber(fields.reqQty) ?? undefined,
    openQty: parseOptionalNumber(fields.openQtyRemaining) ?? undefined,
    uom: String(fields.uom || '').trim() || undefined,
    moq: parseOptionalNumber(fields.moq) ?? undefined,
    unitPrice: parseOptionalNumber(fields.plannedPrice) ?? 0,
    leadTimeDays: parseOptionalNumber(fields.leadTimeDays) ?? undefined,
    hsnCode: String(fields.hsnSac || '').trim() || undefined,
    category: type,
  };
  const zohoPid = String(fields.zohoProductId || '').trim();
  if (zohoPid) item.zohoItemId = zohoPid;
  return item;
}

function quotationRowFieldsToItem(fields) {
  const itemName = String(fields.itemName || '').trim() || 'PO item';
  const item = {
    sku: String(fields.sku || '').trim(),
    productName: itemName,
    itemName,
    name: itemName,
    itemCode: String(fields.sku || '').trim() || undefined,
    code: String(fields.sku || '').trim() || undefined,
    quantity: parseOptionalNumber(fields.quotedQty) ?? undefined,
    quotedQty: parseOptionalNumber(fields.quotedQty) ?? undefined,
    uom: String(fields.uom || '').trim() || undefined,
    unitPrice: parseOptionalNumber(fields.unitPrice) ?? undefined,
    hsnCode: String(fields.hsnSac || '').trim() || undefined,
    taxPercent: parseOptionalNumber(fields.itemTaxPercent) ?? undefined,
    taxAmount: parseOptionalNumber(fields.itemTaxAmount) ?? undefined,
    itemTotal: parseOptionalNumber(fields.itemTotal) ?? undefined,
    currency: String(fields.currency || '').trim() || undefined,
  };
  return item;
}

function rawPoDetailFieldsToItem(fields) {
  const itemName = String(fields.itemName || '').trim() || 'PO item';
  return {
    sku: String(fields.sku || '').trim(),
    productName: itemName,
    itemName,
    name: itemName,
    itemCode: String(fields.sku || '').trim() || undefined,
    code: String(fields.sku || '').trim() || undefined,
    itemDesc: String(fields.itemDesc || '').trim() || undefined,
    quantity: parseOptionalNumber(fields.quantityOrdered) ?? undefined,
    quantityOrdered: parseOptionalNumber(fields.quantityOrdered) ?? undefined,
    quantityReceived: parseOptionalNumber(fields.quantityReceived) ?? undefined,
    quantityCancelled: parseOptionalNumber(fields.quantityCancelled) ?? undefined,
    quantityBilled: parseOptionalNumber(fields.quantityBilled) ?? undefined,
    uom: String(fields.usageUnit || '').trim() || undefined,
    unitPrice: parseOptionalNumber(fields.itemPrice) ?? undefined,
    taxPercent: parseOptionalNumber(fields.itemTaxPercent) ?? undefined,
    taxAmount: parseOptionalNumber(fields.itemTaxAmount) ?? undefined,
    itemTotal: parseOptionalNumber(fields.itemTotal) ?? undefined,
    hsnCode: String(fields.hsnSac || '').trim() || undefined,
    currency: String(fields.currencyCode || '').trim() || undefined,
  };
}

async function buildMaterialSkuLookup() {
  const [rmRows, pmRows] = await Promise.all([
    RawMaterial.findAll({
      attributes: ['id', 'code', 'name', 'zoho_sku_code'],
    }),
    PackMaterial.findAll({
      attributes: ['id', 'code', 'description', 'zoho_sku_code'],
    }),
  ]);

  const rmBySku = new Map();
  const pmBySku = new Map();
  for (const row of rmRows) {
    const d = row.get ? row.get({ plain: true }) : row;
    const key = String(d.zoho_sku_code || '').trim().toUpperCase();
    if (!key) continue;
    rmBySku.set(key, {
      id: Number(d.id),
      code: String(d.code || '').trim(),
      name: String(d.name || '').trim(),
    });
  }
  for (const row of pmRows) {
    const d = row.get ? row.get({ plain: true }) : row;
    const key = String(d.zoho_sku_code || '').trim().toUpperCase();
    if (!key) continue;
    pmBySku.set(key, {
      id: Number(d.id),
      code: String(d.code || '').trim(),
      name: String(d.description || '').trim(),
    });
  }
  return { rmBySku, pmBySku };
}

function enrichItemsWithMaterialLookup(items, lookup) {
  const list = Array.isArray(items) ? items : [];
  if (!lookup) return list;

  return list.map((item) => {
    const out = { ...(item || {}) };
    const type = normalizeMaterialType(out.type || out.category);
    const sku = String(out.sku || '').trim().toUpperCase();
    const ref = type === 'PM' ? lookup.pmBySku.get(sku) : lookup.rmBySku.get(sku);
    out.type = type;
    out.category = type;

    if (ref) {
      const code = String(ref.code || '').trim();
      const displayName = String(ref.name || '').trim();
      if (type === 'PM') {
        out.pack_material_id = ref.id;
      } else {
        out.raw_material_id = ref.id;
      }
      if (code) {
        out.itemCode = code;
        out.code = code;
      } else if (!out.itemCode && out.sku) {
        out.itemCode = out.sku;
        out.code = out.sku;
      }
      if (displayName) {
        out.itemName = displayName;
        out.name = displayName;
        out.productName = displayName;
      }
    } else {
      if (!out.itemCode && out.sku) {
        out.itemCode = out.sku;
        out.code = out.sku;
      }
      const fallbackName = String(out.itemName || out.name || out.productName || '').trim();
      if (fallbackName) {
        out.itemName = fallbackName;
        out.name = fallbackName;
        out.productName = fallbackName;
      }
    }

    return out;
  });
}

function buildPoHeaderFromFirstRow(fields) {
  const orderId = poKeyFromFields(fields);
  return {
    order_id: orderId,
    vendor_name: String(fields.preferredVendor || '').trim() || null,
    order_date: toDateOnly(fields.requestDate),
    expected_shipment_date: toDateOnly(fields.requiredDate),
    reference: String(fields.sourcePoNumber || '').trim() || null,
    status: String(fields.poStatus || '').trim() || 'Draft',
    payment_terms: null,
    order_status: {
      orderStatus: String(fields.poStatus || '').trim() || '',
      priority: String(fields.priority || '').trim() || '',
      category: String(fields.category || '').trim() || '',
    },
    form_data: {
      source: 'excel_pr_rows',
      poNumber: orderId,
      sourcePoNumber: String(fields.sourcePoNumber || '').trim() || '',
      eiPoReference: String(fields.eiPoReference || '').trim() || '',
      poStatus: String(fields.poStatus || '').trim() || '',
      category: String(fields.category || '').trim() || '',
      priority: String(fields.priority || '').trim() || '',
      requestDate: toDateOnly(fields.requestDate) || '',
      requiredDate: toDateOnly(fields.requiredDate) || '',
      preferredVendor: String(fields.preferredVendor || '').trim() || '',
      preferredVendorZohoId: String(fields.preferredVendorZohoId || '').trim() || '',
    },
  };
}

function parsePrRowsWorkbook(workbook) {
  const worksheet = findPrRowsWorksheet(workbook);
  if (!worksheet) throw new Error('Worksheet "PR rows" not found');

  const layout = detectPrRowsColumnMap(worksheet);
  if (!layout) throw new Error('Could not detect "PR rows" header columns');

  const { headerRow, col: colMap } = layout;
  const lastDataRow = getWorksheetEndRow(worksheet, headerRow);
  const parsedRows = [];
  let skippedNoIdentity = 0;
  let lastPoKey = '';

  for (let r = headerRow + 1; r <= lastDataRow; r += 1) {
    const fields = readPrRowFields(worksheet.getRow(r), colMap);
    if (!rowHasIdentity(fields)) {
      skippedNoIdentity += 1;
      continue;
    }
    const key = poKeyFromFields(fields) || lastPoKey;
    if (!key) {
      skippedNoIdentity += 1;
      continue;
    }
    lastPoKey = key;
    parsedRows.push({ excel_row: r, sheet_name: worksheet.name, po_key: key, fields });
  }

  return {
    rows: parsedRows,
    sheetName: worksheet.name,
    headerRow,
    parseStats: {
      scanned_through_row: lastDataRow,
      skipped_no_identity: skippedNoIdentity,
    },
  };
}

function parseQuotationRowsWorkbook(workbook) {
  const worksheet = findQuotationRowsWorksheet(workbook);
  if (!worksheet) {
    return {
      rows: [],
      sheetName: null,
      headerRow: null,
      parseStats: { scanned_through_row: 0, skipped_no_identity: 0 },
    };
  }

  const layout = detectQuotationRowsColumnMap(worksheet);
  if (!layout) throw new Error('Could not detect "Quotation rows" header columns');

  const { headerRow, col: colMap } = layout;
  const lastDataRow = getWorksheetEndRow(worksheet, headerRow);
  const parsedRows = [];
  let skippedNoIdentity = 0;
  let lastPoKey = '';

  for (let r = headerRow + 1; r <= lastDataRow; r += 1) {
    const fields = readQuotationRowFields(worksheet.getRow(r), colMap);
    const key = poKeyFromQuotationFields(fields) || lastPoKey;
    if (!key) {
      skippedNoIdentity += 1;
      continue;
    }
    if (!String(fields.itemName || '').trim()) {
      skippedNoIdentity += 1;
      continue;
    }
    lastPoKey = key;
    parsedRows.push({ excel_row: r, sheet_name: worksheet.name, po_key: key, fields });
  }

  return {
    rows: parsedRows,
    sheetName: worksheet.name,
    headerRow,
    parseStats: {
      scanned_through_row: lastDataRow,
      skipped_no_identity: skippedNoIdentity,
    },
  };
}

function parseRawPoDetailWorkbook(workbook) {
  const worksheet = findRawPoDetailWorksheet(workbook);
  if (!worksheet) {
    return {
      rows: [],
      sheetName: null,
      headerRow: null,
      parseStats: { scanned_through_row: 0, skipped_no_identity: 0 },
    };
  }

  const layout = detectRawPoDetailColumnMap(worksheet);
  if (!layout) throw new Error('Could not detect "Raw PO Detail (reconcile)" header columns');

  const { headerRow, col: colMap } = layout;
  const lastDataRow = getWorksheetEndRow(worksheet, headerRow);
  const parsedRows = [];
  let skippedNoIdentity = 0;
  let lastPoKey = '';

  for (let r = headerRow + 1; r <= lastDataRow; r += 1) {
    const fields = readRawPoDetailRowFields(worksheet.getRow(r), colMap);
    const key = poKeyFromRawDetailFields(fields) || lastPoKey;
    if (!key || !String(fields.itemName || '').trim()) {
      skippedNoIdentity += 1;
      continue;
    }
    lastPoKey = key;
    parsedRows.push({ excel_row: r, sheet_name: worksheet.name, po_key: key, fields });
  }

  return {
    rows: parsedRows,
    sheetName: worksheet.name,
    headerRow,
    parseStats: {
      scanned_through_row: lastDataRow,
      skipped_no_identity: skippedNoIdentity,
    },
  };
}

async function resolveVendorByZohoId(zohoId, vendorName) {
  const zid = String(zohoId || '').trim();
  if (zid) {
    const byZoho = await VendorClient.findOne({ where: { type: 'vendor', zoho_id: zid } });
    if (byZoho) return byZoho;
  }
  const vn = String(vendorName || '').trim();
  if (!vn) return null;
  return VendorClient.findOne({ where: { type: 'vendor', name: vn } });
}

function groupPrRowsToPoPayloads(rows) {
  const out = new Map();
  for (const row of rows || []) {
    const key = String(row.po_key || '').trim();
    if (!key) continue;
    const item = prRowFieldsToItem(row.fields);
    if (!out.has(key)) {
      const header = buildPoHeaderFromFirstRow(row.fields);
      out.set(key, {
        excel_rows: [row.excel_row],
        payload: { ...header, items: [item] },
      });
      continue;
    }
    const prev = out.get(key);
    prev.excel_rows.push(row.excel_row);
    prev.payload.items.push(item);
    if (!prev.payload.vendor_name) {
      prev.payload.vendor_name = String(row.fields.preferredVendor || '').trim() || null;
    }
  }
  return out;
}

function applyQuotationRowsToGroupedPos(grouped, quotationRows) {
  if (!(grouped instanceof Map) || !Array.isArray(quotationRows) || quotationRows.length === 0) {
    return grouped;
  }

  const groupedBySku = new Map();
  for (const [poKey, entry] of grouped.entries()) {
    const skuMap = new Map();
    const items = Array.isArray(entry.payload?.items) ? entry.payload.items : [];
    for (const item of items) {
      const sku = String(item?.sku || '').trim().toUpperCase();
      if (!sku) continue;
      skuMap.set(sku, item);
    }
    groupedBySku.set(poKey, skuMap);
  }

  for (const q of quotationRows) {
    const poKey = String(q.po_key || '').trim();
    const entry = grouped.get(poKey);
    if (!entry) continue;

    const qFields = q.fields || {};
    const qItem = quotationRowFieldsToItem(qFields);
    const sku = String(qItem.sku || '').trim().toUpperCase();
    const skuMap = groupedBySku.get(poKey);
    const target = sku && skuMap && skuMap.get(sku)
      ? skuMap.get(sku)
      : Array.isArray(entry.payload.items)
        ? entry.payload.items.find((it) => String(it.productName || '').trim() === String(qItem.productName || '').trim())
        : null;
    if (target) {
      if (qItem.quotedQty != null) target.quotedQty = qItem.quotedQty;
      if (qItem.quantity != null && (target.quantity == null || target.quantity === 0)) target.quantity = qItem.quantity;
      if (qItem.unitPrice != null) target.unitPrice = qItem.unitPrice;
      if (qItem.taxPercent != null) target.taxPercent = qItem.taxPercent;
      if (qItem.taxAmount != null) target.taxAmount = qItem.taxAmount;
      if (qItem.itemTotal != null) target.itemTotal = qItem.itemTotal;
      if (qItem.currency) target.currency = qItem.currency;
      if (qItem.hsnCode && !target.hsnCode) target.hsnCode = qItem.hsnCode;
      if (qItem.uom && !target.uom) target.uom = qItem.uom;
    } else {
      entry.payload.items.push(qItem);
    }

    entry.excel_rows.push(q.excel_row);
    const fd = entry.payload.form_data || {};
    fd.vendorFromQuotation = String(qFields.vendor || '').trim() || fd.vendorFromQuotation || '';
    fd.vendorZohoId = String(qFields.vendorZohoId || '').trim() || fd.vendorZohoId || '';
    fd.vendorGstin = String(qFields.vendorGstin || '').trim() || fd.vendorGstin || '';
    fd.gstTreatment = String(qFields.gstTreatment || '').trim() || fd.gstTreatment || '';
    fd.currency = String(qFields.currency || '').trim() || fd.currency || '';
    fd.quotationDate = toDateOnly(qFields.quotationDate) || fd.quotationDate || '';
    fd.validityOrExpectedArrival =
      toDateOnly(qFields.validityExpectedArrival) ||
      String(qFields.validityExpectedArrival || '').trim() ||
      fd.validityOrExpectedArrival ||
      '';
    fd.paymentTerms = String(qFields.paymentTerms || '').trim() || fd.paymentTerms || '';
    fd.confirmed = String(qFields.confirmed || '').trim() || fd.confirmed || '';
    entry.payload.form_data = fd;

    if (!entry.payload.vendor_name) {
      entry.payload.vendor_name = String(qFields.vendor || '').trim() || entry.payload.vendor_name;
    }
  }

  return grouped;
}

function applyRawPoDetailsToGroupedPos(grouped, rawRows) {
  if (!(grouped instanceof Map) || !Array.isArray(rawRows) || rawRows.length === 0) {
    return grouped;
  }

  // Raw PO Detail is item-level and keys by Purchase Order Number.
  // PR rows group keys may be EI reference, so keep a secondary lookup by source PO number.
  const groupedBySourcePoNumber = new Map();
  for (const [groupKey, entry] of grouped.entries()) {
    const sourcePoNumber = String(
      entry?.payload?.form_data?.sourcePoNumber || entry?.payload?.reference || ''
    ).trim();
    if (!sourcePoNumber) continue;
    groupedBySourcePoNumber.set(sourcePoNumber, groupKey);
  }

  for (const rr of rawRows) {
    const poKey = String(rr.po_key || '').trim();
    let entry = grouped.get(poKey);
    if (!entry) {
      const groupKeyBySource = groupedBySourcePoNumber.get(poKey);
      if (groupKeyBySource) entry = grouped.get(groupKeyBySource);
    }
    if (!entry) continue;
    const fields = rr.fields || {};
    const rawItem = rawPoDetailFieldsToItem(fields);

    const matchBySku = String(rawItem.sku || '').trim().toUpperCase();
    const target = Array.isArray(entry.payload.items)
      ? (matchBySku
          ? entry.payload.items.find((i) => String(i.sku || '').trim().toUpperCase() === matchBySku)
          : null) ||
        entry.payload.items.find(
          (i) =>
            String(i.productName || '').trim().toLowerCase() ===
            String(rawItem.productName || '').trim().toLowerCase()
        )
      : null;

    if (target) {
      if (rawItem.itemDesc && !target.itemDesc) target.itemDesc = rawItem.itemDesc;
      if (rawItem.quantityOrdered != null) target.quantityOrdered = rawItem.quantityOrdered;
      if (rawItem.quantity != null && (target.quantity == null || target.quantity === 0)) target.quantity = rawItem.quantity;
      if (rawItem.quantityReceived != null) target.quantityReceived = rawItem.quantityReceived;
      if (rawItem.quantityCancelled != null) target.quantityCancelled = rawItem.quantityCancelled;
      if (rawItem.quantityBilled != null) target.quantityBilled = rawItem.quantityBilled;
      if (rawItem.unitPrice != null) target.unitPrice = rawItem.unitPrice;
      if (rawItem.taxPercent != null) target.taxPercent = rawItem.taxPercent;
      if (rawItem.taxAmount != null) target.taxAmount = rawItem.taxAmount;
      if (rawItem.itemTotal != null) target.itemTotal = rawItem.itemTotal;
      if (rawItem.uom && !target.uom) target.uom = rawItem.uom;
      if (rawItem.hsnCode && !target.hsnCode) target.hsnCode = rawItem.hsnCode;
      if (rawItem.currency) target.currency = rawItem.currency;
    } else {
      entry.payload.items.push(rawItem);
    }

    const fd = entry.payload.form_data || {};
    fd.purchaseOrderNumber = String(fields.purchaseOrderNumber || '').trim() || fd.purchaseOrderNumber || '';
    fd.vendorFromRawPo = String(fields.vendorName || '').trim() || fd.vendorFromRawPo || '';
    fd.vendorGstin = String(fields.vendorGstin || '').trim() || fd.vendorGstin || '';
    fd.gstTreatment = String(fields.gstTreatment || '').trim() || fd.gstTreatment || '';
    fd.purchaseOrderDate = toDateOnly(fields.purchaseOrderDate) || fd.purchaseOrderDate || '';
    fd.deliveryDate = toDateOnly(fields.deliveryDate) || fd.deliveryDate || '';
    fd.expectedArrivalDate = toDateOnly(fields.expectedArrivalDate) || fd.expectedArrivalDate || '';
    fd.paymentTerms = String(fields.paymentTermsLabel || '').trim() || fd.paymentTerms || '';
    fd.currency = String(fields.currencyCode || '').trim() || fd.currency || '';
    const total = parseOptionalNumber(fields.poTotal);
    if (total != null) fd.poTotal = total;
    entry.payload.form_data = fd;

    if (!entry.payload.vendor_name) {
      entry.payload.vendor_name = String(fields.vendorName || '').trim() || entry.payload.vendor_name;
    }
    if (!entry.payload.order_date) {
      entry.payload.order_date = toDateOnly(fields.purchaseOrderDate);
    }
    if (!entry.payload.expected_shipment_date) {
      entry.payload.expected_shipment_date =
        toDateOnly(fields.deliveryDate) || toDateOnly(fields.expectedArrivalDate);
    }
    if (!entry.payload.payment_terms) {
      entry.payload.payment_terms = String(fields.paymentTermsLabel || '').trim() || null;
    }
  }
  return grouped;
}

/**
 * @param {Map<string, {excel_rows:number[], payload:any}>} grouped
 * @param {{details?: boolean, createdBy?: string}} opts
 */
async function executePrRowsImport(grouped, opts = {}) {
  const details = !!opts.details;
  const createdBy = opts.createdBy || 'PR rows import';
  const materialLookup = opts.materialLookup || null;
  const summary = { created: 0, updated: 0, skipped: 0, errors: 0, row_log: [] };

  for (const [key, entry] of grouped.entries()) {
    const logBase = { po_key: key, excel_rows: entry.excel_rows };
    try {
      const payload = entry.payload;
      payload.form_data = payload.form_data || {};
      payload.form_data.createdBy = createdBy;
      payload.items = enrichItemsWithMaterialLookup(payload.items, materialLookup);
      const vendor = await resolveVendorByZohoId(
        payload.form_data.preferredVendorZohoId || payload.form_data.vendorZohoId,
        payload.vendor_name
      );
      const vendorPlain = vendor && vendor.get ? vendor.get({ plain: true }) : vendor;
      if (vendorPlain && vendorPlain.id) {
        payload.form_data.vendorClientId = vendorPlain.id;
        payload.form_data.vendorId = vendorPlain.id;
        if (vendorPlain.name) payload.vendor_name = vendorPlain.name;
      }

      const existing = await PurchaseOrder.findOne({ where: { order_id: payload.order_id } });
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
          vendor_name: payload.vendor_name ?? existing.vendor_name,
          order_date: payload.order_date ?? existing.order_date,
          expected_shipment_date: payload.expected_shipment_date ?? existing.expected_shipment_date,
          reference: payload.reference ?? existing.reference,
          status: payload.status ?? existing.status,
          order_status: mergedOs,
          form_data: mergedFd,
          items: Array.isArray(payload.items) ? payload.items : [],
        });
        summary.updated += 1;
        if (details) summary.row_log.push({ ...logBase, action: 'updated', order_id: payload.order_id });
      } else {
        await PurchaseOrder.create(payload);
        summary.created += 1;
        if (details) summary.row_log.push({ ...logBase, action: 'created', order_id: payload.order_id });
      }
    } catch (err) {
      summary.errors += 1;
      if (details) summary.row_log.push({ ...logBase, action: 'error', reason: err.message || String(err) });
    }
  }

  return summary;
}

async function postPrRowsExcelImport(req, res) {
  try {
    if (!req.user) return res.sendStatus(401);
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Expected multipart file field "file" (.xlsx or .xlsm)' });
    }
    const details =
      req.query.details === '1' || req.query.details === 'true' || req.body?.details === true;

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);

    if (findPurchaseOrderWorksheet(workbook)) {
      const parsed = parsePurchaseOrderFlatWorkbook(workbook);
      if (!parsed.rows.length) {
        return res.status(400).json({
          error:
            'No purchase order rows found on "PurchaseOrder". Need Purchase Order Number and line items.',
          sheet: parsed.sheetName,
          header_row: parsed.headerRow,
          parse_stats: parsed.parseStats ?? null,
        });
      }
      if (parsed.rows.length > MAX_DATA_ROWS) {
        return res.status(400).json({ error: `At most ${MAX_DATA_ROWS} data rows per file` });
      }

      const grouped = groupPurchaseOrderFlatRows(parsed.rows);
      const materialLookup = await buildMaterialSkuLookup();
      const createdBy =
        req.user.fullName || req.user.email || req.user.name || 'PurchaseOrder import';
      const summary = await executePrRowsImport(grouped, { details, createdBy, materialLookup });
      return res.json({
        ok: true,
        format: 'purchase_order_flat',
        rows_total: parsed.rows.length,
        po_groups_total: grouped.size,
        sheet: parsed.sheetName,
        header_row: parsed.headerRow,
        parse_stats: parsed.parseStats ?? null,
        quotation_sheet: null,
        quotation_header_row: null,
        quotation_rows_total: 0,
        quotation_parse_stats: null,
        raw_detail_sheet: null,
        raw_detail_header_row: null,
        raw_detail_rows_total: 0,
        raw_detail_parse_stats: null,
        summary: {
          purchase_orders_created: summary.created,
          purchase_orders_updated: summary.updated,
          skipped: summary.skipped,
          errors: summary.errors,
        },
        ...(details ? { row_log: summary.row_log } : {}),
      });
    }

    const parsed = parsePrRowsWorkbook(workbook);
    const quotationParsed = parseQuotationRowsWorkbook(workbook);
    const rawDetailParsed = parseRawPoDetailWorkbook(workbook);
    if (!parsed.rows.length) {
      return res.status(400).json({
        error: 'No PO rows found on "PR rows". Need EI PO Reference / Source PO Number + Item Name.',
        sheet: parsed.sheetName,
        header_row: parsed.headerRow,
      });
    }
    if (parsed.rows.length > MAX_DATA_ROWS) {
      return res.status(400).json({ error: `At most ${MAX_DATA_ROWS} data rows per file` });
    }

    const grouped = groupPrRowsToPoPayloads(parsed.rows);
    applyQuotationRowsToGroupedPos(grouped, quotationParsed.rows);
    applyRawPoDetailsToGroupedPos(grouped, rawDetailParsed.rows);
    const materialLookup = await buildMaterialSkuLookup();
    const createdBy = req.user.fullName || req.user.email || req.user.name || 'PR rows import';
    const summary = await executePrRowsImport(grouped, { details, createdBy, materialLookup });
    return res.json({
      ok: true,
      format: 'pr_rows_split',
      rows_total: parsed.rows.length,
      po_groups_total: grouped.size,
      sheet: parsed.sheetName,
      header_row: parsed.headerRow,
      parse_stats: parsed.parseStats ?? null,
      quotation_sheet: quotationParsed.sheetName,
      quotation_header_row: quotationParsed.headerRow,
      quotation_rows_total: quotationParsed.rows.length,
      quotation_parse_stats: quotationParsed.parseStats ?? null,
      raw_detail_sheet: rawDetailParsed.sheetName,
      raw_detail_header_row: rawDetailParsed.headerRow,
      raw_detail_rows_total: rawDetailParsed.rows.length,
      raw_detail_parse_stats: rawDetailParsed.parseStats ?? null,
      summary: {
        purchase_orders_created: summary.created,
        purchase_orders_updated: summary.updated,
        skipped: summary.skipped,
        errors: summary.errors,
      },
      ...(details ? { row_log: summary.row_log } : {}),
    });
  } catch (err) {
    console.error('[pr-rows-excel] import error', err);
    return res.status(500).json({ error: err.message || 'PR rows import failed' });
  }
}

const uploadPrRowsExcelMiddleware = multer({
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

function uploadPrRowsExcelSafe(req, res, next) {
  uploadPrRowsExcelMiddleware(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    return next();
  });
}

module.exports = {
  PURCHASE_ORDER_SHEET,
  PURCHASE_ORDER_FLAT_ALIASES,
  PR_ROWS_SHEET,
  QUOTATION_ROWS_SHEET,
  RAW_PO_DETAIL_SHEET,
  HEADER_ALIASES,
  QUOTATION_HEADER_ALIASES,
  RAW_DETAIL_HEADER_ALIASES,
  normalizeSheetName,
  findPurchaseOrderWorksheet,
  findPrRowsWorksheet,
  findQuotationRowsWorksheet,
  findRawPoDetailWorksheet,
  detectPurchaseOrderColumnMap,
  detectPrRowsColumnMap,
  detectQuotationRowsColumnMap,
  detectRawPoDetailColumnMap,
  prRowFieldsToItem,
  quotationRowFieldsToItem,
  rawPoDetailFieldsToItem,
  purchaseOrderFlatFieldsToItem,
  buildPoHeaderFromFirstRow,
  buildPoHeaderFromFlatFields,
  parsePurchaseOrderFlatWorkbook,
  parsePrRowsWorkbook,
  parseQuotationRowsWorkbook,
  parseRawPoDetailWorkbook,
  groupPrRowsToPoPayloads,
  groupPurchaseOrderFlatRows,
  applyQuotationRowsToGroupedPos,
  applyRawPoDetailsToGroupedPos,
  buildMaterialSkuLookup,
  enrichItemsWithMaterialLookup,
  executePrRowsImport,
  uploadPrRowsExcelSafe,
  postPrRowsExcelImport,
};


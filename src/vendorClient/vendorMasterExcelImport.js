/**
 * POST /api/v1/vendor-client/import-vendor-excel
 * Vendor master workbook: "Active Vendors" + optional "Additional POCs" / "Additional Addresses".
 * Ignores Summary and tabs without vendor identity columns.
 */
const ExcelJS = require('exceljs');
const multer = require('multer');
const VendorClient = require('./models');
const { cellToText } = require('../masterBulk/masterExcelFlexibleParse');
const { allocateNextEntityCode } = require('./userLink');
const {
  findLastDataRow,
  readRowFields,
  readZohoContactIdFromCell,
  resolveLegalTradeNames,
  rowHasMasterIdentity,
  prepareMasterImportRows,
  buildZohoColumnOverlayFromXlsx,
  applyZohoOverlayToFields,
  resolveZohoFromExcelFields,
  buildMasterImportFingerprint,
  resolveZohoLookupKey,
  findExistingMasterImportRow,
} = require('./vendorClientExcelParseUtils');

const VENDOR_IDENTITY_KEYS = [
  'zohoContactId',
  'legalName',
  'tradeName',
  'primaryEmail',
  'primaryPhone',
  'gstin',
  'pan',
  'billingAddress',
  'shippingAddress',
];

const ACTIVE_VENDORS_SHEET = 'active vendors';
const ADDITIONAL_POCS_SHEET = 'additional pocs';
const ADDITIONAL_ADDRESSES_SHEET_NAMES = ['additional addresses', 'addiional addresses'];
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_DATA_ROWS = 10000;
const CHUNK_SIZE = 100;
const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

/** Entity Type, Setup Category, Sales Owner / Vendor Owner, Source are not imported. */
const HEADER_ALIASES = {
  zohoContactId: ['zoho contact id', 'zoho id', 'contact id'],
  setupCategoryHint: [
    'setup category hint (cf. category)',
    'setup category hint cf category',
    'setup category hint',
    'cf.category',
    'cf category',
  ],
  legalName: ['legal name', 'company name'],
  tradeName: ['trade name', 'display name', 'vendor name', 'contact name'],
  primaryEmail: ['primary email', 'email', 'emailid'],
  primaryPhone: ['primary phone', 'phone', 'mobilephone'],
  status: ['status'],
  billingAttention: ['billing attention'],
  billingAddress: ['billing address'],
  billingCity: ['billing city'],
  billingState: ['billing state'],
  billingCountry: ['billing country'],
  billingPincode: ['billing pincode', 'billing code', 'billing zip', 'billing postal code'],
  billingPhone: ['billing phone', 'billling phone'],
  shippingAttention: ['shipping attention'],
  shippingAddress: ['shipping address'],
  shippingCity: ['shipping city'],
  shippingState: ['shipping state'],
  shippingCountry: ['shipping country'],
  shippingPincode: ['shipping pincode', 'shipping code', 'shipping zip'],
  shippingPhone: ['shipping phone'],
  state: ['state'],
  country: ['country'],
  website: ['website'],
  segment: ['segment'],
  notes: ['notes'],
  gstin: ['gstin', 'gst identification number (gstin)'],
  pan: ['pan', 'pan no', 'pan number'],
  gstTreatment: ['gst treatment'],
  msmeUdyamNo: ['msme / udyam no', 'msme udyam no', 'udyam no'],
  msmeUdyamType: ['msme / udyam type', 'msme udyam type', 'udyam type'],
  tdsName: ['tds name'],
  tdsPercent: ['tds %', 'tds percent', 'tds percentage'],
  tdsSection: ['tds section'],
  tdsSectionCode: ['tds section code'],
  tdsApplicable: ['tds applicable'],
  paymentTerms: ['payment terms'],
  paymentTermsDays: ['payment terms days', 'payment term days'],
  beneficiaryName: ['beneficiary name'],
  bankName: ['bank name'],
  bankAccountNumber: ['bank account number', 'account number'],
  bankIfsc: ['ifsc / bank code', 'ifsc', 'bank code', 'ifsc code'],
  currencyCode: ['currency code', 'curreny code', 'currency'],
  createdTime: ['created time'],
  lastModifiedTime: ['last modified time', 'modified time'],
};

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
function findActiveVendorsWorksheet(workbook) {
  for (const ws of workbook.worksheets || []) {
    if (normalizeSheetName(ws.name) === ACTIVE_VENDORS_SHEET) return ws;
  }
  for (const ws of workbook.worksheets || []) {
    if (normalizeSheetName(ws.name) === 'summary') continue;
    if (detectActiveVendorsColumnMap(ws)) return ws;
  }
  return null;
}

/**
 * @param {import('exceljs').Workbook} workbook
 */
function findAdditionalPocsWorksheet(workbook) {
  for (const ws of workbook.worksheets || []) {
    if (normalizeSheetName(ws.name) === ADDITIONAL_POCS_SHEET) return ws;
  }
  return null;
}

/**
 * @param {import('exceljs').Workbook} workbook
 */
function findAdditionalAddressesWorksheet(workbook) {
  for (const ws of workbook.worksheets || []) {
    if (ADDITIONAL_ADDRESSES_SHEET_NAMES.includes(normalizeSheetName(ws.name))) return ws;
  }
  return null;
}

function detectActiveVendorsColumnMap(worksheet, maxScanRow = 8) {
  const lastCol = Math.min(worksheet.columnCount || 60, 120);
  for (let r = 1; r <= maxScanRow; r += 1) {
    const row = worksheet.getRow(r);
    const map = {};
    for (let c = 1; c <= lastCol; c += 1) {
      const label = normalizeHeaderLabel(cellToText(row.getCell(c)));
      if (!label) continue;
      for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
        if (map[key]) continue;
        if (aliases.some((a) => label === a)) map[key] = c;
      }
    }

    const hasIdentity =
      map.zohoContactId != null || map.legalName != null || map.tradeName != null;
    const hasVendorHint =
      map.setupCategoryHint != null || map.gstin != null || map.tdsApplicable != null;
    if (hasIdentity && (hasVendorHint || map.primaryEmail != null)) {
      return { headerRow: r, col: map };
    }
  }
  return null;
}

/** Columns on "Additional POCs". Vendor Name and Is Primary POC are not imported. */
const ADDITIONAL_POCS_HEADER_ALIASES = {
  vendorZohoContactId: ['zoho contact id', 'zoho id', 'contact id'],
  salutation: ['salutation', 'sakutation'],
  pocFirstName: ['poc first name', 'first name'],
  pocLastName: ['poc last name', 'last name'],
  pocEmail: ['poc email', 'email', 'poc emailid', 'emailid'],
  pocPhone: ['poc phone', 'phone'],
  pocMobile: ['poc mobile', 'mobilephone', 'mobile'],
  pocDepartment: ['poc department', 'department'],
  pocDesignation: ['poc designation', 'designation', 'role'],
  lastModifiedTime: ['last modified time', 'last modifie time', 'modified time'],
};

function detectAdditionalPocsColumnMap(worksheet, maxScanRow = 8) {
  const lastCol = Math.min(worksheet.columnCount || 60, 100);
  for (let r = 1; r <= maxScanRow; r += 1) {
    const row = worksheet.getRow(r);
    const map = {};
    for (let c = 1; c <= lastCol; c += 1) {
      const label = normalizeHeaderLabel(cellToText(row.getCell(c)));
      if (!label) continue;
      for (const [key, aliases] of Object.entries(ADDITIONAL_POCS_HEADER_ALIASES)) {
        if (map[key]) continue;
        if (aliases.some((a) => label === a)) map[key] = c;
      }
    }

    const hasVendorIdentity = map.vendorZohoContactId != null;
    const hasContactBits =
      map.pocFirstName != null ||
      map.pocLastName != null ||
      map.pocEmail != null ||
      map.pocPhone != null ||
      map.pocMobile != null ||
      map.pocDesignation != null ||
      map.pocDepartment != null;
    if (hasVendorIdentity && hasContactBits) {
      return { headerRow: r, col: map };
    }
  }
  return null;
}

function vendorPocFieldsToPocObject(fields) {
  const first = String(fields.pocFirstName || '').trim();
  const last = String(fields.pocLastName || '').trim();
  const name = [first, last].filter(Boolean).join(' ').trim();

  const email = String(fields.pocEmail || '').trim().toLowerCase();
  const phone = String(fields.pocPhone || '').trim() || String(fields.pocMobile || '').trim();
  const designation = String(fields.pocDesignation || '').trim();
  const department = String(fields.pocDepartment || '').trim();
  let role = designation;
  if (department) {
    role = role ? `${role} — ${department}` : department;
  }

  const salutation = String(fields.salutation || '').trim();
  const lastModified = String(fields.lastModifiedTime || '').trim();
  const noteParts = [salutation, lastModified ? `Modified: ${lastModified}` : ''].filter(Boolean);

  return {
    name: name || 'POC',
    role: role || '',
    email: email || '',
    phone: phone || '',
    level: 'L2 (Escalation)',
    preferred: 'No',
    notes: noteParts.join(' · ') || '',
    ...(department ? { department } : {}),
    ...(salutation ? { salutation } : {}),
    ...(lastModified ? { excelLastModifiedTime: lastModified } : {}),
  };
}

function readCell(row, colKey, colMap, zohoOverlay, excelRow) {
  const idx = colMap[colKey];
  if (!idx) return '';
  const cell = row.getCell(idx);
  if (colKey === 'vendorZohoContactId' || colKey === 'clientZohoContactId') {
    const overlayId = zohoOverlay?.byRow?.[excelRow]?.id;
    if (overlayId) return overlayId;
    return readZohoContactIdFromCell(cell);
  }
  return cellToText(cell);
}

function normalizeStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'active') return 'active';
  if (s === 'inactive') return 'inactive';
  if (s) return 'pending';
  return 'active';
}

function buildAddressObject(attention, address, city, state, country, pincode, phone) {
  const line = String(address || '').trim();
  const hasParts =
    line ||
    String(city || '').trim() ||
    String(state || '').trim() ||
    String(country || '').trim() ||
    String(pincode || '').trim();
  if (!hasParts) return null;
  return {
    attention: String(attention || '').trim() || undefined,
    address: line || undefined,
    street: line || undefined,
    city: String(city || '').trim() || undefined,
    state: String(state || '').trim() || undefined,
    country: String(country || '').trim() || undefined,
    zip: String(pincode || '').trim() || undefined,
    pincode: String(pincode || '').trim() || undefined,
    phone: String(phone || '').trim() || undefined,
  };
}

function composePaymentTerms(termsLabel, termsDays) {
  const label = String(termsLabel || '').trim();
  const daysRaw = String(termsDays ?? '').trim();
  if (label) return label;
  if (!daysRaw) return null;
  const days = parseInt(daysRaw.replace(/[^\d]/g, ''), 10);
  if (Number.isFinite(days) && days > 0) return `NET ${days}`;
  return daysRaw;
}

function composeMsme(no, type) {
  const n = String(no || '').trim();
  const t = String(type || '').trim();
  if (n && t) return `${n} / ${t}`;
  return n || t || '';
}

function bankFromExcelFields(fields) {
  const beneficiaryName = String(fields.beneficiaryName || '').trim();
  const bankName = String(fields.bankName || '').trim();
  const accountNo = String(fields.bankAccountNumber || '').trim();
  const ifsc = String(fields.bankIfsc || '').trim();
  if (!beneficiaryName && !bankName && !accountNo && !ifsc) return [];
  return [
    {
      beneficiaryName,
      bankName,
      accountNo,
      branch: '',
      accountType: '',
      ifsc,
      upiId: '',
      isDefault: 'Yes',
      notes: '',
    },
  ];
}

/**
 * @param {Record<string, string>} fields
 */
function rowHasVendorIdentityFields(fields) {
  return rowHasMasterIdentity(fields, VENDOR_IDENTITY_KEYS);
}

function excelFieldsToVendorMasterPayload(fields) {
  const names = resolveLegalTradeNames({
    legalName: fields.legalName,
    tradeName: fields.tradeName,
    email: fields.primaryEmail,
    zohoId: fields.zohoContactId,
    fallbackPrefix: 'Vendor',
  });
  if (!names.displayName) return null;

  const { legalName, tradeName, displayName, email } = names;
  const zohoResolved = resolveZohoFromExcelFields(fields);
  const zohoId = zohoResolved.displayId;
  const phone = String(fields.primaryPhone || '').trim();
  const vendorState = String(fields.state || fields.billingState || '').trim();
  const vendorCountry =
    String(fields.country || fields.billingCountry || 'India').trim() || 'India';
  const vendorCity = String(fields.billingCity || fields.shippingCity || '').trim();

  const categoryHint = String(fields.setupCategoryHint || '').trim();
  const category = categoryHint || 'Vendor';

  const billingObj = buildAddressObject(
    fields.billingAttention,
    fields.billingAddress,
    fields.billingCity,
    fields.billingState,
    fields.billingCountry,
    fields.billingPincode,
    fields.billingPhone,
  );
  const shippingObj = buildAddressObject(
    fields.shippingAttention,
    fields.shippingAddress,
    fields.shippingCity,
    fields.shippingState,
    fields.shippingCountry,
    fields.shippingPincode,
    fields.shippingPhone,
  );

  const billingLines = billingObj
    ? [billingObj.address, billingObj.city, billingObj.state, billingObj.zip, billingObj.country]
        .filter(Boolean)
        .join(', ')
    : String(fields.billingAddress || '').trim();
  const shippingLines = shippingObj
    ? [shippingObj.address, shippingObj.city, shippingObj.state, shippingObj.zip, shippingObj.country]
        .filter(Boolean)
        .join(', ')
    : String(fields.shippingAddress || '').trim();

  const paymentTerms = composePaymentTerms(fields.paymentTerms, fields.paymentTermsDays);
  const msmeUdyamNo = String(fields.msmeUdyamNo || '').trim();
  const msmeUdyamType = String(fields.msmeUdyamType || '').trim();
  const banks = bankFromExcelFields(fields);

  const data = {
    setupType: 'VENDOR',
    setupPrefix: 'VEN',
    setupCategory: category,
    cfCategory: categoryHint || undefined,
    setupCategoryHint: categoryHint || undefined,
    zohoId: zohoId || undefined,
    zohoIdUnreliable: zohoResolved.unreliable ? true : undefined,
    legalName: legalName || displayName,
    tradeName: tradeName || legalName || displayName,
    primaryEmail: email,
    primaryPhone: phone,
    billingAddress: billingLines.slice(0, 500),
    shippingAddress: (shippingLines || billingLines).slice(0, 500),
    billingAddressObject: billingObj || undefined,
    shippingAddressObject: shippingObj || undefined,
    state: vendorState,
    country: vendorCountry,
    website: String(fields.website || '').trim(),
    segment: String(fields.segment || '').trim(),
    notes: String(fields.notes || '').trim(),
    gstin: String(fields.gstin || '').trim(),
    pan: String(fields.pan || '').trim().toUpperCase(),
    gstTreatment: String(fields.gstTreatment || '').trim(),
    msme: composeMsme(msmeUdyamNo, msmeUdyamType),
    msmeUdyamNo: msmeUdyamNo || undefined,
    msmeUdyamType: msmeUdyamType || undefined,
    tdsName: String(fields.tdsName || '').trim() || undefined,
    tdsPercent: String(fields.tdsPercent || '').trim() || undefined,
    tdsSection: String(fields.tdsSection || '').trim() || undefined,
    tdsSectionCode: String(fields.tdsSectionCode || '').trim() || undefined,
    tdsApplicable: String(fields.tdsApplicable || '').trim() || undefined,
    paymentTerms: paymentTerms || '',
    paymentTermsDays: String(fields.paymentTermsDays || '').trim(),
    currencyCode: String(fields.currencyCode || '').trim(),
    excelCreatedTime: String(fields.createdTime || '').trim() || undefined,
    excelLastModifiedTime: String(fields.lastModifiedTime || '').trim() || undefined,
    ...(banks.length > 0 ? { banks } : {}),
  };

  const payload = {
    type: 'vendor',
    zoho_id: zohoResolved.upsertId,
    name: displayName,
    email: email || null,
    phone: phone || null,
    location: vendorState || null,
    country: vendorCountry,
    city: vendorCity || null,
    category,
    status: normalizeStatus(fields.status),
    payment_terms: paymentTerms,
    notes: data.notes || null,
    segment: data.segment || null,
    data,
  };
  const fingerprint = buildMasterImportFingerprint(payload);
  if (fingerprint) payload.data.importFingerprint = fingerprint;
  return payload;
}

/**
 * @param {import('exceljs').Workbook} workbook
 */
function parseActiveVendorsWorkbook(workbook, opts = {}) {
  const zohoOverlay = opts.zohoOverlay || { byRow: {} };
  const worksheet = findActiveVendorsWorksheet(workbook);
  if (!worksheet) {
    throw new Error(
      'Worksheet "Active Vendors" not found. Use that tab name or include columns such as Legal Name and Setup Category Hint (CF. CATEGORY).',
    );
  }

  const header = detectActiveVendorsColumnMap(worksheet);
  if (!header) {
    throw new Error(
      'Could not find header row on vendor sheet. Expected columns such as Legal Name, Trade Name, or Zoho Contact ID.',
    );
  }

  const rows = [];
  const { headerRow, col } = header;
  const headerKeys = Object.keys(HEADER_ALIASES);
  let skippedNoIdentity = 0;
  let skippedNoName = 0;
  let zohoUnreliableRows = 0;

  const lastRow = findLastDataRow(worksheet, headerRow, (row) => {
    let fields = readRowFields(row, col, headerKeys);
    fields = applyZohoOverlayToFields(fields, zohoOverlay, row.number);
    return rowHasVendorIdentityFields(fields);
  });

  for (let r = headerRow + 1; r <= lastRow; r += 1) {
    const row = worksheet.getRow(r);
    let fields = readRowFields(row, col, headerKeys);
    fields = applyZohoOverlayToFields(fields, zohoOverlay, r);
    if (fields.zohoContactId && fields.zohoContactIdReliable !== true) {
      zohoUnreliableRows += 1;
    }
    if (!rowHasVendorIdentityFields(fields)) {
      skippedNoIdentity += 1;
      continue;
    }

    const payload = excelFieldsToVendorMasterPayload(fields);
    if (!payload) {
      skippedNoName += 1;
      continue;
    }

    rows.push({
      excel_row: r,
      sheet_name: worksheet.name,
      fields,
      payload,
    });
  }

  return {
    rows,
    sheetName: worksheet.name,
    headerRow,
    parseStats: {
      scanned_through_row: lastRow,
      skipped_no_identity: skippedNoIdentity,
      skipped_no_name: skippedNoName,
      zoho_unreliable_rows: zohoUnreliableRows,
      zoho_overlay_unreliable: zohoOverlay.unreliableCount ?? 0,
    },
  };
}

/**
 * @param {import('exceljs').Workbook} workbook
 * @param {{ pocsZohoOverlay?: { byRow: Record<number, { id: string }> }}} opts
 * @returns {{ pocsByZohoId: Record<string, Array<object>>, sheetName: string|null, headerRow: number|null }}
 */
function parseAdditionalPocsWorkbook(workbook, opts = {}) {
  const pocsZohoOverlay = opts.pocsZohoOverlay || { byRow: {} };
  const worksheet = findAdditionalPocsWorksheet(workbook);
  if (!worksheet) {
    return { pocsByZohoId: {}, sheetName: null, headerRow: null };
  }

  const header = detectAdditionalPocsColumnMap(worksheet);
  if (!header) {
    return { pocsByZohoId: {}, sheetName: worksheet.name, headerRow: null };
  }

  const { headerRow, col } = header;
  const lastRow = worksheet.actualRowCount || worksheet.rowCount || 0;
  const pocsByZohoId = {};

  for (let r = headerRow + 1; r <= lastRow; r += 1) {
    const row = worksheet.getRow(r);
    const fields = {};
    for (const key of Object.keys(ADDITIONAL_POCS_HEADER_ALIASES)) {
      fields[key] = readCell(row, key, col, pocsZohoOverlay, r);
    }

    const vendorZohoId = String(fields.vendorZohoContactId || '').trim();
    if (!vendorZohoId) continue;

    const hasAnyPocValue =
      String(fields.pocFirstName || '').trim() ||
      String(fields.pocLastName || '').trim() ||
      String(fields.pocEmail || '').trim() ||
      String(fields.pocPhone || '').trim() ||
      String(fields.pocMobile || '').trim() ||
      String(fields.pocDesignation || '').trim() ||
      String(fields.pocDepartment || '').trim();
    if (!hasAnyPocValue) continue;

    const pocObj = vendorPocFieldsToPocObject(fields);
    if (!pocsByZohoId[vendorZohoId]) pocsByZohoId[vendorZohoId] = [];
    pocsByZohoId[vendorZohoId].push(pocObj);
  }

  return { pocsByZohoId, sheetName: worksheet.name, headerRow };
}

/** Vendor Name and Zoho Address ID are not imported. */
const ADDITIONAL_ADDRESSES_HEADER_ALIASES = {
  vendorZohoContactId: ['zoho contact id', 'zoho id', 'contact id'],
  attention: ['attention'],
  addressLine1: ['address line 1', 'address line 1.'],
  addressLine2: ['address line 2', 'address line 2.'],
  city: ['city'],
  state: ['state'],
  country: ['country'],
  pincode: ['pincode', 'postal code', 'zip'],
  phone: ['phone'],
  gstinAtAddress: ['gstin at this address', 'gstin at address', 'gstin'],
  placeOfSupply: ['place of supply'],
};

function detectAdditionalAddressesColumnMap(worksheet, maxScanRow = 8) {
  const lastCol = Math.min(worksheet.columnCount || 60, 120);
  for (let r = 1; r <= maxScanRow; r += 1) {
    const row = worksheet.getRow(r);
    const map = {};
    for (let c = 1; c <= lastCol; c += 1) {
      const label = normalizeHeaderLabel(cellToText(row.getCell(c)));
      if (!label) continue;
      for (const [key, aliases] of Object.entries(ADDITIONAL_ADDRESSES_HEADER_ALIASES)) {
        if (map[key]) continue;
        if (aliases.some((a) => label === a)) map[key] = c;
      }
    }

    const hasVendor = map.vendorZohoContactId != null;
    const hasAddressBits = map.attention != null && map.addressLine1 != null;
    if (hasVendor && hasAddressBits) return { headerRow: r, col: map };
  }
  return null;
}

function vendorAdditionalAddressFieldsToObject(fields) {
  const attention = String(fields.attention || '').trim() || undefined;
  const address1 = String(fields.addressLine1 || '').trim() || undefined;
  const address2 = String(fields.addressLine2 || '').trim() || undefined;
  const city = String(fields.city || '').trim() || undefined;
  const state = String(fields.state || '').trim() || undefined;
  const country = String(fields.country || '').trim() || undefined;
  const pincode = String(fields.pincode || '').trim() || undefined;
  const phone = String(fields.phone || '').trim() || undefined;
  const gstin = String(fields.gstinAtAddress || '').trim() || undefined;
  const placeOfSupply = String(fields.placeOfSupply || '').trim() || undefined;

  const hasAny =
    attention ||
    address1 ||
    address2 ||
    city ||
    state ||
    country ||
    pincode ||
    phone ||
    gstin ||
    placeOfSupply;
  if (!hasAny) return null;

  return {
    attention,
    address: address1,
    street: address1,
    street2: address2,
    city,
    state,
    country,
    pincode,
    zip: pincode,
    phone,
    gstin,
    placeOfSupply,
  };
}

/**
 * @param {import('exceljs').Workbook} workbook
 * @returns {{ additionalAddressesByZohoId: Record<string, Array<object>>, sheetName: string|null, headerRow: number|null }}
 */
function parseAdditionalAddressesWorkbook(workbook, opts = {}) {
  const addressesZohoOverlay = opts.addressesZohoOverlay || { byRow: {} };
  const worksheet = findAdditionalAddressesWorksheet(workbook);
  if (!worksheet) {
    return { additionalAddressesByZohoId: {}, sheetName: null, headerRow: null };
  }

  const header = detectAdditionalAddressesColumnMap(worksheet);
  if (!header) {
    return { additionalAddressesByZohoId: {}, sheetName: worksheet.name, headerRow: null };
  }

  const { headerRow, col } = header;
  const lastRow = worksheet.actualRowCount || worksheet.rowCount || 0;
  const additionalAddressesByZohoId = {};

  for (let r = headerRow + 1; r <= lastRow; r += 1) {
    const row = worksheet.getRow(r);
    const fields = {};
    for (const key of Object.keys(ADDITIONAL_ADDRESSES_HEADER_ALIASES)) {
      fields[key] = readCell(row, key, col, addressesZohoOverlay, r);
    }

    const vendorZohoId = String(fields.vendorZohoContactId || '').trim();
    if (!vendorZohoId) continue;

    const addrObj = vendorAdditionalAddressFieldsToObject(fields);
    if (!addrObj) continue;

    if (!additionalAddressesByZohoId[vendorZohoId]) additionalAddressesByZohoId[vendorZohoId] = [];
    additionalAddressesByZohoId[vendorZohoId].push(addrObj);
  }

  return { additionalAddressesByZohoId, sheetName: worksheet.name, headerRow };
}

function mergeVendorData(existingData, incomingData) {
  const base =
    existingData && typeof existingData === 'object' && !Array.isArray(existingData)
      ? { ...existingData }
      : {};
  const merged = { ...base, ...incomingData };
  for (const key of [
    'documents',
    'pocs',
    'banks',
    'productInterests',
    'vendorItems',
    'additionalAddresses',
  ]) {
    if (Array.isArray(base[key]) && base[key].length > 0) {
      if (!Array.isArray(incomingData[key]) || incomingData[key].length === 0) {
        merged[key] = base[key];
      }
    }
  }
  return merged;
}

/**
 * @param {Array<{ excel_row: number, sheet_name: string, payload: object }>} rows
 * @param {{ details?: boolean }} opts
 */
async function executeVendorMasterImportRows(rows, opts = {}) {
  const details = opts.details === true;
  const pocsByZohoId = opts.pocsByZohoId || {};
  const additionalAddressesByZohoId = opts.additionalAddressesByZohoId || {};
  const summary = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    row_log: [],
  };

  for (const row of rows) {
    const logBase = { excel_row: row.excel_row, sheet: row.sheet_name };
    try {
      const incoming = row.payload;
      const existing = await findExistingMasterImportRow('vendor', incoming, VendorClient);

      if (existing) {
        const prevData =
          existing.data && typeof existing.data === 'object' ? existing.data : {};

        const lookupZohoId = resolveZohoLookupKey(incoming) || existing.zoho_id;
        const incomingPocs = lookupZohoId ? pocsByZohoId[lookupZohoId] || [] : [];
        const incomingAddresses = lookupZohoId
          ? additionalAddressesByZohoId[lookupZohoId] || []
          : [];
        const mergedData = mergeVendorData(prevData, incoming.data);
        if (incomingPocs.length > 0) mergedData.pocs = incomingPocs;
        if (incomingAddresses.length > 0) mergedData.additionalAddresses = incomingAddresses;

        await existing.update({
          zoho_id: incoming.zoho_id || existing.zoho_id,
          name: incoming.name || existing.name,
          email: incoming.email ?? existing.email,
          phone: incoming.phone ?? existing.phone,
          location: incoming.location ?? existing.location,
          country: incoming.country ?? existing.country,
          city: incoming.city ?? existing.city,
          category: incoming.category ?? existing.category,
          status: incoming.status ?? existing.status,
          payment_terms: incoming.payment_terms ?? existing.payment_terms,
          notes: incoming.notes ?? existing.notes,
          segment: incoming.segment ?? existing.segment,
          data: mergedData,
        });
        summary.updated += 1;
        if (details) {
          summary.row_log.push({
            ...logBase,
            action: 'updated',
            entity_code: existing.entity_code,
            zoho_id: existing.zoho_id,
          });
        }
        continue;
      }

      const entityCode = await allocateNextEntityCode('vendor');
      const lookupZohoId = resolveZohoLookupKey(incoming);
      const incomingPocs = lookupZohoId ? pocsByZohoId[lookupZohoId] || [] : [];
      const incomingAddresses =
        lookupZohoId && additionalAddressesByZohoId[lookupZohoId]
          ? additionalAddressesByZohoId[lookupZohoId]
          : [];
      const created = await VendorClient.create({
        entity_code: entityCode,
        type: 'vendor',
        zoho_id: incoming.zoho_id,
        name: incoming.name,
        email: incoming.email,
        phone: incoming.phone,
        location: incoming.location,
        country: incoming.country,
        city: incoming.city,
        category: incoming.category,
        status: incoming.status,
        payment_terms: incoming.payment_terms,
        notes: incoming.notes,
        segment: incoming.segment,
        data: {
          ...incoming.data,
          entityCode,
          ...(incomingPocs.length > 0 ? { pocs: incomingPocs } : {}),
          ...(incomingAddresses.length > 0 ? { additionalAddresses: incomingAddresses } : {}),
        },
      });

      summary.created += 1;
      if (details) {
        summary.row_log.push({
          ...logBase,
          action: 'created',
          entity_code: created.entity_code,
          zoho_id: created.zoho_id,
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

async function extractActiveVendorsFromBuffer(buffer) {
  const vendorZohoOverlay = buildZohoColumnOverlayFromXlsx(
    buffer,
    ACTIVE_VENDORS_SHEET,
    HEADER_ALIASES.zohoContactId,
  );
  const pocsZohoOverlay = buildZohoColumnOverlayFromXlsx(
    buffer,
    ADDITIONAL_POCS_SHEET,
    ADDITIONAL_POCS_HEADER_ALIASES.vendorZohoContactId,
  );
  let addressesZohoOverlay = { byRow: {} };
  for (const sheetName of ADDITIONAL_ADDRESSES_SHEET_NAMES) {
    const overlay = buildZohoColumnOverlayFromXlsx(
      buffer,
      sheetName,
      ADDITIONAL_ADDRESSES_HEADER_ALIASES.vendorZohoContactId,
    );
    if (Object.keys(overlay.byRow || {}).length > 0) {
      addressesZohoOverlay = overlay;
      break;
    }
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  if (!workbook.worksheets?.length) {
    throw new Error('Workbook has no worksheets');
  }

  const active = parseActiveVendorsWorkbook(workbook, { zohoOverlay: vendorZohoOverlay });
  const pocs = parseAdditionalPocsWorkbook(workbook, { pocsZohoOverlay });
  const additionalAddresses = parseAdditionalAddressesWorkbook(workbook, {
    addressesZohoOverlay,
  });
  return {
    ...active,
    pocsByZohoId: pocs.pocsByZohoId,
    pocsSheetName: pocs.sheetName,
    pocsHeaderRow: pocs.headerRow,
    additionalAddressesByZohoId: additionalAddresses.additionalAddressesByZohoId,
    additionalAddressesSheetName: additionalAddresses.sheetName,
    additionalAddressesHeaderRow: additionalAddresses.headerRow,
  };
}

async function postVendorMasterExcelImport(req, res) {
  try {
    if (!req.user) return res.sendStatus(401);
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Expected multipart file field "file" (.xlsx or .xlsm)' });
    }

    const details =
      req.query.details === '1' || req.query.details === 'true' || req.body?.details === true;

    let parsed;
    try {
      parsed = await extractActiveVendorsFromBuffer(req.file.buffer);
    } catch (loadErr) {
      console.error('[vendor-master-excel] parse error', loadErr);
      return res.status(400).json({ error: loadErr.message || 'Invalid Excel file' });
    }

    const {
      rows,
      sheetName,
      headerRow,
      pocsByZohoId,
      additionalAddressesByZohoId,
      parseStats,
    } = parsed;
    if (!rows.length) {
      return res.status(400).json({
        error:
          'No vendor rows found. Need Legal Name, Trade Name, Zoho Contact ID, or Primary Email on the vendor sheet.',
        sheet: sheetName,
        header_row: headerRow,
      });
    }
    if (rows.length > MAX_DATA_ROWS) {
      return res.status(400).json({ error: `At most ${MAX_DATA_ROWS} data rows per file` });
    }

    const prepared = prepareMasterImportRows(rows);
    const importRows = prepared.rows;

    const aggregated = {
      created: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      row_log: [],
    };

    for (let offset = 0; offset < importRows.length; offset += CHUNK_SIZE) {
      const slice = importRows.slice(offset, offset + CHUNK_SIZE);
      const part = await executeVendorMasterImportRows(slice, {
        details,
        pocsByZohoId,
        additionalAddressesByZohoId,
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
      import_stats: prepared.stats,
      summary: {
        vendors_created: aggregated.created,
        vendors_updated: aggregated.updated,
        skipped: aggregated.skipped,
        errors: aggregated.errors,
      },
      ...(details ? { row_log: aggregated.row_log } : {}),
    });
  } catch (err) {
    console.error('[vendor-master-excel] import error', err);
    return res.status(500).json({ error: err.message || 'Vendor master import failed' });
  }
}

const uploadVendorMasterExcelMiddleware = multer({
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

function uploadVendorMasterExcelSafe(req, res, next) {
  uploadVendorMasterExcelMiddleware(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    return next();
  });
}

module.exports = {
  ACTIVE_VENDORS_SHEET,
  ADDITIONAL_POCS_SHEET,
  ADDITIONAL_ADDRESSES_SHEET_NAMES,
  HEADER_ALIASES,
  ADDITIONAL_POCS_HEADER_ALIASES,
  ADDITIONAL_ADDRESSES_HEADER_ALIASES,
  normalizeSheetName,
  findActiveVendorsWorksheet,
  findAdditionalPocsWorksheet,
  findAdditionalAddressesWorksheet,
  detectActiveVendorsColumnMap,
  detectAdditionalPocsColumnMap,
  detectAdditionalAddressesColumnMap,
  vendorPocFieldsToPocObject,
  vendorAdditionalAddressFieldsToObject,
  excelFieldsToVendorMasterPayload,
  parseActiveVendorsWorkbook,
  parseAdditionalPocsWorkbook,
  parseAdditionalAddressesWorkbook,
  extractActiveVendorsFromBuffer,
  executeVendorMasterImportRows,
  uploadVendorMasterExcelSafe,
  postVendorMasterExcelImport,
};

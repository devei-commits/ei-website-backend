/**
 * POST /api/v1/vendor-client/import-excel
 * Client master workbook: sheet "Active Clients" + optional "Additional POCs".
 * Ignores "Summary" and any other tabs.
 */
const ExcelJS = require('exceljs');
const multer = require('multer');
const { Op } = require('sequelize');
const db = require('../../db');
const VendorClient = require('./models');
const { cellToText } = require('../masterBulk/masterExcelFlexibleParse');
const { allocateNextEntityCode, linkOrCreateUserForClientVendorRow } = require('./userLink');
const { syncClientAddressesFromVendorData } = require('../addresses/clientAddressHelpers');
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

const CLIENT_IDENTITY_KEYS = [
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

const ACTIVE_CLIENTS_SHEET = 'active clients';
const ADDITIONAL_POCS_SHEET = 'additional pocs';
const ADDITIONAL_ADDRESSES_SHEET = 'additional addresses';
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_DATA_ROWS = 10000;
const CHUNK_SIZE = 100;
const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

/** Columns we read from "Active Clients". Entity Type, Setup Category, Brand Name, Lead Source, Price List are ignored. */
const HEADER_ALIASES = {
  zohoContactId: ['zoho contact id', 'zoho id', 'contact id'],
  legalName: ['legal name', 'company name'],
  tradeName: ['trade name', 'display name', 'client name', 'contact name'],
  primaryEmail: ['primary email', 'email', 'emailid'],
  primaryPhone: ['primary phone', 'phone', 'mobilephone'],
  status: ['status'],
  customerSubType: ['customer sub type', 'customer subtype', 'customer sub-type'],
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
  industry: ['industry'],
  businessType: ['business type', 'business type '],
  notes: ['notes'],
  gstin: ['gstin', 'gst identification number (gstin)'],
  pan: ['pan', 'pan no', 'pan number'],
  gstTreatment: ['gst treatment'],
  placeOfSupply: ['place of supply'],
  paymentTerms: ['payment terms'],
  paymentTermsDays: ['payment terms days', 'payment term days'],
  creditLimit: ['credit limit'],
  currencyCode: ['currency code', 'currency'],
  salesOwner: ['sales owner', 'cf.sales person name'],
  accountManager: ['account manager', 'cf.sales manager'],
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
function findActiveClientsWorksheet(workbook) {
  for (const ws of workbook.worksheets || []) {
    if (normalizeSheetName(ws.name) === ACTIVE_CLIENTS_SHEET) return ws;
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
    if (normalizeSheetName(ws.name) === ADDITIONAL_ADDRESSES_SHEET) return ws;
  }
  return null;
}

/**
 * @param {import('exceljs').Worksheet} worksheet
 * @param {number} [maxScanRow]
 */
function detectActiveClientsColumnMap(worksheet, maxScanRow = 6) {
  const lastCol = Math.min(worksheet.columnCount || 60, 80);
  for (let r = 1; r <= maxScanRow; r += 1) {
    const row = worksheet.getRow(r);
    const map = {};
    for (let c = 1; c <= lastCol; c += 1) {
      const label = normalizeHeaderLabel(cellToText(row.getCell(c)));
      if (!label) continue;
      for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
        if (map[key]) continue;
        if (aliases.some((a) => label === a)) {
          map[key] = c;
        }
      }
    }
    if (map.legalName || map.tradeName || map.zohoContactId) {
      return { headerRow: r, col: map };
    }
  }
  return null;
}

/** Columns we read from "Additional POCs". */
const ADDITIONAL_POCS_HEADER_ALIASES = {
  clientZohoContactId: ['zoho contact id', 'zoho id', 'contact id'],
  // clientName is provided for reference only
  pocDisplayName: ['poc display name', 'poc name'],
  salutation: ['salutation'],
  pocFirstName: ['poc first name', 'first name'],
  pocLastName: ['poc last name', 'last name'],
  pocEmail: ['poc email', 'email', 'poc emailid', 'emailid'],
  pocPhone: ['poc phone', 'phone'],
  pocMobile: ['poc mobile', 'mobilephone', 'mobile'],
  pocDesignation: ['poc designation', 'designation', 'role'],
  isPrimaryPoc: ['is primary poc', 'is primary point of contact', 'primary poc'],
  lastModifiedTime: ['last modifie time', 'last modified time', 'modified time'],
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
        if (aliases.some((a) => label === a)) {
          map[key] = c;
        }
      }
    }

    const hasClientIdentity = map.clientZohoContactId != null;
    const hasContactBits = map.pocDisplayName != null || map.pocEmail != null || map.pocPhone != null || map.pocMobile != null;
    if (hasClientIdentity && hasContactBits) {
      return { headerRow: r, col: map };
    }
  }

  return null;
}

/** Columns we read from "Additional Addresses". */
const ADDITIONAL_ADDRESSES_HEADER_ALIASES = {
  clientZohoContactId: ['zoho contact id', 'zoho id', 'contact id'],
  zohoAddressId: ['zoho address id', 'address id', 'zoho_address_id'],
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
  legalNameAtAddress: ['legal name at this address', 'legal name'],
  tradeNameAtAddress: ['trade name at this address', 'trade name'],
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

    const hasClient = map.clientZohoContactId != null;
    const hasAddressBits = map.attention != null && map.addressLine1 != null;
    if (hasClient && hasAddressBits) return { headerRow: r, col: map };
  }

  return null;
}

function additionalAddressFieldsToObject(fields) {
  const zohoAddressId = String(fields.zohoAddressId || '').trim() || null;
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
  const legalNameAtAddress =
    String(fields.legalNameAtAddress || '').trim() || undefined;
  const tradeNameAtAddress =
    String(fields.tradeNameAtAddress || '').trim() || undefined;

  const hasAny =
    zohoAddressId ||
    attention ||
    address1 ||
    address2 ||
    city ||
    state ||
    country ||
    pincode ||
    phone ||
    gstin ||
    placeOfSupply ||
    legalNameAtAddress ||
    tradeNameAtAddress;
  if (!hasAny) return null;

  return {
    zohoAddressId,
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
    legalNameAtAddress,
    tradeNameAtAddress,
  };
}

function mergeAdditionalAddresses(existingArr, incomingArr) {
  const existing = Array.isArray(existingArr) ? existingArr : [];
  const incoming = Array.isArray(incomingArr) ? incomingArr : [];

  const incomingById = new Map();
  const incomingNoId = [];
  for (const a of incoming) {
    if (!a) continue;
    const id = a.zohoAddressId != null ? String(a.zohoAddressId) : '';
    if (id) incomingById.set(id, a);
    else incomingNoId.push(a);
  }

  const out = [];
  const usedIds = new Set();
  for (const a of incomingNoId) out.push(a);
  for (const a of incoming) {
    if (!a) continue;
    const id = a.zohoAddressId != null ? String(a.zohoAddressId) : '';
    if (!id) continue;
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    out.push(a);
  }

  for (const a of existing) {
    if (!a) continue;
    const id = a.zohoAddressId != null ? String(a.zohoAddressId) : '';
    if (id) {
      if (!incomingById.has(id)) out.push(a);
    } else {
      if (!out.includes(a)) out.push(a);
    }
  }

  return out;
}

function readCell(row, colKey, colMap, zohoOverlay, excelRow) {
  const idx = colMap[colKey];
  if (!idx) return '';
  const cell = row.getCell(idx);
  if (colKey === 'clientZohoContactId' || colKey === 'vendorZohoContactId') {
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

function normalizeCustomerSubType(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'individual' || s === 'business') return s;
  return s ? s : 'business';
}

function normalizePrimaryFlag(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return false;
  if (s === 'yes' || s === 'y' || s === 'true' || s === '1' || s === 'primary') return true;
  if (s === 'no' || s === 'n' || s === 'false' || s === '0') return false;
  return false;
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

/**
 * @param {Record<string, string>} fields — normalized excel row fields
 */
function rowHasClientIdentityFields(fields) {
  return rowHasMasterIdentity(fields, CLIENT_IDENTITY_KEYS);
}

function excelFieldsToVendorClientPayload(fields) {
  const names = resolveLegalTradeNames({
    legalName: fields.legalName,
    tradeName: fields.tradeName,
    email: fields.primaryEmail,
    zohoId: fields.zohoContactId,
    fallbackPrefix: 'Client',
  });
  if (!names.displayName) return null;

  const { legalName, tradeName, displayName, email } = names;
  const zohoResolved = resolveZohoFromExcelFields(fields);
  const zohoId = zohoResolved.displayId;
  const phone = String(fields.primaryPhone || '').trim();
  const clientState = String(fields.state || fields.billingState || '').trim();
  const clientCountry = String(fields.country || fields.billingCountry || 'India').trim() || 'India';
  const clientCity = String(fields.billingCity || fields.shippingCity || '').trim();

  const billingObj = buildAddressObject(
    fields.billingAttention,
    fields.billingAddress,
    fields.billingCity,
    fields.billingState,
    fields.billingCountry,
    fields.billingPincode,
    fields.billingPhone
  );
  const shippingObj = buildAddressObject(
    fields.shippingAttention,
    fields.shippingAddress,
    fields.shippingCity,
    fields.shippingState,
    fields.shippingCountry,
    fields.shippingPincode,
    fields.shippingPhone
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

  const data = {
    setupType: 'CLIENT',
    setupPrefix: 'CLI',
    setupCategory: 'Customer',
    zohoId: zohoId || undefined,
    zohoIdUnreliable: zohoResolved.unreliable ? true : undefined,
    legalName: legalName || displayName,
    tradeName: tradeName || legalName || displayName,
    primaryEmail: email,
    primaryPhone: phone,
    customerSubType: normalizeCustomerSubType(fields.customerSubType),
    billingAddress: billingLines.slice(0, 500),
    shippingAddress: (shippingLines || billingLines).slice(0, 500),
    billingAddressObject: billingObj || undefined,
    shippingAddressObject: shippingObj || undefined,
    state: clientState,
    country: clientCountry,
    website: String(fields.website || '').trim(),
    segment: String(fields.segment || '').trim(),
    industry: String(fields.industry || '').trim(),
    businessType: String(fields.businessType || '').trim(),
    notes: String(fields.notes || '').trim(),
    gstin: String(fields.gstin || '').trim(),
    pan: String(fields.pan || '').trim().toUpperCase(),
    gstTreatment: String(fields.gstTreatment || '').trim(),
    placeOfSupply: String(fields.placeOfSupply || '').trim(),
    paymentTerms: paymentTerms || '',
    paymentTermsDays: String(fields.paymentTermsDays || '').trim(),
    creditLimit: String(fields.creditLimit || '').trim(),
    currencyCode: String(fields.currencyCode || '').trim(),
    salesOwner: String(fields.salesOwner || '').trim(),
    accountManager: String(fields.accountManager || '').trim(),
    excelCreatedTime: String(fields.createdTime || '').trim() || undefined,
    excelLastModifiedTime: String(fields.lastModifiedTime || '').trim() || undefined,
  };

  const payload = {
    type: 'client',
    zoho_id: zohoResolved.upsertId,
    name: displayName,
    email: email || null,
    phone: phone || null,
    location: clientState || null,
    country: clientCountry,
    city: clientCity || null,
    category: 'Customer',
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

function pocFieldsToPocObject(fields) {
  const displayName = String(fields.pocDisplayName || '').trim();
  const first = String(fields.pocFirstName || '').trim();
  const last = String(fields.pocLastName || '').trim();
  const name = displayName || [first, last].filter(Boolean).join(' ').trim();

  const email = String(fields.pocEmail || '').trim().toLowerCase();
  const phone = String(fields.pocPhone || '').trim() || String(fields.pocMobile || '').trim();
  const role = String(fields.pocDesignation || '').trim();
  const salutation = String(fields.salutation || '').trim();

  const primary = normalizePrimaryFlag(fields.isPrimaryPoc);
  return {
    name: name || 'POC',
    role: role || '',
    email: email || '',
    phone: phone || '',
    level: primary ? 'L1 (Primary)' : 'L2 (Escalation)',
    preferred: primary ? 'Yes' : 'No',
    notes: salutation || '',
  };
}

/**
 * @param {import('exceljs').Workbook} workbook
 */
function parseActiveClientsWorkbook(workbook, opts = {}) {
  const zohoOverlay = opts.zohoOverlay || { byRow: {} };
  const worksheet = findActiveClientsWorksheet(workbook);
  if (!worksheet) {
    throw new Error('Worksheet "Active Clients" not found. Summary and other tabs are ignored.');
  }

  const header = detectActiveClientsColumnMap(worksheet);
  if (!header) {
    throw new Error(
      'Could not find header row on "Active Clients". Expected columns such as Legal Name, Trade Name, or Zoho Contact ID.'
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
    return rowHasClientIdentityFields(fields);
  });

  for (let r = headerRow + 1; r <= lastRow; r += 1) {
    const row = worksheet.getRow(r);
    let fields = readRowFields(row, col, headerKeys);
    fields = applyZohoOverlayToFields(fields, zohoOverlay, r);
    if (fields.zohoContactId && fields.zohoContactIdReliable !== true) {
      zohoUnreliableRows += 1;
    }
    if (!rowHasClientIdentityFields(fields)) {
      skippedNoIdentity += 1;
      continue;
    }

    const payload = excelFieldsToVendorClientPayload(fields);
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

    const clientZohoId = String(fields.clientZohoContactId || '').trim();
    if (!clientZohoId) continue;

    const hasAnyPocValue =
      String(fields.pocDisplayName || '').trim() ||
      String(fields.pocFirstName || '').trim() ||
      String(fields.pocLastName || '').trim() ||
      String(fields.pocEmail || '').trim() ||
      String(fields.pocPhone || '').trim() ||
      String(fields.pocMobile || '').trim() ||
      String(fields.pocDesignation || '').trim();
    if (!hasAnyPocValue) continue;

    const pocObj = pocFieldsToPocObject(fields);
    if (!pocsByZohoId[clientZohoId]) pocsByZohoId[clientZohoId] = [];
    pocsByZohoId[clientZohoId].push(pocObj);
  }

  return { pocsByZohoId, sheetName: worksheet.name, headerRow };
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

    const clientZohoId = String(fields.clientZohoContactId || '').trim();
    if (!clientZohoId) continue;

    const addrObj = additionalAddressFieldsToObject(fields);
    if (!addrObj) continue;

    if (!additionalAddressesByZohoId[clientZohoId]) additionalAddressesByZohoId[clientZohoId] = [];
    additionalAddressesByZohoId[clientZohoId].push(addrObj);
  }

  return { additionalAddressesByZohoId, sheetName: worksheet.name, headerRow };
}

async function extractActiveClientsFromBuffer(buffer) {
  const clientZohoOverlay = buildZohoColumnOverlayFromXlsx(
    buffer,
    ACTIVE_CLIENTS_SHEET,
    HEADER_ALIASES.zohoContactId,
  );
  const pocsZohoOverlay = buildZohoColumnOverlayFromXlsx(
    buffer,
    ADDITIONAL_POCS_SHEET,
    ADDITIONAL_POCS_HEADER_ALIASES.clientZohoContactId,
  );
  const addressesZohoOverlay = buildZohoColumnOverlayFromXlsx(
    buffer,
    ADDITIONAL_ADDRESSES_SHEET,
    ADDITIONAL_ADDRESSES_HEADER_ALIASES.clientZohoContactId,
  );

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  if (!workbook.worksheets?.length) {
    throw new Error('Workbook has no worksheets');
  }

  const active = parseActiveClientsWorkbook(workbook, { zohoOverlay: clientZohoOverlay });
  const pocs = parseAdditionalPocsWorkbook(workbook, { pocsZohoOverlay });
  const additionalAddresses = parseAdditionalAddressesWorkbook(workbook, {
    addressesZohoOverlay,
  });
  return {
    ...active,
    pocsByZohoId: pocs.pocsByZohoId,
    pocsSheetName: pocs.sheetName,
    additionalAddressesByZohoId: additionalAddresses.additionalAddressesByZohoId,
    additionalAddressesSheetName: additionalAddresses.sheetName,
  };
}

function mergeClientData(existingData, incomingData) {
  const base =
    existingData && typeof existingData === 'object' && !Array.isArray(existingData)
      ? { ...existingData }
      : {};
  const merged = { ...base, ...incomingData };
  for (const key of ['documents', 'pocs', 'banks', 'productInterests', 'vendorItems']) {
    if (Array.isArray(base[key]) && base[key].length > 0) {
      merged[key] = base[key];
    }
  }
  return merged;
}

/**
 * @param {Array<{ excel_row: number, sheet_name: string, payload: object }>} rows
 * @param {{ details?: boolean }} opts
 */
async function executeClientMasterImportRows(rows, opts = {}) {
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
      const existing = await findExistingMasterImportRow('client', incoming, VendorClient);

      if (existing) {
        const prevData =
          existing.data && typeof existing.data === 'object' ? existing.data : {};

        const lookupZohoId = resolveZohoLookupKey(incoming) || existing.zoho_id;
        const incomingPocs = lookupZohoId ? pocsByZohoId[lookupZohoId] || [] : [];
        const mergedData = mergeClientData(prevData, incoming.data);
        if (incomingPocs.length > 0) mergedData.pocs = incomingPocs;

        const incomingAddresses = lookupZohoId
          ? additionalAddressesByZohoId[lookupZohoId] || []
          : [];
        if (incomingAddresses.length > 0) {
          mergedData.additionalAddresses = mergeAdditionalAddresses(
            mergedData.additionalAddresses,
            incomingAddresses,
          );
        }

        await existing.update({
          zoho_id: incoming.zoho_id || existing.zoho_id,
          name: incoming.name || existing.name,
          email: incoming.email ?? existing.email,
          phone: incoming.phone ?? existing.phone,
          location: incoming.location ?? existing.location,
          country: incoming.country ?? existing.country,
          city: incoming.city ?? existing.city,
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
        if (existing.user_id) {
          const d = mergedData;
          await syncClientAddressesFromVendorData(existing.user_id, d).catch(() => {});
        }
        continue;
      }

      const entityCode = await allocateNextEntityCode('client');
      const lookupZohoId = resolveZohoLookupKey(incoming);
      const incomingPocs = lookupZohoId ? pocsByZohoId[lookupZohoId] || [] : [];
      const incomingAddresses =
        lookupZohoId && additionalAddressesByZohoId[lookupZohoId]
          ? additionalAddressesByZohoId[lookupZohoId]
          : [];
      const created = await VendorClient.create({
        entity_code: entityCode,
        type: 'client',
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
        data:
          incomingPocs.length > 0 || incomingAddresses.length > 0
            ? {
                ...incoming.data,
                entityCode,
                ...(incomingPocs.length > 0 ? { pocs: incomingPocs } : {}),
                ...(incomingAddresses.length > 0 ? { additionalAddresses: incomingAddresses } : {}),
              }
            : { ...incoming.data, entityCode },
      });

      await linkOrCreateUserForClientVendorRow(created).catch(() => {});
      await created.reload();
      if (created.user_id) {
        await syncClientAddressesFromVendorData(created.user_id, created.data).catch(() => {});
      }

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

async function postClientMasterExcelImport(req, res) {
  try {
    if (!req.user) return res.sendStatus(401);
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Expected multipart file field "file" (.xlsx or .xlsm)' });
    }

    const details =
      req.query.details === '1' || req.query.details === 'true' || req.body?.details === true;

    let parsed;
    try {
      parsed = await extractActiveClientsFromBuffer(req.file.buffer);
    } catch (loadErr) {
      console.error('[client-master-excel] parse error', loadErr);
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
        error: 'No client rows found on "Active Clients". Need Legal Name, Trade Name, Zoho Contact ID, or Primary Email.',
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
      const part = await executeClientMasterImportRows(slice, {
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
        clients_created: aggregated.created,
        clients_updated: aggregated.updated,
        skipped: aggregated.skipped,
        errors: aggregated.errors,
      },
      ...(details ? { row_log: aggregated.row_log } : {}),
    });
  } catch (err) {
    console.error('[client-master-excel] import error', err);
    return res.status(500).json({ error: err.message || 'Client master import failed' });
  }
}

const uploadClientMasterExcelMiddleware = multer({
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

function uploadClientMasterExcelSafe(req, res, next) {
  uploadClientMasterExcelMiddleware(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    return next();
  });
}

module.exports = {
  ACTIVE_CLIENTS_SHEET,
  ADDITIONAL_POCS_SHEET,
  ADDITIONAL_ADDRESSES_SHEET,
  HEADER_ALIASES,
  normalizeSheetName,
  findActiveClientsWorksheet,
  findAdditionalPocsWorksheet,
  findAdditionalAddressesWorksheet,
  detectActiveClientsColumnMap,
  detectAdditionalPocsColumnMap,
  detectAdditionalAddressesColumnMap,
  excelFieldsToVendorClientPayload,
  parseActiveClientsWorkbook,
  parseAdditionalPocsWorkbook,
  parseAdditionalAddressesWorkbook,
  extractActiveClientsFromBuffer,
  executeClientMasterImportRows,
  uploadClientMasterExcelSafe,
  postClientMasterExcelImport,
};

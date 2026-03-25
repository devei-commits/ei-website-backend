/**
 * Zoho Books API (India DC: zohoapis.in).
 * Access tokens are short-lived; we refresh using ZOHO_REFRESH_TOKEN from .env (unchanged between refreshes).
 * Each POST to /oauth/v2/token returns access_token + expires_in (seconds); we cache until then minus a buffer.
 */

let cachedAccessToken = null;
/** Unix ms when cachedAccessToken should be considered expired (refresh before this). */
let cachedAccessTokenExpiresAt = 0;

/** Set ZOHO_DEBUG=true in .env to log every Zoho Books request URL, JSON body, and response (for debugging). */
function zohoDebugEnabled() {
  return process.env.ZOHO_DEBUG === 'true' || process.env.ZOHO_LOG_API === 'true';
}

function stringifyForLog(obj, maxLen = 14000) {
  try {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    return s.length > maxLen ? `${s.slice(0, maxLen)}…(truncated)` : s;
  } catch (_e) {
    return String(obj);
  }
}

function logZohoRequest(operation, method, url, jsonBody) {
  if (!zohoDebugEnabled()) return;
  console.log(`[Zoho API] ${operation} → ${method} ${url}`);
  if (jsonBody !== undefined && jsonBody !== null) {
    console.log('[Zoho API] request body:\n', stringifyForLog(jsonBody));
  }
}

function logZohoResponse(operation, httpStatus, raw) {
  if (!zohoDebugEnabled()) return;
  console.log(`[Zoho API] ${operation} ← HTTP ${httpStatus}`);
  console.log('[Zoho API] response body:\n', stringifyForLog(raw));
}

function logZohoError(operation, method, url, httpStatus, raw) {
  console.error(`[Zoho API] ${operation} FAILED`, { method, url, httpStatus });
  console.error('[Zoho API] response:', stringifyForLog(raw));
}

/**
 * JSON.parse rounds integers beyond Number.MAX_SAFE_INTEGER. Zoho Books often returns large ids as bare JSON numbers.
 * Quote 16+ digit integers before parse so ids (contact_id, currency_id, etc.) stay exact.
 * @param {string} text
 */
function quoteLongIntegerValuesInJson(text) {
  let s = text;
  s = s.replace(/:\s*(-?\d{16,})(\s*[,}\]])/g, ': "$1"$2');
  s = s.replace(/,\s*(-?\d{16,})(\s*[,}\]])/g, ', "$1"$2');
  s = s.replace(/\[\s*(-?\d{16,})(\s*[\],])/g, '["$1"$2');
  return s;
}

/**
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
function parseBooksApiJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return {};
  try {
    return JSON.parse(quoteLongIntegerValuesInJson(text));
  } catch (_e) {
    try {
      return JSON.parse(text);
    } catch (_e2) {
      return {};
    }
  }
}

/** @param {Response} res */
async function readBooksJsonResponse(res) {
  const text = await res.text();
  return parseBooksApiJson(text);
}

/**
 * Zoho returns expires_in in seconds (e.g. 3600). Use that value; fallback only if missing/invalid.
 * @param {Record<string, unknown>} data
 * @returns {number} seconds
 */
function parseExpiresInSeconds(data) {
  const v = data && data.expires_in;
  if (v === undefined || v === null) return 3600;
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
  if (!Number.isFinite(n) || n <= 0) return 3600;
  return n;
}

function getBooksBaseUrl() {
  return (process.env.ZOHO_BOOKS_API_BASE || 'https://www.zohoapis.in/books/v3').replace(/\/$/, '');
}

function getTokenUrl() {
  return process.env.ZOHO_ACCOUNTS_TOKEN_URL || 'https://accounts.zoho.in/oauth/v2/token';
}

function getOrgId() {
  const id = process.env.ZOHO_BOOKS_ORGANIZATION_ID;
  if (!id) throw new Error('ZOHO_BOOKS_ORGANIZATION_ID is not set');
  return String(id).trim();
}

/**
 * @returns {Promise<string>}
 */
async function getAccessToken() {
  const now = Date.now();
  // Refresh this many seconds before expiry (from Zoho expires_in). Env: ZOHO_TOKEN_EXPIRY_BUFFER_SEC, default 120.
  const bufferMs =
    Math.max(0, Number(process.env.ZOHO_TOKEN_EXPIRY_BUFFER_SEC) || 120) * 1000;
  if (cachedAccessToken && now < cachedAccessTokenExpiresAt - bufferMs) {
    return cachedAccessToken;
  }

  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const redirectUri = process.env.ZOHO_REDIRECT_URI || 'http://localhost';

  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error('Zoho OAuth env missing: ZOHO_REFRESH_TOKEN, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET');
  }

  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'refresh_token',
  });

  const tokenUrl = getTokenUrl();
  if (zohoDebugEnabled()) {
    console.log('[Zoho API] oauth/token → POST', tokenUrl, '(body: grant_type=refresh_token, client_id=***, …)');
  }

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await res.json().catch(() => ({}));
  if (zohoDebugEnabled()) {
    const safe = { ...data };
    if (safe.access_token) safe.access_token = `***(${String(safe.access_token).length} chars)`;
    if (safe.refresh_token) safe.refresh_token = '***(redacted)';
    console.log('[Zoho API] oauth/token ← HTTP', res.status, stringifyForLog(safe));
  }

  if (!res.ok) {
    logZohoError('oauth/token', 'POST', tokenUrl, res.status, data);
    const msg = data.error || data.message || res.statusText || 'token_refresh_failed';
    throw new Error(`Zoho token refresh failed: ${msg}`);
  }

  if (!data.access_token) {
    logZohoError('oauth/token', 'POST', tokenUrl, res.status, data);
    throw new Error('Zoho token response missing access_token');
  }

  const expiresInSec = parseExpiresInSeconds(data);
  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiresAt = now + expiresInSec * 1000;
  return cachedAccessToken;
}

/**
 * Zoho returns large numeric ids as number or string.
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeZohoId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    const t = value.trim();
    return t.length ? t : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (!Number.isSafeInteger(value) && zohoDebugEnabled()) {
      console.warn('[Zoho API] normalizeZohoId: non-safe integer (precision may already be lost):', value);
    }
    return String(value);
  }
  return String(value);
}

const normalizeZohoContactId = normalizeZohoId;

/**
 * @param {Record<string, unknown>} contactJson
 * @returns {Promise<{ raw: unknown, contactId: string | null }>}
 */
async function createContact(contactJson) {
  const orgId = getOrgId();
  const token = await getAccessToken();
  const url = `${getBooksBaseUrl()}/contacts?organization_id=${encodeURIComponent(orgId)}`;

  logZohoRequest('createContact', 'POST', url, contactJson);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(contactJson),
  });

  const raw = await readBooksJsonResponse(res);
  logZohoResponse('createContact', res.status, raw);

  const code = raw && typeof raw.code === 'number' ? raw.code : undefined;
  const contact = raw && raw.contact;
  const contactId = contact ? normalizeZohoId(contact.contact_id) : null;

  const codeOk = code === undefined || code === 0;
  if (!res.ok || !codeOk || !contactId) {
    logZohoError('createContact', 'POST', url, res.status, raw);
    const msg = raw.message || raw.error || res.statusText || 'create_contact_failed';
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.zohoRaw = raw;
    err.statusCode = res.status;
    throw err;
  }

  return { raw, contactId };
}

/**
 * Create an item in Zoho Books (POST /items).
 * @param {Record<string, unknown>} itemJson
 * @returns {Promise<{ raw: unknown, itemId: string | null }>}
 */
async function createItem(itemJson) {
  const orgId = getOrgId();
  const token = await getAccessToken();
  const url = `${getBooksBaseUrl()}/items?organization_id=${encodeURIComponent(orgId)}`;

  logZohoRequest('createItem', 'POST', url, itemJson);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(itemJson),
  });

  const raw = await readBooksJsonResponse(res);
  logZohoResponse('createItem', res.status, raw);

  const code = raw && typeof raw.code === 'number' ? raw.code : undefined;
  const item = raw && raw.item;
  const itemId = item ? normalizeZohoId(item.item_id) : null;

  const codeOk = code === undefined || code === 0;
  if (!res.ok || !codeOk || !itemId) {
    logZohoError('createItem', 'POST', url, res.status, raw);
    const msg = raw.message || raw.error || res.statusText || 'create_item_failed';
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.zohoRaw = raw;
    err.statusCode = res.status;
    throw err;
  }

  return { raw, itemId };
}

/**
 * Create an invoice in Zoho Books (POST /invoices).
 * @param {Record<string, unknown>} invoiceJson
 * @returns {Promise<{ raw: unknown, invoiceId: string | null }>}
 */
async function createInvoice(invoiceJson) {
  const orgId = getOrgId();
  const token = await getAccessToken();
  const url = `${getBooksBaseUrl()}/invoices?organization_id=${encodeURIComponent(orgId)}`;

  logZohoRequest('createInvoice', 'POST', url, invoiceJson);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(invoiceJson),
  });

  const raw = await readBooksJsonResponse(res);
  logZohoResponse('createInvoice', res.status, raw);

  const code = raw && typeof raw.code === 'number' ? raw.code : undefined;
  const inv = raw && raw.invoice;
  const invoiceId = inv ? normalizeZohoId(inv.invoice_id) : null;

  const codeOk = code === undefined || code === 0;
  if (!res.ok || !codeOk || !invoiceId) {
    logZohoError('createInvoice', 'POST', url, res.status, raw);
    const msg = raw.message || raw.error || res.statusText || 'create_invoice_failed';
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.zohoRaw = raw;
    err.statusCode = res.status;
    throw err;
  }

  return { raw, invoiceId };
}

/**
 * Create a purchase order in Zoho Books (POST /purchaseorders).
 * @param {Record<string, unknown>} purchaseOrderJson
 * @returns {Promise<{ raw: unknown, purchaseorderId: string | null }>}
 */
async function createPurchaseOrderInBooks(purchaseOrderJson) {
  const orgId = getOrgId();
  const token = await getAccessToken();
  const url = `${getBooksBaseUrl()}/purchaseorders?organization_id=${encodeURIComponent(orgId)}`;

  logZohoRequest('createPurchaseOrderInBooks', 'POST', url, purchaseOrderJson);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(purchaseOrderJson),
  });

  const raw = await readBooksJsonResponse(res);
  logZohoResponse('createPurchaseOrderInBooks', res.status, raw);

  const code = raw && typeof raw.code === 'number' ? raw.code : undefined;
  const po = raw && raw.purchaseorder;
  const purchaseorderId = po ? normalizeZohoId(po.purchaseorder_id) : null;

  const codeOk = code === undefined || code === 0;
  if (!res.ok || !codeOk || !purchaseorderId) {
    logZohoError('createPurchaseOrderInBooks', 'POST', url, res.status, raw);
    const msg = raw.message || raw.error || res.statusText || 'create_purchase_order_failed';
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.zohoRaw = raw;
    err.statusCode = res.status;
    throw err;
  }

  return { raw, purchaseorderId };
}

/**
 * Create a vendor bill in Zoho Books (POST /bills) — vendor purchase invoice (AP).
 * @param {Record<string, unknown>} billJson
 * @returns {Promise<{ raw: unknown, billId: string | null }>}
 */
async function createBillInBooks(billJson) {
  const orgId = getOrgId();
  const token = await getAccessToken();
  const url = `${getBooksBaseUrl()}/bills?organization_id=${encodeURIComponent(orgId)}`;

  logZohoRequest('createBillInBooks', 'POST', url, billJson);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(billJson),
  });

  const raw = await readBooksJsonResponse(res);
  logZohoResponse('createBillInBooks', res.status, raw);

  const code = raw && typeof raw.code === 'number' ? raw.code : undefined;
  const bill = raw && raw.bill;
  const billId = bill ? normalizeZohoId(bill.bill_id) : null;

  const codeOk = code === undefined || code === 0;
  if (!res.ok || !codeOk || !billId) {
    logZohoError('createBillInBooks', 'POST', url, res.status, raw);
    const msg = raw.message || raw.error || res.statusText || 'create_bill_failed';
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.zohoRaw = raw;
    err.statusCode = res.status;
    throw err;
  }

  return { raw, billId };
}

/**
 * List enabled currencies for the org (GET /settings/currencies).
 * Use returned currency_id for ZOHO_DEFAULT_CURRENCY_ID in .env.
 * @returns {Promise<{ raw: unknown, currencies: unknown[] }>}
 */
async function listCurrencies() {
  const orgId = getOrgId();
  const token = await getAccessToken();
  const url = `${getBooksBaseUrl()}/settings/currencies?organization_id=${encodeURIComponent(orgId)}`;

  logZohoRequest('listCurrencies', 'GET', url, null);

  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });

  const raw = await readBooksJsonResponse(res);
  logZohoResponse('listCurrencies', res.status, raw);

  if (!res.ok) {
    logZohoError('listCurrencies', 'GET', url, res.status, raw);
    const msg = raw.message || raw.error || res.statusText || 'list_currencies_failed';
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.zohoRaw = raw;
    err.statusCode = res.status;
    throw err;
  }

  const currencies = Array.isArray(raw.currencies) ? raw.currencies : [];
  return { raw, currencies };
}

/** For tests / debugging: seconds remaining until we trigger refresh (after buffer). */
function getAccessTokenCacheMeta() {
  if (!cachedAccessToken) return { cached: false };
  const bufferSec = Number(process.env.ZOHO_TOKEN_EXPIRY_BUFFER_SEC) || 120;
  const refreshAt = cachedAccessTokenExpiresAt - bufferSec * 1000;
  return {
    cached: true,
    expiresAtMs: cachedAccessTokenExpiresAt,
    refreshAfterMs: refreshAt,
    secondsUntilRefresh: Math.max(0, (refreshAt - Date.now()) / 1000),
  };
}

module.exports = {
  getAccessToken,
  createContact,
  createItem,
  createInvoice,
  createPurchaseOrderInBooks,
  createBillInBooks,
  listCurrencies,
  normalizeZohoId,
  normalizeZohoContactId,
  getBooksBaseUrl,
  getOrgId,
  getAccessTokenCacheMeta,
  zohoDebugEnabled,
  stringifyForLog,
  parseBooksApiJson,
  readBooksJsonResponse,
};

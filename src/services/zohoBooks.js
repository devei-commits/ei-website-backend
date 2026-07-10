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

/** Zoho Inventory API base (India default). Same OAuth token works if scopes include Inventory. */
function getInventoryBaseUrl() {
  return (process.env.ZOHO_INVENTORY_API_BASE || 'https://www.zohoapis.in/inventory/v1').replace(/\/$/, '');
}

/** Inventory org id when it differs from Books; otherwise Books org id. */
function getInventoryOrgId() {
  const inv = process.env.ZOHO_INVENTORY_ORGANIZATION_ID;
  if (inv != null && String(inv).trim() !== '') return String(inv).trim();
  return getOrgId();
}

/**
 * Composite item (bundle) from Zoho Inventory or Zoho Books — `mapped_items` are constituents per 1 composite unit.
 * Tries Inventory GET /compositeitems/{id} first, then Books /compositeitems/{id}.
 * @param {string} compositeItemId
 * @returns {Promise<Record<string, unknown>>}
 */
async function fetchCompositeItem(compositeItemId) {
  const id = normalizeZohoId(compositeItemId);
  if (!id) {
    const err = new Error('missing_composite_item_id');
    err.code = 'MISSING_ID';
    throw err;
  }
  const token = await getAccessToken();

  const tryInventory = async () => {
    const invBase = getInventoryBaseUrl();
    const invOrg = getInventoryOrgId();
    const url = `${invBase}/compositeitems/${encodeURIComponent(id)}?organization_id=${encodeURIComponent(invOrg)}`;
    logZohoRequest('fetchCompositeItem.inventory', 'GET', url, null);
    const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    const raw = await readBooksJsonResponse(res);
    logZohoResponse('fetchCompositeItem.inventory', res.status, raw);
    const code = raw && typeof raw.code === 'number' ? raw.code : undefined;
    const codeOk = code === undefined || code === 0;
    if (!res.ok || !codeOk) return null;
    const composite = raw && raw.composite_item;
    if (composite && typeof composite === 'object' && Array.isArray(composite.mapped_items)) {
      return composite;
    }
    return null;
  };

  const tryBooks = async () => {
    const orgId = getOrgId();
    const url = `${getBooksBaseUrl()}/compositeitems/${encodeURIComponent(id)}?organization_id=${encodeURIComponent(orgId)}`;
    logZohoRequest('fetchCompositeItem.books', 'GET', url, null);
    const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    const raw = await readBooksJsonResponse(res);
    logZohoResponse('fetchCompositeItem.books', res.status, raw);
    const code = raw && typeof raw.code === 'number' ? raw.code : undefined;
    if (!res.ok || (code !== undefined && code !== 0)) {
      const msg = raw?.message || raw?.error || res.statusText || 'zoho_composite_fetch_failed';
      const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      err.zohoRaw = raw;
      err.statusCode = res.status;
      throw err;
    }
    const composite = raw?.composite_item;
    if (composite && typeof composite === 'object') return composite;
    return null;
  };

  const fromInv = await tryInventory();
  if (fromInv) return fromInv;
  const fromBooks = await tryBooks();
  if (fromBooks) return fromBooks;

  const err = new Error(
    'Could not load composite item from Zoho Inventory or Books (check id, org id, and OAuth scopes: ZohoInventory.compositeitems.READ / ZohoBooks.bundles.READ).'
  );
  err.code = 'ZOHO_COMPOSITE_NOT_FOUND';
  throw err;
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
 * Delete an item in Zoho Books (DELETE /items/{item_id}). Used to compensate after DB failure.
 * @param {string} itemId
 * @returns {Promise<{ raw: unknown }>}
 */
async function deleteItem(itemId) {
  return deleteBooksResource('items', itemId, 'deleteItem');
}

/**
 * Shared DELETE helper for Zoho Books v3 collection resources.
 * @param {string} resource - URL segment, e.g. `contacts`, `invoices`, `bills`
 * @param {string} resourceId
 * @param {string} opName - log label
 * @returns {Promise<{ raw: unknown }>}
 */
async function deleteBooksResource(resource, resourceId, opName) {
  const seg = String(resource || '').replace(/^\/+|\/+$/g, '');
  if (!seg) throw new Error('deleteBooksResource: resource is required');
  const id = normalizeZohoId(resourceId);
  if (!id) {
    const err = new Error(`${opName || 'delete'}_missing_id`);
    err.code = 'MISSING_ID';
    throw err;
  }
  const orgId = getOrgId();
  const token = await getAccessToken();
  const url = `${getBooksBaseUrl()}/${seg}/${encodeURIComponent(id)}?organization_id=${encodeURIComponent(orgId)}`;
  const op = opName || `delete_${seg}`;

  logZohoRequest(op, 'DELETE', url, null);

  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });

  const raw = await readBooksJsonResponse(res);
  logZohoResponse(op, res.status, raw);

  const code = raw && typeof raw.code === 'number' ? raw.code : undefined;
  const codeOk = code === undefined || code === 0;
  if (!res.ok || !codeOk) {
    logZohoError(op, 'DELETE', url, res.status, raw);
    const msg = raw.message || raw.error || res.statusText || `${op}_failed`;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.zohoRaw = raw;
    err.statusCode = res.status;
    err.zohoCode = code;
    throw err;
  }

  return { raw };
}

/** @param {string} contactId */
async function deleteContact(contactId) {
  return deleteBooksResource('contacts', contactId, 'deleteContact');
}

/** @param {string} invoiceId */
async function deleteInvoice(invoiceId) {
  return deleteBooksResource('invoices', invoiceId, 'deleteInvoice');
}

/** @param {string} estimateId */
async function deleteEstimate(estimateId) {
  return deleteBooksResource('estimates', estimateId, 'deleteEstimate');
}

/** @param {string} salesorderId */
async function deleteSalesorder(salesorderId) {
  return deleteBooksResource('salesorders', salesorderId, 'deleteSalesorder');
}

/** @param {string} billId */
async function deleteBill(billId) {
  return deleteBooksResource('bills', billId, 'deleteBill');
}

/** @param {string} purchaseorderId */
async function deletePurchaseOrder(purchaseorderId) {
  return deleteBooksResource('purchaseorders', purchaseorderId, 'deletePurchaseOrder');
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
/**
 * List inventory items (GET /items) — single page.
 * @param {{ page?: number, perPage?: number, filterBy?: string, sortColumn?: string }} options
 * @returns {Promise<{ raw: unknown, items: Record<string, unknown>[], pageContext: Record<string, unknown> | null }>}
 */
async function listItemsPage(options = {}) {
  const orgId = getOrgId();
  const token = await getAccessToken();
  const page = options.page != null ? Math.max(1, Number(options.page)) : 1;
  const perPage = Math.min(200, options.perPage != null ? Number(options.perPage) : 200);
  const qs = new URLSearchParams({
    organization_id: orgId,
    page: String(page),
    per_page: String(perPage),
  });
  if (options.filterBy) qs.set('filter_by', String(options.filterBy));
  if (options.sortColumn) qs.set('sort_column', String(options.sortColumn));
  if (options.searchText) qs.set('search_text', String(options.searchText));

  const url = `${getBooksBaseUrl()}/items?${qs.toString()}`;

  logZohoRequest('listItemsPage', 'GET', url, null);

  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });

  const raw = await readBooksJsonResponse(res);
  logZohoResponse('listItemsPage', res.status, raw);

  if (!res.ok) {
    logZohoError('listItemsPage', 'GET', url, res.status, raw);
    const msg = raw.message || raw.error || res.statusText || 'list_items_failed';
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.zohoRaw = raw;
    err.statusCode = res.status;
    throw err;
  }

  const items = Array.isArray(raw.items) ? raw.items : [];
  const pageContext =
    raw.page_context && typeof raw.page_context === 'object' ? raw.page_context : null;
  return { raw, items, pageContext };
}

/**
 * All items across pages (stops when page_context.has_more_page is not true).
 * @param {{ filterBy?: string, sortColumn?: string, perPage?: number, maxPages?: number, limit?: number }} options
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function listAllItems(options = {}) {
  const perPage = options.perPage != null ? Math.min(200, Number(options.perPage)) : 200;
  const maxPages = options.maxPages != null ? Math.max(1, Number(options.maxPages)) : 10000;
  const lim =
    options.limit != null && Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : undefined;
  const all = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= maxPages) {
    const { items, pageContext } = await listItemsPage({
      ...options,
      page,
      perPage,
    });
    all.push(...items);
    if (lim != null && all.length >= lim) {
      return all.slice(0, lim);
    }
    hasMore = !!(pageContext && pageContext.has_more_page === true);
    page += 1;
  }

  return all;
}

/**
 * Generic list GET for Zoho Books v3 collections that return `page_context` + a top-level array.
 * @param {string} resource Path segment, e.g. `contacts`, `invoices`, `salesorders`
 * @param {string} arrayKey Response array key, e.g. `contacts`, `invoices`
 * @param {{ page?: number, perPage?: number, filterBy?: string, sortColumn?: string }} options
 * @returns {Promise<{ raw: unknown, rows: Record<string, unknown>[], pageContext: Record<string, unknown> | null }>}
 */
async function listBooksCollectionPage(resource, arrayKey, options = {}) {
  const seg = String(resource || '').replace(/^\/+|\/+$/g, '');
  if (!seg) throw new Error('listBooksCollectionPage: resource is required');
  const key = String(arrayKey || '').trim() || seg;
  const orgId = getOrgId();
  const token = await getAccessToken();
  const page = options.page != null ? Math.max(1, Number(options.page)) : 1;
  const perPage = Math.min(200, options.perPage != null ? Number(options.perPage) : 200);
  const qs = new URLSearchParams({
    organization_id: orgId,
    page: String(page),
    per_page: String(perPage),
  });
  if (options.filterBy) qs.set('filter_by', String(options.filterBy));
  if (options.sortColumn) qs.set('sort_column', String(options.sortColumn));

  const url = `${getBooksBaseUrl()}/${seg}?${qs.toString()}`;
  const op = `listBooksCollectionPage(${seg})`;

  logZohoRequest(op, 'GET', url, null);

  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });

  const raw = await readBooksJsonResponse(res);
  logZohoResponse(op, res.status, raw);

  if (!res.ok) {
    logZohoError(op, 'GET', url, res.status, raw);
    const msg = raw.message || raw.error || res.statusText || `list_${seg}_failed`;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.zohoRaw = raw;
    err.statusCode = res.status;
    throw err;
  }

  const rows = Array.isArray(raw[key]) ? raw[key] : [];
  const pageContext =
    raw.page_context && typeof raw.page_context === 'object' ? raw.page_context : null;
  return { raw, rows, pageContext };
}

/**
 * All rows across pages for a Books list endpoint.
 * @param {string} resource
 * @param {string} arrayKey
 * @param {{ filterBy?: string, sortColumn?: string, perPage?: number, maxPages?: number, limit?: number }} options
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function listAllBooksCollection(resource, arrayKey, options = {}) {
  const perPage = options.perPage != null ? Math.min(200, Number(options.perPage)) : 200;
  const maxPages = options.maxPages != null ? Math.max(1, Number(options.maxPages)) : 10000;
  const lim =
    options.limit != null && Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : undefined;
  const all = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= maxPages) {
    const { rows, pageContext } = await listBooksCollectionPage(resource, arrayKey, {
      ...options,
      page,
      perPage,
    });
    all.push(...rows);
    if (lim != null && all.length >= lim) {
      return all.slice(0, lim);
    }
    hasMore = !!(pageContext && pageContext.has_more_page === true);
    page += 1;
  }

  return all;
}

/** @param {{ page?: number, perPage?: number, filterBy?: string, sortColumn?: string }} options */
async function listContactsPage(options = {}) {
  return listBooksCollectionPage('contacts', 'contacts', options);
}

/** @param {{ filterBy?: string, sortColumn?: string, perPage?: number, maxPages?: number }} options */
async function listAllContacts(options = {}) {
  return listAllBooksCollection('contacts', 'contacts', options);
}

/**
 * GET /contacts/{id} — includes billing/shipping details missing in list rows.
 * @param {string} contactId
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function getContactById(contactId) {
  const id = normalizeZohoContactId(contactId);
  if (!id) {
    const err = new Error('getContactById: contact id is required');
    err.code = 'MISSING_ID';
    throw err;
  }
  const orgId = getOrgId();
  const token = await getAccessToken();
  const url = `${getBooksBaseUrl()}/contacts/${encodeURIComponent(id)}?organization_id=${encodeURIComponent(orgId)}`;

  logZohoRequest('getContactById', 'GET', url, null);

  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });

  const raw = await readBooksJsonResponse(res);
  logZohoResponse('getContactById', res.status, raw);

  const code = raw && typeof raw.code === 'number' ? raw.code : undefined;
  const codeOk = code === undefined || code === 0;
  if (!res.ok || !codeOk) {
    logZohoError('getContactById', 'GET', url, res.status, raw);
    const msg = raw.message || raw.error || res.statusText || 'get_contact_failed';
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.zohoRaw = raw;
    err.statusCode = res.status;
    throw err;
  }

  const contact = raw.contact && typeof raw.contact === 'object' ? raw.contact : null;
  return contact;
}

/** @param {{ page?: number, perPage?: number, filterBy?: string, sortColumn?: string }} options */
async function listInvoicesPage(options = {}) {
  return listBooksCollectionPage('invoices', 'invoices', options);
}

/** @param {{ filterBy?: string, sortColumn?: string, perPage?: number, maxPages?: number }} options */
async function listAllInvoices(options = {}) {
  return listAllBooksCollection('invoices', 'invoices', options);
}

/** @param {{ page?: number, perPage?: number, filterBy?: string, sortColumn?: string }} options */
async function listEstimatesPage(options = {}) {
  return listBooksCollectionPage('estimates', 'estimates', options);
}

/** @param {{ filterBy?: string, sortColumn?: string, perPage?: number, maxPages?: number }} options */
async function listAllEstimates(options = {}) {
  return listAllBooksCollection('estimates', 'estimates', options);
}

/** @param {{ page?: number, perPage?: number, filterBy?: string, sortColumn?: string }} options */
async function listSalesordersPage(options = {}) {
  return listBooksCollectionPage('salesorders', 'salesorders', options);
}

/** @param {{ filterBy?: string, sortColumn?: string, perPage?: number, maxPages?: number }} options */
async function listAllSalesorders(options = {}) {
  return listAllBooksCollection('salesorders', 'salesorders', options);
}

/**
 * GET /salesorders/{id} — includes `line_items` when the list endpoint does not.
 * @param {string} salesorderId
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function getSalesorderById(salesorderId) {
  const id = normalizeZohoId(salesorderId);
  if (!id) {
    const err = new Error('getSalesorderById: salesorder id is required');
    err.code = 'MISSING_ID';
    throw err;
  }
  const orgId = getOrgId();
  const token = await getAccessToken();
  const url = `${getBooksBaseUrl()}/salesorders/${encodeURIComponent(id)}?organization_id=${encodeURIComponent(orgId)}`;

  logZohoRequest('getSalesorderById', 'GET', url, null);

  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });

  const raw = await readBooksJsonResponse(res);
  logZohoResponse('getSalesorderById', res.status, raw);

  const code = raw && typeof raw.code === 'number' ? raw.code : undefined;
  const codeOk = code === undefined || code === 0;
  if (!res.ok || !codeOk) {
    logZohoError('getSalesorderById', 'GET', url, res.status, raw);
    const msg = raw.message || raw.error || res.statusText || 'get_salesorder_failed';
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.zohoRaw = raw;
    err.statusCode = res.status;
    throw err;
  }

  const so = raw.salesorder && typeof raw.salesorder === 'object' ? raw.salesorder : null;
  return so;
}

/** @param {{ page?: number, perPage?: number, filterBy?: string, sortColumn?: string }} options */
async function listBillsPage(options = {}) {
  return listBooksCollectionPage('bills', 'bills', options);
}

/** @param {{ filterBy?: string, sortColumn?: string, perPage?: number, maxPages?: number }} options */
async function listAllBills(options = {}) {
  return listAllBooksCollection('bills', 'bills', options);
}

/** @param {{ page?: number, perPage?: number, filterBy?: string, sortColumn?: string }} options */
async function listPurchaseordersPage(options = {}) {
  return listBooksCollectionPage('purchaseorders', 'purchaseorders', options);
}

/** @param {{ filterBy?: string, sortColumn?: string, perPage?: number, maxPages?: number }} options */
async function listAllPurchaseorders(options = {}) {
  return listAllBooksCollection('purchaseorders', 'purchaseorders', options);
}

/**
 * GET /purchaseorders/{id} — includes `line_items` when the list endpoint does not.
 * @param {string} purchaseorderId
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function getPurchaseOrderById(purchaseorderId) {
  const id = normalizeZohoId(purchaseorderId);
  if (!id) {
    const err = new Error('getPurchaseOrderById: purchaseorder id is required');
    err.code = 'MISSING_ID';
    throw err;
  }
  const orgId = getOrgId();
  const token = await getAccessToken();
  const url = `${getBooksBaseUrl()}/purchaseorders/${encodeURIComponent(id)}?organization_id=${encodeURIComponent(orgId)}`;

  logZohoRequest('getPurchaseOrderById', 'GET', url, null);

  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });

  const raw = await readBooksJsonResponse(res);
  logZohoResponse('getPurchaseOrderById', res.status, raw);

  const code = raw && typeof raw.code === 'number' ? raw.code : undefined;
  const codeOk = code === undefined || code === 0;
  if (!res.ok || !codeOk) {
    logZohoError('getPurchaseOrderById', 'GET', url, res.status, raw);
    const msg = raw.message || raw.error || res.statusText || 'get_purchaseorder_failed';
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.zohoRaw = raw;
    err.statusCode = res.status;
    throw err;
  }

  const po = raw.purchaseorder && typeof raw.purchaseorder === 'object' ? raw.purchaseorder : null;
  return po;
}

/**
 * List Zoho Inventory locations (GET /locations) — single page.
 * @param {{ page?: number, perPage?: number }} options
 * @returns {Promise<{ raw: unknown, locations: Record<string, unknown>[], pageContext: Record<string, unknown> | null }>}
 */
async function listInventoryLocationsPage(options = {}) {
  const orgId = getInventoryOrgId();
  const token = await getAccessToken();
  const page = options.page != null ? Math.max(1, Number(options.page)) : 1;
  const perPage = Math.min(200, options.perPage != null ? Number(options.perPage) : 200);
  const qs = new URLSearchParams({
    organization_id: orgId,
    page: String(page),
    per_page: String(perPage),
  });
  const url = `${getInventoryBaseUrl()}/locations?${qs.toString()}`;

  logZohoRequest('listInventoryLocationsPage', 'GET', url, null);

  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });

  const raw = await readBooksJsonResponse(res);
  logZohoResponse('listInventoryLocationsPage', res.status, raw);

  if (!res.ok) {
    logZohoError('listInventoryLocationsPage', 'GET', url, res.status, raw);
    const msg = raw.message || raw.error || res.statusText || 'list_inventory_locations_failed';
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.zohoRaw = raw;
    err.statusCode = res.status;
    throw err;
  }

  const code = raw && typeof raw.code === 'number' ? raw.code : undefined;
  if (code !== undefined && code !== 0) {
    const msg = raw.message || raw.error || 'list_inventory_locations_failed';
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.zohoRaw = raw;
    err.statusCode = res.status;
    throw err;
  }

  const locations = Array.isArray(raw.locations) ? raw.locations : [];
  const pageContext =
    raw.page_context && typeof raw.page_context === 'object' ? raw.page_context : null;
  return { raw, locations, pageContext };
}

/**
 * All Zoho Inventory locations across pages.
 * @param {{ perPage?: number, maxPages?: number, limit?: number }} options
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function listAllInventoryLocations(options = {}) {
  const perPage = options.perPage != null ? Math.min(200, Number(options.perPage)) : 200;
  const maxPages = options.maxPages != null ? Math.max(1, Number(options.maxPages)) : 10000;
  const lim =
    options.limit != null && Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : undefined;
  const all = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= maxPages) {
    const { locations, pageContext } = await listInventoryLocationsPage({ page, perPage });
    all.push(...locations);
    if (lim != null && all.length >= lim) {
      return all.slice(0, lim);
    }
    hasMore = !!(pageContext && pageContext.has_more_page === true);
    page += 1;
  }

  return all;
}

/**
 * List Zoho Inventory warehouses (GET /warehouses) — single page.
 * Authoritative for branch_id, branch_name, is_primary, and warehouse address fields.
 * @param {{ page?: number, perPage?: number }} options
 * @returns {Promise<{ raw: unknown, warehouses: Record<string, unknown>[], pageContext: Record<string, unknown> | null }>}
 */
async function listInventoryWarehousesPage(options = {}) {
  const orgId = getInventoryOrgId();
  const token = await getAccessToken();
  const page = options.page != null ? Math.max(1, Number(options.page)) : 1;
  const perPage = Math.min(200, options.perPage != null ? Number(options.perPage) : 200);
  const qs = new URLSearchParams({
    organization_id: orgId,
    page: String(page),
    per_page: String(perPage),
  });
  const url = `${getInventoryBaseUrl()}/warehouses?${qs.toString()}`;

  logZohoRequest('listInventoryWarehousesPage', 'GET', url, null);

  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });

  const raw = await readBooksJsonResponse(res);
  logZohoResponse('listInventoryWarehousesPage', res.status, raw);

  if (!res.ok) {
    logZohoError('listInventoryWarehousesPage', 'GET', url, res.status, raw);
    const msg = raw.message || raw.error || res.statusText || 'list_inventory_warehouses_failed';
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.zohoRaw = raw;
    err.statusCode = res.status;
    throw err;
  }

  const code = raw && typeof raw.code === 'number' ? raw.code : undefined;
  if (code !== undefined && code !== 0) {
    const msg = raw.message || raw.error || 'list_inventory_warehouses_failed';
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.zohoRaw = raw;
    err.statusCode = res.status;
    throw err;
  }

  const warehouses = Array.isArray(raw.warehouses) ? raw.warehouses : [];
  const pageContext =
    raw.page_context && typeof raw.page_context === 'object' ? raw.page_context : null;
  return { raw, warehouses, pageContext };
}

/**
 * All Zoho Inventory warehouses across pages.
 * @param {{ perPage?: number, maxPages?: number, limit?: number }} options
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function listAllInventoryWarehouses(options = {}) {
  const perPage = options.perPage != null ? Math.min(200, Number(options.perPage)) : 200;
  const maxPages = options.maxPages != null ? Math.max(1, Number(options.maxPages)) : 10000;
  const lim =
    options.limit != null && Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : undefined;
  const all = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= maxPages) {
    const { warehouses, pageContext } = await listInventoryWarehousesPage({ page, perPage });
    all.push(...warehouses);
    if (lim != null && all.length >= lim) {
      return all.slice(0, lim);
    }
    hasMore = !!(pageContext && pageContext.has_more_page === true);
    page += 1;
  }

  return all;
}

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
  deleteItem,
  deleteBooksResource,
  deleteContact,
  deleteInvoice,
  deleteEstimate,
  deleteSalesorder,
  deleteBill,
  deletePurchaseOrder,
  createInvoice,
  createPurchaseOrderInBooks,
  createBillInBooks,
  listItemsPage,
  listAllItems,
  listBooksCollectionPage,
  listAllBooksCollection,
  listContactsPage,
  listAllContacts,
  getContactById,
  listInvoicesPage,
  listAllInvoices,
  listEstimatesPage,
  listAllEstimates,
  listSalesordersPage,
  listAllSalesorders,
  getSalesorderById,
  listBillsPage,
  listAllBills,
  listPurchaseordersPage,
  listAllPurchaseorders,
  getPurchaseOrderById,
  listCurrencies,
  normalizeZohoId,
  normalizeZohoContactId,
  getBooksBaseUrl,
  getOrgId,
  getInventoryBaseUrl,
  getInventoryOrgId,
  listInventoryLocationsPage,
  listAllInventoryLocations,
  listInventoryWarehousesPage,
  listAllInventoryWarehouses,
  fetchCompositeItem,
  getAccessTokenCacheMeta,
  zohoDebugEnabled,
  stringifyForLog,
  parseBooksApiJson,
  readBooksJsonResponse,
};

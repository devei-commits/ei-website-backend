const { createItem } = require('../services/zohoBooks');
const zohoEnv = require('../services/zohoEnv');
const { isZohoDuplicateItemError } = require('../services/zohoSyncHelpers');

function numOrZero(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Map Product + optional request body to Zoho Books POST /items JSON.
 * Omits empty strings so Zoho applies org defaults (avoid " " placeholders).
 * @param {*} product - Sequelize Product instance (after create)
 * @param {Record<string, unknown>} body - req.body (optional overrides: rate, zoho_sku_code|product_sku, tax_id, product_type, hsn_or_sac)
 */
function buildZohoItemPayload(product, body = {}) {
  const name = (body.product_name != null ? body.product_name : product.product_name) || '';
  if (!String(name).trim()) {
    throw new Error('product_name is required for Zoho item');
  }

  const rate =
    body.rate != null
      ? numOrZero(body.rate)
      : numOrZero(product.mrp_price);

  // Resolve the SKU we send to Zoho: prefer explicit body.zoho_sku_code (new), fall back
  // to legacy body.product_sku, then the row's persisted column, then product_code.
  const skuRaw =
    (body.zoho_sku_code != null && String(body.zoho_sku_code).trim()) ||
    (body.product_sku != null && String(body.product_sku).trim()) ||
    (product.zoho_sku_code && String(product.zoho_sku_code).trim()) ||
    (body.product_code != null && String(body.product_code).trim()) ||
    (product.product_code && String(product.product_code).trim()) ||
    `EI-P-${product.product_id}`;

  const payload = {
    name: String(name).trim().slice(0, 200),
    rate,
    sku: String(skuRaw).slice(0, 100),
    product_type: (body.product_type && String(body.product_type)) || 'goods',
  };

  const desc =
    (body.product_description != null ? body.product_description : product.product_description) ||
    (body.description != null ? body.description : null);
  if (desc != null && String(desc).trim()) {
    payload.description = String(desc).trim().slice(0, 5000);
  }

  const taxRate = product.tax_rate != null ? numOrZero(product.tax_rate) : null;
  if (body.tax_percentage != null) {
    const tp = body.tax_percentage;
    const n = typeof tp === 'string' && tp.includes('%') ? parseFloat(tp.replace('%', '')) : Number(tp);
    if (Number.isFinite(n) && n > 0) {
      payload.tax_percentage = n;
      payload.is_taxable = true;
    }
  } else if (taxRate != null && taxRate > 0) {
    payload.tax_percentage = taxRate;
    payload.is_taxable = true;
  } else if (body.is_taxable !== undefined) {
    payload.is_taxable = !!body.is_taxable;
  }

  const taxId = body.tax_id ?? process.env.ZOHO_DEFAULT_ITEM_TAX_ID;
  if (taxId !== undefined && taxId !== null && String(taxId).trim() !== '') {
    const tid = String(taxId).trim();
    const t = zohoEnv.zohoNumericIdForJson(tid);
    if (t !== undefined) payload.tax_id = t;
  }

  const hsn = body.hsn_or_sac != null ? String(body.hsn_or_sac).trim() : '';
  if (hsn) payload.hsn_or_sac = hsn;

  return payload;
}

/**
 * Create Zoho item after Product.create. Non-throwing; returns result object.
 * @param {*} product
 * @param {Record<string, unknown>} createBody
 */
async function syncZohoItemForNewProduct(product, createBody = {}) {
  if (!zohoEnv.booksEnabled) {
    return { synced: false, error: 'zoho_disabled' };
  }
  if (!zohoEnv.syncItems) {
    return { synced: false, error: 'item_sync_disabled' };
  }
  if (product.zoho_item_id) {
    return { synced: false, error: 'already_has_zoho_item_id' };
  }

  try {
    const payload = buildZohoItemPayload(product, createBody);
    const { itemId, raw } = await createItem(payload);
    if (!itemId) {
      return { synced: false, error: 'zoho_missing_item_id', zohoMessage: raw && raw.message, duplicate: false };
    }
    // Capture Zoho's persisted item.sku so the caller can mirror it back into zoho_sku_code.
    const sku = raw && raw.item && raw.item.sku ? String(raw.item.sku) : null;
    return { synced: true, itemId, sku };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : 'zoho_item_sync_failed';
    const duplicate = isZohoDuplicateItemError(e);
    console.error('[Zoho] create item failed:', msg, e.zohoRaw || '');
    return { synced: false, error: msg, duplicate };
  }
}

module.exports = {
  buildZohoItemPayload,
  syncZohoItemForNewProduct,
};

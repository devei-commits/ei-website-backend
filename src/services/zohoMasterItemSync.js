const { createItem } = require('./zohoBooks');
const zohoEnv = require('./zohoEnv');

function numOrZero(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function getAttr(row, key) {
  return row.get ? row.get(key) : row[key];
}

/**
 * Map raw_material row + optional request overrides to Zoho Books POST /items JSON.
 * @param {*} row - Sequelize RawMaterial after create
 * @param {Record<string, unknown>} body - req.body (optional: name, sku, rate, tax_id, product_type, hsn_or_sac, gst)
 */
function buildRawMaterialZohoPayload(row, body = {}) {
  const name =
    (body.name != null && String(body.name).trim()) ||
    (getAttr(row, 'name') && String(getAttr(row, 'name')).trim()) ||
    (getAttr(row, 'code') && String(getAttr(row, 'code')).trim());
  if (!name) {
    throw new Error('name is required for Zoho item (raw material)');
  }

  const sku =
    (body.sku != null && String(body.sku).trim()) ||
    (getAttr(row, 'sku') && String(getAttr(row, 'sku')).trim()) ||
    (getAttr(row, 'code') && String(getAttr(row, 'code')).trim()) ||
    `EI-RM-${getAttr(row, 'id')}`;

  const rate = body.rate != null ? numOrZero(body.rate) : numOrZero(getAttr(row, 'price_per_kg'));

  const payload = {
    name: String(name).trim().slice(0, 200),
    rate,
    sku: String(sku).slice(0, 100),
    product_type: (body.product_type && String(body.product_type)) || 'goods',
  };

  const inci = getAttr(row, 'inci');
  if (inci && String(inci).trim()) {
    payload.description = String(inci).trim().slice(0, 5000);
  }

  const gstNum = body.gst != null ? numOrZero(body.gst) : numOrZero(getAttr(row, 'gst'));
  if (gstNum > 0) {
    payload.tax_percentage = gstNum;
    payload.is_taxable = true;
  }

  const taxId = body.tax_id ?? process.env.ZOHO_DEFAULT_ITEM_TAX_ID;
  if (taxId !== undefined && taxId !== null && String(taxId).trim() !== '') {
    const tid = String(taxId).trim();
    const t = zohoEnv.zohoNumericIdForJson(tid);
    if (t !== undefined) payload.tax_id = t;
  }

  const hsnRaw = body.hsn_or_sac != null ? body.hsn_or_sac : getAttr(row, 'hsn_code');
  if (hsnRaw != null && String(hsnRaw).trim()) {
    payload.hsn_or_sac = String(hsnRaw).trim();
  }

  return payload;
}

/**
 * Map pack_material row + optional request overrides to Zoho Books POST /items JSON.
 * @param {*} row - Sequelize PackMaterial after create
 * @param {Record<string, unknown>} body - req.body (optional: description, name, sku, rate, tax_id, product_type, hsn_or_sac, tax_percentage)
 */
function buildPackMaterialZohoPayload(row, body = {}) {
  const name =
    (body.description != null && String(body.description).trim()) ||
    (body.name != null && String(body.name).trim()) ||
    (getAttr(row, 'description') && String(getAttr(row, 'description')).trim()) ||
    (getAttr(row, 'code') && String(getAttr(row, 'code')).trim());
  if (!name) {
    throw new Error('description is required for Zoho item (pack material)');
  }

  const sku =
    (body.sku != null && String(body.sku).trim()) ||
    (getAttr(row, 'sku') && String(getAttr(row, 'sku')).trim()) ||
    (getAttr(row, 'code') && String(getAttr(row, 'code')).trim()) ||
    `EI-PM-${getAttr(row, 'id')}`;

  const rate = body.rate != null ? numOrZero(body.rate) : numOrZero(getAttr(row, 'price_per_pc'));

  const payload = {
    name: String(name).trim().slice(0, 200),
    rate,
    sku: String(sku).slice(0, 100),
    product_type: (body.product_type && String(body.product_type)) || 'goods',
  };

  const mat = getAttr(row, 'material');
  const spec = getAttr(row, 'size_spec');
  const descParts = [mat, spec].filter((x) => x && String(x).trim());
  if (descParts.length) {
    payload.description = descParts.join(' — ').slice(0, 5000);
  }

  if (body.tax_percentage != null) {
    const tp = body.tax_percentage;
    const n = typeof tp === 'string' && tp.includes('%') ? parseFloat(tp.replace('%', '')) : Number(tp);
    if (Number.isFinite(n) && n > 0) {
      payload.tax_percentage = n;
      payload.is_taxable = true;
    }
  }

  const taxId = body.tax_id ?? process.env.ZOHO_DEFAULT_ITEM_TAX_ID;
  if (taxId !== undefined && taxId !== null && String(taxId).trim() !== '') {
    const tid = String(taxId).trim();
    const t = zohoEnv.zohoNumericIdForJson(tid);
    if (t !== undefined) payload.tax_id = t;
  }

  const hsnRaw = body.hsn_or_sac != null ? body.hsn_or_sac : getAttr(row, 'hsn_code');
  if (hsnRaw != null && String(hsnRaw).trim()) {
    payload.hsn_or_sac = String(hsnRaw).trim();
  }

  return payload;
}

/**
 * After RawMaterial.create. Non-throwing.
 * @param {*} row
 * @param {Record<string, unknown>} createBody - original req.body for overrides
 */
async function syncZohoItemForNewRawMaterial(row, createBody = {}) {
  if (!zohoEnv.booksEnabled) {
    return { synced: false, error: 'zoho_disabled' };
  }
  if (!zohoEnv.syncItems) {
    return { synced: false, error: 'item_sync_disabled' };
  }
  const existing = getAttr(row, 'zoho_id');
  if (existing && String(existing).trim()) {
    return { synced: false, error: 'already_has_zoho_id' };
  }

  try {
    const payload = buildRawMaterialZohoPayload(row, createBody);
    const { itemId, raw } = await createItem(payload);
    if (!itemId) {
      return { synced: false, error: 'zoho_missing_item_id', zohoMessage: raw && raw.message };
    }
    return { synced: true, itemId };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : 'zoho_item_sync_failed';
    console.error('[Zoho] RM create item failed:', msg, e.zohoRaw || '');
    return { synced: false, error: msg };
  }
}

/**
 * After PackMaterial.create. Non-throwing.
 * @param {*} row
 * @param {Record<string, unknown>} createBody - original req.body for overrides
 */
async function syncZohoItemForNewPackMaterial(row, createBody = {}) {
  if (!zohoEnv.booksEnabled) {
    return { synced: false, error: 'zoho_disabled' };
  }
  if (!zohoEnv.syncItems) {
    return { synced: false, error: 'item_sync_disabled' };
  }
  const existing = getAttr(row, 'zoho_id');
  if (existing && String(existing).trim()) {
    return { synced: false, error: 'already_has_zoho_id' };
  }

  try {
    const payload = buildPackMaterialZohoPayload(row, createBody);
    const { itemId, raw } = await createItem(payload);
    if (!itemId) {
      return { synced: false, error: 'zoho_missing_item_id', zohoMessage: raw && raw.message };
    }
    return { synced: true, itemId };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : 'zoho_item_sync_failed';
    console.error('[Zoho] PM create item failed:', msg, e.zohoRaw || '');
    return { synced: false, error: msg };
  }
}

module.exports = {
  buildRawMaterialZohoPayload,
  buildPackMaterialZohoPayload,
  syncZohoItemForNewRawMaterial,
  syncZohoItemForNewPackMaterial,
};

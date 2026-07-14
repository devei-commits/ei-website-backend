/**
 * Map a Zoho Books item (from GET /items) into local master columns for the
 * "import missing SKU from Zoho" feature (RM / PM / PR).
 *
 * This is the PULL direction: the item already exists in Zoho Books; we mirror it
 * into the corresponding master table without pushing anything back to Zoho.
 * Column names match the models (note: SKU column is `zoho_sku_code`, not `sku`).
 */
const { normalizeZohoId } = require('./zohoBooks');

function parseMaybeNum(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function trunc(v, maxLen) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/** Common scalar values pulled off a Zoho item, reused by all three mappers. */
function commonZohoFields(item) {
  const zid = normalizeZohoId(item.item_id);
  const sku = String(item.sku == null ? '' : item.sku).trim();
  const name = String(item.name == null ? '' : item.name).trim();
  // Prefer purchase_rate for materials, sales rate for products; fall back across both.
  const purchaseRate =
    item.purchase_rate != null && String(item.purchase_rate).trim() !== ''
      ? item.purchase_rate
      : item.rate != null
        ? item.rate
        : item.sales_rate;
  const salesRate = item.rate != null ? item.rate : item.sales_rate;
  const hsn = item.hsn_or_sac != null && String(item.hsn_or_sac).trim() !== '' ? String(item.hsn_or_sac).trim() : null;
  const unit = item.unit != null && String(item.unit).trim() !== '' ? String(item.unit).trim() : null;
  const description =
    item.description != null && String(item.description).trim() !== '' ? String(item.description).trim() : null;
  const status = item.status != null && String(item.status).trim() !== '' ? String(item.status).trim().toLowerCase() : null;
  const taxPct = parseMaybeNum(item.tax_percentage);
  return { zid, sku, name, purchaseRate, salesRate, hsn, unit, description, status, taxPct };
}

/** Raw material columns from a Zoho item. */
function toRawMaterialFields(item) {
  const c = commonZohoFields(item);
  const code = trunc(c.sku || (c.zid ? `ZHO-RM-${c.zid}` : 'UNKNOWN'), 100) || 'UNKNOWN';
  return {
    code,
    name: trunc(c.name || code, 255) || code,
    price_per_kg: parseMaybeNum(c.purchaseRate),
    gst: c.taxPct,
    zoho_sku_code: trunc(c.sku, 100),
    hsn_code: trunc(c.hsn, 50),
    uom: trunc(c.unit, 20),
    zoho_id: c.zid,
  };
}

/** Pack material columns from a Zoho item. */
function toPackMaterialFields(item) {
  const c = commonZohoFields(item);
  const code = trunc(c.sku || (c.zid ? `ZHO-PM-${c.zid}` : 'UNKNOWN'), 100) || 'UNKNOWN';
  return {
    code,
    description: trunc(c.name || code, 500) || code,
    price_per_pc: parseMaybeNum(c.purchaseRate),
    zoho_sku_code: trunc(c.sku, 100),
    hsn_code: trunc(c.hsn, 50),
    unit: trunc(c.unit, 20),
    type: 'Packaging Material',
    zoho_id: c.zid,
  };
}

/** Product (PR) columns from a Zoho item. */
function toProductFields(item) {
  const c = commonZohoFields(item);
  const productCode = trunc(c.sku || (c.zid ? `ZHO-PR-${c.zid}` : null), 100);
  return {
    zoho_item_id: c.zid,
    product_code: productCode,
    zoho_sku_code: trunc(c.sku, 100),
    product_name: trunc(c.name || productCode || 'Zoho item', 255),
    mrp_price: parseMaybeNum(c.salesRate),
    tax_rate: c.taxPct,
    product_description: c.description,
  };
}

module.exports = {
  commonZohoFields,
  toRawMaterialFields,
  toPackMaterialFields,
  toProductFields,
};

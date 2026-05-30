/**
 * Resolve Composite SKU from Formula / Packaging BOM Excel to an existing PR row,
 * or create a minimal Draft product when the SKU is new (bulk import upsert).
 */

const { Op } = require('sequelize');
const { Product } = require('./models');

async function findProductByCompositeSku(compositeSku) {
  const t = String(compositeSku || '').trim();
  if (!t) return null;
  let p = await Product.findOne({ where: { zoho_sku_code: t } });
  if (p) return p;
  p = await Product.findOne({ where: { zoho_sku_code: { [Op.iLike]: t } } });
  if (p) return p;
  p = await Product.findOne({ where: { product_code: t } });
  if (p) return p;
  p = await Product.findOne({ where: { product_code: { [Op.iLike]: t } } });
  return p || null;
}

/** @returns {{ product: object | null, created: boolean }} */
async function findOrCreateProductForFormulaBom(compositeSku, compositeName) {
  const sku = String(compositeSku || '').trim();
  if (!sku) return { product: null, created: false };

  let product = await findProductByCompositeSku(sku);
  if (product) return { product, created: false };

  const displayName = String(compositeName || '').trim() || sku;
  const now = new Date();

  try {
    product = await Product.create({
      zoho_sku_code: sku,
      product_code: sku,
      product_name: displayName,
      status: 'Draft',
      lifecycle_status: 'Draft',
      created_at: now,
      updated_at: now,
    });
    return { product, created: true };
  } catch (e) {
    const isUnique =
      e &&
      (e.name === 'SequelizeUniqueConstraintError' ||
        e.parent?.code === '23505' ||
        String(e?.message || '').includes('unique'));
    if (isUnique) {
      product = await findProductByCompositeSku(sku);
      if (product) return { product, created: false };
    }
    throw e;
  }
}

/**
 * Align PR product_code + zoho_sku_code with Formula/Packaging BOM Excel composite SKU.
 * @param {object} product — Sequelize Product instance
 * @param {string} compositeSku
 */
async function syncProductSkuCodesFromCompositeImport(product, compositeSku) {
  const sku = String(compositeSku || '').trim();
  if (!sku || !product) return;

  const updates = {};
  if (String(product.zoho_sku_code || '').trim() !== sku) updates.zoho_sku_code = sku;
  if (String(product.product_code || '').trim() !== sku) updates.product_code = sku;
  if (Object.keys(updates).length === 0) return;

  await product.update({ ...updates, updated_at: new Date() });
}

function normalizePackSizeUom(raw) {
  const u = String(raw || '').trim().toUpperCase();
  if (!u) return null;
  if (u === 'ML' || u === 'MILLILITER' || u === 'MILLILITRE' || u === 'MILLILITERS' || u === 'MILLILITRES') return 'ML';
  if (u === 'L' || u === 'LTR' || u === 'LT' || u === 'LITER' || u === 'LITRE' || u === 'LITERS' || u === 'LITRES') return 'L';
  if (u === 'G' || u === 'GM' || u === 'GRAM' || u === 'GRAMS') return 'G';
  if (u === 'KG' || u === 'KGS' || u === 'KILOGRAM' || u === 'KILOGRAMS') return 'KG';
  return null;
}

function parsePackSizeFromCompositeName(compositeName) {
  const s = String(compositeName || '').trim();
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(ML|MILLILIT(?:ER|RE)S?|L|LTR|LT|LIT(?:ER|RE)S?|G|GM|GRAMS?|KG|KGS|KILOGRAMS?)\b/i);
  if (!m) return null;
  const qty = Number(m[1]);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const uom = normalizePackSizeUom(m[2]);
  if (!uom) return null;
  return `${qty % 1 === 0 ? String(Math.trunc(qty)) : String(qty)} ${uom}`;
}

/**
 * Composite Name carries pack size in most sheets (e.g. "... 30 ML").
 * Fallback to explicit Volume + UoM columns when present.
 */
function derivePackSizeFromFormulaRow(row) {
  const byName = parsePackSizeFromCompositeName(row?.composite_name);
  if (byName) return byName;

  const vol =
    row?.limit_qty_volume != null && Number.isFinite(row.limit_qty_volume)
      ? Number(row.limit_qty_volume)
      : row?.limit_qty_vol_kg_ltr != null && Number.isFinite(row.limit_qty_vol_kg_ltr)
        ? Number(row.limit_qty_vol_kg_ltr)
        : null;
  const uom = normalizePackSizeUom(row?.uom_raw);
  if (vol != null && vol > 0 && uom) {
    return `${vol % 1 === 0 ? String(Math.trunc(vol)) : String(vol)} ${uom}`;
  }
  return null;
}

/** Map formula Excel volume/UoM → BOM sku_bom_limit_* (pack size for sale orders). */
function skuBomLimitFromFormulaRow(row) {
  const vol =
    row?.limit_qty_volume != null && Number.isFinite(Number(row.limit_qty_volume))
      ? Number(row.limit_qty_volume)
      : row?.limit_qty_vol_kg_ltr != null && Number.isFinite(Number(row.limit_qty_vol_kg_ltr))
        ? Number(row.limit_qty_vol_kg_ltr)
        : null;
  const uomNorm = normalizePackSizeUom(row?.uom_raw);
  if (vol != null && vol > 0 && uomNorm) {
    const skuUom = uomNorm === 'G' ? 'GM' : uomNorm;
    return { qty: vol, uom: skuUom };
  }
  const packSize = derivePackSizeFromFormulaRow(row);
  if (!packSize) return null;
  const m = String(packSize).trim().match(/^(\d+(?:\.\d+)?)\s*(G|ML|KG|L)$/i);
  if (!m) return null;
  const qty = Number(m[1]);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const u = normalizePackSizeUom(m[2]);
  if (!u) return null;
  return { qty, uom: u === 'G' ? 'GM' : u };
}

async function applyPackSizeToProductAndBom({ product, bom, groupFirstRow, now = new Date() }) {
  const lim = skuBomLimitFromFormulaRow(groupFirstRow);
  if (!lim) return { pack_size: null, applied: false };

  const { formatSkuBomLimitAsPack } = require('../lib/skuBomPackSize');
  const packSize = formatSkuBomLimitAsPack(lim.qty, lim.uom);
  if (bom) {
    await bom.update({
      sku_bom_limit_qty: lim.qty,
      sku_bom_limit_uom: lim.uom,
      pack_size: packSize,
      updated_at: now,
    });
  }
  return { pack_size: packSize, applied: true };
}

/** SG vs water from Summary sheet: Total RM (GM) ÷ Pack Size. */
function computeProductSgFromTotalRmGm(totalRmGm, packSize) {
  const total = Number(totalRmGm);
  const pack = Number(packSize);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(pack) || pack <= 0) return null;
  const sg = total / pack;
  if (!Number.isFinite(sg) || sg <= 0) return null;
  return Number(sg.toFixed(3));
}

const BOM_NOTE_SEGMENTS = [
  { key: 'pr_qc_group', label: 'QC Group' },
  { key: 'pr_sub_category', label: 'PR Sub-category' },
  { key: 'microbial_limits', label: 'Microbial Limits' },
  { key: 'spf_pa_rating', label: 'SPF/PA Rating' },
  { key: 'photostability', label: 'Photostability' },
  { key: 'freeze_thaw_cycles', label: 'Freeze-Thaw Cycles' },
  { key: 'cosmos_natural_certification', label: 'COSMOS / Natural Certification' },
  { key: 'dermatologically_tested', label: 'Dermatologically Tested' },
  { key: 'cruelty_free_vegan', label: 'Cruelty Free / Vegan' },
];

function parseBomNotesForMerge(notes) {
  const result = {};
  for (const seg of BOM_NOTE_SEGMENTS) {
    result[seg.key] = null;
  }
  const text = String(notes || '').trim();
  if (!text) return result;
  const parts = text.split('|').map((p) => String(p || '').trim()).filter(Boolean);
  parts.forEach((part) => {
    const idx = part.indexOf(':');
    if (idx < 0) return;
    const key = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (!value) return;
    for (const seg of BOM_NOTE_SEGMENTS) {
      if (key === seg.label.toLowerCase()) {
        result[seg.key] = value;
        break;
      }
    }
  });
  return result;
}

function serializeBomNotes(parsed) {
  const parts = [];
  for (const seg of BOM_NOTE_SEGMENTS) {
    const v = String(parsed[seg.key] ?? '').trim();
    if (v) parts.push(`${seg.label}: ${v}`);
  }
  return parts.length ? parts.join(' | ') : null;
}

/** Replace PR Sub-category in BOM notes without dropping other segments. */
function mergeBomNotesPrSubCategory(existingNotes, subCategory) {
  const parsed = parseBomNotesForMerge(existingNotes);
  const sub = String(subCategory ?? '').trim();
  parsed.pr_sub_category = sub || null;
  return serializeBomNotes(parsed);
}

/** Map Summary row pack size + unit → BOM sku_bom_limit_* */
function skuBomLimitFromSummaryRow(row) {
  const qty = Number(row?.pack_size);
  const uomNorm = normalizePackSizeUom(row?.unit);
  if (!Number.isFinite(qty) || qty <= 0 || !uomNorm) return null;
  const skuUom = uomNorm === 'G' ? 'GM' : uomNorm;
  return { qty, uom: skuUom };
}

module.exports = {
  findProductByCompositeSku,
  findOrCreateProductForFormulaBom,
  syncProductSkuCodesFromCompositeImport,
  derivePackSizeFromFormulaRow,
  applyPackSizeToProductAndBom,
  normalizePackSizeUom,
  computeProductSgFromTotalRmGm,
  mergeBomNotesPrSubCategory,
  skuBomLimitFromSummaryRow,
};

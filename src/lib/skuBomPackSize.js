/**
 * Pack size for sale orders / fulfillment — sourced from PR SKU BOM net per unit.
 */

function formatSkuBomLimitAsPack(qtyRaw, uomRaw) {
  const q = Number(qtyRaw);
  if (!Number.isFinite(q) || q <= 0) return '0';
  const u = String(uomRaw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!u) return '0';
  const qtyStr = q % 1 === 0 ? String(Math.trunc(q)) : String(q);
  if (u === 'GM' || u === 'G' || u === 'GRAM' || u === 'GRAMS') return `${qtyStr} G`;
  if (u === 'KG' || u === 'KGS' || u === 'KILO' || u === 'KILOGRAM' || u === 'KILOGRAMS') return `${qtyStr} KG`;
  if (u === 'ML' || u === 'MILLILITRE' || u === 'MILLILITER' || u === 'MILLILITRES' || u === 'MILLILITERS') {
    return `${qtyStr} ML`;
  }
  if (u === 'L' || u === 'LT' || u === 'LTR' || u === 'LITRE' || u === 'LITER' || u === 'LITRES' || u === 'LITERS') {
    return `${qtyStr} L`;
  }
  return `${qtyStr} ${u}`;
}

function packSizeFromBomRow(bom) {
  if (!bom) return '0';
  const plain = bom.get ? bom.get({ plain: true }) : bom;
  return formatSkuBomLimitAsPack(plain.sku_bom_limit_qty, plain.sku_bom_limit_uom);
}

function packSizeFromProductAndBom(product, bom) {
  const fromBom = packSizeFromBomRow(bom);
  if (fromBom && fromBom !== '0') return fromBom;
  const p = product?.get ? product.get({ plain: true }) : product;
  if (p?.sku_bom_limit_qty != null || p?.sku_bom_limit_uom) {
    return formatSkuBomLimitAsPack(p.sku_bom_limit_qty, p.sku_bom_limit_uom);
  }
  return '0';
}

module.exports = {
  formatSkuBomLimitAsPack,
  packSizeFromBomRow,
  packSizeFromProductAndBom,
};

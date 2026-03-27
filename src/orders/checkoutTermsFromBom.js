const BOM = require('../bom/models');
const { Product } = require('../products/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { ItemsList, ItemListVendorRate, ItemListTier } = require('../itemsList/models');
const { resolveStagedPaymentTerms, clampPct } = require('../itemsList/stagedPaymentTerms');

function round2(v) {
  return Math.round(Number(v || 0) * 100) / 100;
}

/**
 * Best vendor rate for an items_list row: prefer active, first with tiers.
 */
async function loadRateWithTiers(itemsListId, transaction) {
  if (!itemsListId) return null;
  const rates = await ItemListVendorRate.findAll({
    where: { items_list_id: itemsListId },
    order: [['id', 'ASC']],
    transaction,
  });
  if (!rates.length) return null;
  const active = rates.filter((r) => String(r.status || '').toLowerCase() !== 'inactive');
  const list = active.length ? active : rates;
  const first = list[0];
  const rid = first.id;
  const tiers = await ItemListTier.findAll({
    where: { item_list_vendor_rate_id: rid },
    order: [['moq_min', 'ASC']],
    transaction,
  });
  const plain = first.get ? first.get({ plain: true }) : first;
  plain.tiers = tiers.map((t) => (t.get ? t.get({ plain: true }) : t));
  return plain;
}

function tierMinMoq(tiers) {
  if (!Array.isArray(tiers) || !tiers.length) return 1;
  const mins = tiers.map((t) => Number(t.moq_min)).filter((n) => Number.isFinite(n) && n > 0);
  return mins.length ? Math.min(...mins) : 1;
}

async function termsAndMoqForItemsListRow(itemsListId, transaction) {
  const rate = await loadRateWithTiers(itemsListId, transaction);
  if (!rate) {
    return {
      terms: { advance_pct: 0, pre_shipment_pct: 100, post_shipment_pct: 0, credit_days: 0 },
      moqMaterial: 1,
      weight: 1,
    };
  }
  const tiers = rate.tiers || [];
  const staged = resolveStagedPaymentTerms(rate.payment_terms);
  const moq = Number(rate.default_moq) > 0 ? Number(rate.default_moq) : tierMinMoq(tiers);
  const priceHint = tiers.length
    ? Number(tiers[0].price_per_unit) || Number(rate.default_rate) || 1
    : Number(rate.default_rate) || 1;
  return {
    terms: staged,
    moqMaterial: Math.max(1, Math.floor(moq)),
    weight: Math.max(0.0001, priceHint),
  };
}

async function findItemsListForRmPm({ raw_material_id, pack_material_id, transaction }) {
  if (raw_material_id) {
    const row = await ItemsList.findOne({
      where: { type: 'RM', raw_material_id },
      attributes: ['id'],
      transaction,
    });
    return row ? row.id : null;
  }
  if (pack_material_id) {
    const row = await ItemsList.findOne({
      where: { type: 'PM', pack_material_id },
      attributes: ['id'],
      transaction,
    });
    return row ? row.id : null;
  }
  return null;
}

async function findItemsListForProduct(productId, transaction) {
  const row = await ItemsList.findOne({
    where: { type: 'PR', product_id: productId },
    attributes: ['id'],
    transaction,
  });
  return row ? row.id : null;
}

/**
 * Aggregate payment terms from BOM materials (weighted by BOM line weight × list price).
 * MOQ: max(material MOQs) as minimum finished-goods units (conservative; PR row overrides when set).
 */
async function computeProductCheckoutTerms(productId, quantity, transaction) {
  const product = await Product.findByPk(productId, { transaction });
  const batchSizeKg = Number(product?.batch_size_kg) > 0 ? Number(product.batch_size_kg) : 500;

  const prListId = await findItemsListForProduct(productId, transaction);
  if (prListId) {
    const { terms, moqMaterial } = await termsAndMoqForItemsListRow(prListId, transaction);
    return {
      terms,
      minQuantity: Math.max(1, moqMaterial),
      source: 'product_price_list',
      breakdown: [{ label: 'Product (PR) price list', ...terms }],
    };
  }

  const bom = await BOM.findOne({ where: { product_id: productId }, transaction });
  const rmLines = bom && Array.isArray(bom.rm_lines) ? bom.rm_lines : [];
  const pmLines = bom && Array.isArray(bom.pm_lines) ? bom.pm_lines : [];

  const contributions = [];
  let advW = 0;
  let preW = 0;
  let postW = 0;
  let creditDays = 0;
  let wSum = 0;
  let maxMoqUnits = 1;

  for (const line of rmLines) {
    const pct = clampPct(line.pct_w_w ?? line.pct ?? 0);
    const w = (pct / 100) * batchSizeKg;
    let rmId = line.raw_material_id != null ? Number(line.raw_material_id) : null;
    if (!rmId && (line.rm_code || line.code)) {
      const rm = await RawMaterial.findOne({ where: { code: line.rm_code || line.code }, transaction });
      if (rm) rmId = rm.id;
    }
    const listId = rmId ? await findItemsListForRmPm({ raw_material_id: rmId, pack_material_id: null, transaction }) : null;
    if (!listId) continue;
    const pack = await termsAndMoqForItemsListRow(listId, transaction);
    const tw = w > 0 ? w * pack.weight : pack.weight;
    advW += pack.terms.advance_pct * tw;
    preW += pack.terms.pre_shipment_pct * tw;
    postW += pack.terms.post_shipment_pct * tw;
    creditDays = Math.max(creditDays, pack.terms.credit_days || 0);
    wSum += tw;
    contributions.push({
      label: `RM ${line.rm_code || line.code || rmId}`,
      advance_pct: pack.terms.advance_pct,
      pre_shipment_pct: pack.terms.pre_shipment_pct,
      post_shipment_pct: pack.terms.post_shipment_pct,
    });
    maxMoqUnits = Math.max(maxMoqUnits, pack.moqMaterial);
  }

  for (const line of pmLines) {
    const qtyPer = Number(line.qty_per_unit ?? line.qty ?? 1);
    const w = qtyPer;
    let pmId = line.pack_material_id != null ? Number(line.pack_material_id) : null;
    if (!pmId && (line.pm_code || line.code)) {
      const pm = await PackMaterial.findOne({ where: { code: line.pm_code || line.code }, transaction });
      if (pm) pmId = pm.id;
    }
    const listId = pmId ? await findItemsListForRmPm({ raw_material_id: null, pack_material_id: pmId, transaction }) : null;
    if (!listId) continue;
    const pack = await termsAndMoqForItemsListRow(listId, transaction);
    const tw = w * pack.weight;
    advW += pack.terms.advance_pct * tw;
    preW += pack.terms.pre_shipment_pct * tw;
    postW += pack.terms.post_shipment_pct * tw;
    creditDays = Math.max(creditDays, pack.terms.credit_days || 0);
    wSum += tw;
    contributions.push({
      label: `PM ${line.pm_code || line.code || pmId}`,
      advance_pct: pack.terms.advance_pct,
      pre_shipment_pct: pack.terms.pre_shipment_pct,
      post_shipment_pct: pack.terms.post_shipment_pct,
    });
    const unitsFromMoq = qtyPer > 0 ? Math.ceil(pack.moqMaterial / qtyPer) : pack.moqMaterial;
    maxMoqUnits = Math.max(maxMoqUnits, unitsFromMoq, pack.moqMaterial);
  }

  if (wSum <= 0) {
    return {
      terms: { advance_pct: 0, pre_shipment_pct: 100, post_shipment_pct: 0, credit_days: 0 },
      minQuantity: 1,
      source: 'default',
      breakdown: [],
    };
  }

  let advance_pct = round2(advW / wSum);
  let pre_shipment_pct = round2(preW / wSum);
  let post_shipment_pct = round2(postW / wSum);
  const t = advance_pct + pre_shipment_pct + post_shipment_pct;
  if (t > 100.0001) {
    const k = 100 / t;
    advance_pct = round2(advance_pct * k);
    pre_shipment_pct = round2(pre_shipment_pct * k);
    post_shipment_pct = round2(post_shipment_pct * k);
  }

  return {
    terms: {
      advance_pct,
      pre_shipment_pct,
      post_shipment_pct,
      credit_days: creditDays,
    },
    minQuantity: Math.max(1, maxMoqUnits),
    source: 'bom_aggregate',
    breakdown: contributions,
  };
}

/**
 * @param {Array<{ product_id: number; quantity: number; line_subtotal?: number }>} lines
 */
async function computeCheckoutPreview(orderItems, transaction) {
  const results = [];
  let advT = 0;
  let preT = 0;
  let postT = 0;
  let creditMax = 0;
  let subSum = 0;

  for (const it of orderItems) {
    const productId = Number(it.product_id);
    const qty = Number(it.quantity) || 0;
    const lineSub = Number(it.line_subtotal ?? it.unit_price * qty) || 0;
    const row = await computeProductCheckoutTerms(productId, qty, transaction);
    subSum += lineSub;
    results.push({
      product_id: productId,
      quantity: qty,
      min_quantity: row.minQuantity,
      ok: qty >= row.minQuantity,
      payment_terms: row.terms,
      source: row.source,
      rm_pm_breakdown: row.breakdown,
    });
    advT += row.terms.advance_pct * lineSub;
    preT += row.terms.pre_shipment_pct * lineSub;
    postT += row.terms.post_shipment_pct * lineSub;
    creditMax = Math.max(creditMax, row.terms.credit_days || 0);
  }

  let advance_pct = subSum > 0 ? round2(advT / subSum) : 0;
  let pre_shipment_pct = subSum > 0 ? round2(preT / subSum) : 100;
  let post_shipment_pct = subSum > 0 ? round2(postT / subSum) : 0;
  const tt = advance_pct + pre_shipment_pct + post_shipment_pct;
  if (tt > 100.0001) {
    const k = 100 / tt;
    advance_pct = round2(advance_pct * k);
    pre_shipment_pct = round2(pre_shipment_pct * k);
    post_shipment_pct = round2(post_shipment_pct * k);
  }

  return {
    payment_terms: {
      advance_pct,
      pre_shipment_pct,
      post_shipment_pct,
      credit_days: creditMax,
    },
    lines: results,
    moq_ok: results.every((r) => r.ok),
  };
}

module.exports = {
  computeProductCheckoutTerms,
  computeCheckoutPreview,
};

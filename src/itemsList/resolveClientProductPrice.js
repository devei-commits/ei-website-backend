/**
 * Resolve finished-product (PR) unit price for a client from Items List client rates + MOQ tiers.
 * Used by Sale Order creation (not procurement PO).
 */
const { ItemsList, ItemListVendorRate, ItemListTier } = require('./models');
const { clientRatesPartyWhere } = require('./partyTypeWhere');
const { parseStagedPaymentTerms } = require('./stagedPaymentTerms');
const { parseMoqQuantity, moqValuesEqual } = require('../lib/moqQuantity');
const { Product } = require('../products/models');
function toNum(x) {
  if (x == null) return null;
  const n = Number(x);
  return Number.isNaN(n) ? null : n;
}

function pickTierForQty(tierRows, quantity) {
  const qty = Math.max(1, Math.floor(Number(quantity) || 1));
  const sorted = [...tierRows].sort((a, b) => Number(a.moq_min) - Number(b.moq_min));
  let chosen = null;
  for (const t of sorted) {
    const min = Number(t.moq_min) || 0;
    const max = t.moq_max != null ? Number(t.moq_max) : null;
    if (qty >= min && (max == null || !Number.isFinite(max) || qty <= max)) {
      chosen = t;
    }
  }
  return chosen;
}

async function findCanonicalItemsListForProduct(productId) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const listRows = await ItemsList.findAll({
    where: { type: 'PR', product_id: pid },
    order: [['id', 'ASC']],
  });
  if (!listRows.length) return null;
  const partyWhere = clientRatesPartyWhere();
  if (listRows.length === 1) {
    const r = listRows[0];
    return r.get ? r.get({ plain: true }) : r;
  }
  let best = listRows[0];
  let bestCount = -1;
  for (const row of listRows) {
    const n = await ItemListVendorRate.count({
      where: { items_list_id: row.id, ...partyWhere },
    });
    if (n > bestCount || (n === bestCount && row.id < best.id)) {
      best = row;
      bestCount = n;
    }
  }
  return best.get ? best.get({ plain: true }) : best;
}

/**
 * @param {{ productId: number, clientId: number, quantity?: number }} params
 */
async function resolveClientProductPrice({ productId, clientId, quantity = 1 }) {
  const pid = Number(productId);
  const cid = Number(clientId);
  const qty = Math.max(1, Math.floor(Number(quantity) || 1));

  const product = await Product.findByPk(pid, {
    attributes: ['product_id', 'product_code', 'product_name', 'mrp_price'],
  });
  const mrpReference = product && product.mrp_price != null ? toNum(product.mrp_price) : null;

  if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(cid) || cid <= 0) {
    return {
      product_id: pid,
      client_id: cid,
      quantity: qty,
      price_per_unit: mrpReference,
      currency: 'INR',
      payment_terms: null,
      staged_payment_terms: null,
      source: mrpReference != null && mrpReference > 0 ? 'mrp_reference' : 'none',
      items_list_id: null,
      rate_id: null,
      tier_id: null,
      moq_min: null,
      moq_max: null,
    };
  }

  const listRow = await findCanonicalItemsListForProduct(pid);
  if (!listRow) {
    return {
      product_id: pid,
      client_id: cid,
      quantity: qty,
      price_per_unit: mrpReference,
      currency: 'INR',
      payment_terms: null,
      staged_payment_terms: null,
      source: mrpReference != null && mrpReference > 0 ? 'mrp_reference' : 'none',
      items_list_id: null,
      rate_id: null,
      tier_id: null,
      moq_min: null,
      moq_max: null,
      message:
        mrpReference != null && mrpReference > 0
          ? 'No client price list — using MRP reference from product master.'
          : 'No client price list for this product. Add client tiers in Items List.',
    };
  }

  const rate = await ItemListVendorRate.findOne({
    where: {
      items_list_id: listRow.id,
      vendor_id: cid,
      ...clientRatesPartyWhere(),
    },
    order: [['id', 'ASC']],
  });

  if (!rate) {
    return {
      product_id: pid,
      client_id: cid,
      quantity: qty,
      price_per_unit: mrpReference,
      currency: 'INR',
      payment_terms: null,
      staged_payment_terms: null,
      source: mrpReference != null && mrpReference > 0 ? 'mrp_reference' : 'none',
      items_list_id: listRow.id,
      rate_id: null,
      tier_id: null,
      moq_min: null,
      moq_max: null,
      message:
        mrpReference != null && mrpReference > 0
          ? 'No client rate on price list — using MRP reference from product master.'
          : 'No client rate for this product. Add client pricing in Items List (Products tab).',
    };
  }

  const ratePlain = rate.get ? rate.get({ plain: true }) : rate;
  const tiers = await ItemListTier.findAll({
    where: { item_list_vendor_rate_id: ratePlain.id },
    order: [['moq_min', 'ASC']],
  });
  const tierPlain = tiers.map((t) => (t.get ? t.get({ plain: true }) : t));
  const tier = pickTierForQty(tierPlain, qty);
  const lowestMoq =
    tierPlain.length > 0
      ? tierPlain.reduce((min, t) => {
          const m = Number(t.moq_min) || 0;
          return min == null || m < min ? m : min;
        }, null)
      : null;

  let price = null;
  let tierId = null;
  let moqMin = null;
  let moqMax = null;
  let source = 'none';
  let message = null;

  if (tier) {
    price = toNum(tier.price_per_unit);
    tierId = tier.id;
    moqMin = tier.moq_min;
    moqMax = tier.moq_max;
    source = 'client_price_list_tier';
    message = `Price from client price list (MOQ tier from ${moqMin}${moqMax != null ? `–${moqMax}` : '+'})`;
  } else if (tierPlain.length > 0) {
    source = 'no_tier_match';
    message =
      lowestMoq != null
        ? `Quantity ${qty} is below the lowest MOQ tier (${lowestMoq}). Enter unit price manually; it will be added to the client price list when the sale order is created.`
        : 'No matching MOQ tier for this quantity. Enter unit price manually.';
  } else if (ratePlain.default_rate != null) {
    price = toNum(ratePlain.default_rate);
    source = 'client_price_list_rate';
    message = 'Price from client price list default rate.';
  }

  if ((price == null || price <= 0) && source !== 'no_tier_match') {
    price = mrpReference;
    if (source === 'none' || source === 'client_price_list_rate') {
      source = mrpReference != null && mrpReference > 0 ? 'mrp_reference' : 'none';
      if (!message) {
        message =
          mrpReference != null && mrpReference > 0
            ? 'No MOQ tiers on client rate — using MRP reference from product master.'
            : 'No MOQ tiers on client rate. Enter unit price manually or add tiers in Items List.';
      }
    }
  }

  const staged = parseStagedPaymentTerms(ratePlain.payment_terms);

  return {
    product_id: pid,
    client_id: cid,
    quantity: qty,
    price_per_unit: price != null && price > 0 ? price : null,
    currency: ratePlain.currency || 'INR',
    payment_terms: ratePlain.payment_terms || null,
    staged_payment_terms: staged,
    source,
    items_list_id: listRow.id,
    rate_id: ratePlain.id,
    tier_id: tierId,
    moq_min: moqMin,
    moq_max: moqMax,
    lowest_moq: lowestMoq,
    message,
  };
}

/**
 * When a sale order line uses a manual price below existing MOQ tiers, persist a new tier
 * (moq_min = ordered qty) on the client's PR price list.
 */
async function syncClientPriceTierFromSaleOrder({ productId, clientId, quantity, pricePerUnit }) {
  const pid = Number(productId);
  const cid = Number(clientId);
  const qty = parseMoqQuantity(quantity);
  const price = toNum(pricePerUnit);
  if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(cid) || cid <= 0) return null;
  if (qty == null || qty <= 0 || price == null || price <= 0) return null;

  let listRow = await findCanonicalItemsListForProduct(pid);
  if (!listRow) {
    const created = await ItemsList.create({
      type: 'PR',
      raw_material_id: null,
      pack_material_id: null,
      product_id: pid,
      status: 'Active',
    });
    listRow = created.get ? created.get({ plain: true }) : created;
  }

  const partyWhere = clientRatesPartyWhere();
  let rateRow = await ItemListVendorRate.findOne({
    where: { items_list_id: listRow.id, vendor_id: cid, ...partyWhere },
    order: [['id', 'ASC']],
  });
  if (!rateRow) {
    rateRow = await ItemListVendorRate.create({
      items_list_id: listRow.id,
      vendor_id: cid,
      party_type: 'client',
      default_rate: null,
      default_moq: null,
      currency: 'INR',
      payment_terms: null,
      status: 'active',
    });
  }

  const ratePlain = rateRow.get ? rateRow.get({ plain: true }) : rateRow;
  const tiersForRate = await ItemListTier.findAll({
    where: { item_list_vendor_rate_id: ratePlain.id },
    order: [['moq_min', 'ASC']],
  });
  const existingTier = tiersForRate.find((tier) => moqValuesEqual(tier.moq_min, qty)) ?? null;
  if (existingTier) {
    await existingTier.update({ price_per_unit: price });
    return { tier_id: existingTier.id, created: false, updated: true };
  }

  const createdTier = await ItemListTier.create({
    item_list_vendor_rate_id: ratePlain.id,
    moq_min: qty,
    moq_max: null,
    price_per_unit: price,
    valid_till: null,
    note: 'Synced from Sale Order',
  });
  return { tier_id: createdTier.id, created: true, updated: false };
}

module.exports = {
  resolveClientProductPrice,
  pickTierForQty,
  syncClientPriceTierFromSaleOrder,
};

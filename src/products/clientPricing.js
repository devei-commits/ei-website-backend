/**
 * Attach Items List client rates to product payloads for the website catalog.
 */
const VendorClient = require('../vendorClient/models');
const { resolveClientProductPrice } = require('../itemsList/resolveClientProductPrice');

function parsePositiveInt(v) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Client id from ?vendor_client_id= or logged-in portal user's linked vendor_clients row.
 */
async function resolveWebsiteClientId(req) {
  const fromQuery = req.query?.vendor_client_id;
  if (fromQuery != null && String(fromQuery).trim() !== '') {
    const id = parsePositiveInt(fromQuery);
    if (!id) return null;
    const row = await VendorClient.findByPk(id, { attributes: ['id', 'type'] });
    if (!row) return null;
    const plain = row.get ? row.get({ plain: true }) : row;
    if (String(plain.type || '').toLowerCase() !== 'client') return null;
    return plain.id;
  }

  const userId = req.user?.id ?? req.user?.userid;
  if (!userId) return null;

  const linked = await VendorClient.findOne({
    where: { user_id: userId, type: 'client' },
    attributes: ['id'],
    order: [['id', 'ASC']],
  });
  return linked ? linked.id : null;
}

function isClientListPriceSource(source) {
  return source === 'client_price_list_tier' || source === 'client_price_list_rate';
}

/**
 * @param {Record<string, unknown>} plain - product row (plain object)
 */
async function attachClientPricingToProduct(plain, clientId, quantity = 1) {
  if (!clientId || !plain?.product_id) return plain;

  const resolved = await resolveClientProductPrice({
    productId: plain.product_id,
    clientId,
    quantity,
  });

  const clientPrice =
    resolved.price_per_unit != null && Number(resolved.price_per_unit) > 0
      ? Number(resolved.price_per_unit)
      : null;

  const fromList = isClientListPriceSource(resolved.source);

  if (clientPrice != null && fromList) {
    return {
      ...plain,
      buy_price: clientPrice,
      client_price: clientPrice,
      has_client_price: true,
      price_source: resolved.source,
      client_payment_terms: resolved.payment_terms ?? null,
      staged_payment_terms: resolved.staged_payment_terms ?? null,
    };
  }

  return {
    ...plain,
    has_client_price: false,
    price_source: resolved.source,
  };
}

async function attachClientPricingToProducts(products, clientId, quantity = 1) {
  if (!clientId || !products?.length) return products;
  return Promise.all(products.map((p) => attachClientPricingToProduct(p, clientId, quantity)));
}

module.exports = {
  resolveWebsiteClientId,
  attachClientPricingToProduct,
  attachClientPricingToProducts,
  isClientListPriceSource,
};

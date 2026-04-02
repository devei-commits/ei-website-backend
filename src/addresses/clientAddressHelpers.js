const { Op } = require('sequelize');
const Address = require('../models/Addresses');

function pickAddressOfType(list, type) {
  const defKey = type === 'shipping' ? 'is_default_shipping' : 'is_default_billing';
  const sameType = list.filter((a) => String(a.address_type || '').toLowerCase() === type);
  if (sameType.length === 0) return null;
  const def = sameType.find((a) => a[defKey] === true);
  return def || sameType[0] || null;
}

/**
 * City / state / country from default shipping row (fallback: billing) for linked portal users.
 * @param {number[]} userIds
 * @returns {Promise<Map<number, { city: string; state: string; country: string }>>}
 */
async function loadAddressCityStateCountryByUserIds(userIds) {
  const ids = [...new Set((userIds || []).filter((id) => id != null && !Number.isNaN(Number(id))))].map(Number);
  const out = new Map();
  if (ids.length === 0) return out;

  const rows = await Address.findAll({
    where: { user_id: { [Op.in]: ids } },
    order: [['address_id', 'ASC']],
  });

  const byUser = new Map();
  for (const r of rows) {
    const uid = r.user_id;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(r);
  }

  for (const uid of ids) {
    const list = byUser.get(uid) || [];
    let row = pickAddressOfType(list, 'shipping');
    if (!row) row = pickAddressOfType(list, 'billing');
    if (!row) {
      out.set(uid, { city: '', state: '', country: '' });
      continue;
    }
    const d = row.get ? row.get({ plain: true }) : row;
    out.set(uid, {
      city: d.city_text != null ? String(d.city_text).trim() : '',
      state: d.state_text != null ? String(d.state_text).trim() : '',
      country: d.country_text != null ? String(d.country_text).trim() : '',
    });
  }

  return out;
}

/**
 * Single printable block for SO modal / fulfillment (matches legacy string fields).
 */
function formatAddressRowPlain(row) {
  if (!row) return '';
  const d = row.get ? row.get({ plain: true }) : row;
  const name = [d.first_name, d.last_name].filter(Boolean).join(' ').trim();
  const lines = [
    name || null,
    d.address_line1,
    d.address_line2,
    d.landmark,
    [d.city_text, d.state_text, d.pincode].filter(Boolean).join(', ') || null,
    d.country_text,
  ].filter(Boolean);
  return lines.join('\n').trim();
}

/**
 * @param {number[]} userIds
 * @returns {Promise<Map<number, { shipping: string; billing: string }>>}
 */
async function loadShippingBillingByUserIds(userIds) {
  const ids = [...new Set((userIds || []).filter((id) => id != null && !Number.isNaN(Number(id))))].map(Number);
  const out = new Map();
  if (ids.length === 0) return out;

  const rows = await Address.findAll({
    where: { user_id: { [Op.in]: ids } },
    order: [['address_id', 'ASC']],
  });

  const byUser = new Map();
  for (const r of rows) {
    const uid = r.user_id;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(r);
  }

  for (const uid of ids) {
    const list = byUser.get(uid) || [];
    const ship = pickAddressOfType(list, 'shipping');
    const bill = pickAddressOfType(list, 'billing');
    out.set(uid, {
      shipping: formatAddressRowPlain(ship),
      billing: formatAddressRowPlain(bill),
    });
  }

  return out;
}

/**
 * Keep `addresses` in sync when Client Master saves `data.shipping_address` / `data.billing_address` strings.
 * Updates the first row per type for this user (same pattern as seed: one default shipping + one default billing).
 */
async function syncClientAddressesFromVendorData(userId, data, transaction) {
  if (userId == null || !data || typeof data !== 'object') return;
  const ship = String(data.shipping_address ?? data.shippingAddress ?? '').trim();
  const bill = String(data.billing_address ?? data.billingAddress ?? '').trim();
  if (!ship && !bill) return;

  const opts = transaction ? { transaction } : {};

  async function upsertType(addressType, line1, isShip) {
    if (!line1) return;
    const defKey = isShip ? 'is_default_shipping' : 'is_default_billing';
    const where = { user_id: userId, address_type: addressType };
    let row = await Address.findOne({
      where,
      order: [[defKey, 'DESC'], ['address_id', 'ASC']],
      ...opts,
    });
    const payload = {
      address_line1: line1,
      address_type: addressType,
      [defKey]: true,
    };
    if (row) {
      await row.update(payload, opts);
    } else {
      await Address.create(
        {
          user_id: userId,
          ...payload,
        },
        opts
      );
    }
  }

  await upsertType('shipping', ship, true);
  await upsertType('billing', bill, false);
}

module.exports = {
  formatAddressRowPlain,
  loadShippingBillingByUserIds,
  loadAddressCityStateCountryByUserIds,
  syncClientAddressesFromVendorData,
};

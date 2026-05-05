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
  function normalizeZohoAddressObject(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const attention = String(obj.attention || '').trim();
    const nameParts = attention.split(/\s+/).filter(Boolean);
    const line1 = String(obj.address || obj.street || '').trim();
    const line2 = String(obj.street2 || obj.address_line2 || '').trim();
    const city = String(obj.city || '').trim();
    const state = String(obj.state || '').trim();
    const country = String(obj.country || '').trim();
    const zip = String(obj.zip || obj.pincode || '').trim();
    const phone = String(obj.phone || '').trim();
    const fallbackSingleLine = [line1, line2, city, state, zip, country].filter(Boolean).join(', ').trim();
    return {
      first_name: nameParts[0] || null,
      last_name: nameParts.slice(1).join(' ').trim() || null,
      address_line1: line1 || fallbackSingleLine || null,
      address_line2: line2 || null,
      city_text: city || null,
      state_text: state || null,
      country_text: country || null,
      pincode: zip || null,
      phone: phone || null,
    };
  }

  function parseAddressFromUnknown(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') {
      return normalizeZohoAddressObject(raw);
    }
    const text = String(raw).trim();
    if (!text) return null;
    return {
      first_name: null,
      last_name: null,
      address_line1: text,
      address_line2: null,
      city_text: null,
      state_text: null,
      country_text: null,
      pincode: null,
      phone: null,
    };
  }

  const shipParsed = parseAddressFromUnknown(
    data.shipping_address_object ??
      data.shippingAddressObject ??
      data.shipping_address ??
      data.shippingAddress
  );
  const billParsed = parseAddressFromUnknown(
    data.billing_address_object ??
      data.billingAddressObject ??
      data.billing_address ??
      data.billingAddress
  );
  if (!shipParsed && !billParsed) return;

  const opts = transaction ? { transaction } : {};

  async function upsertType(addressType, parsed, isShip) {
    if (!parsed || !parsed.address_line1) return;
    const defKey = isShip ? 'is_default_shipping' : 'is_default_billing';
    const where = { user_id: userId, address_type: addressType };
    let row = await Address.findOne({
      where,
      order: [[defKey, 'DESC'], ['address_id', 'ASC']],
      ...opts,
    });
    const payload = {
      first_name: parsed.first_name,
      last_name: parsed.last_name,
      address_line1: parsed.address_line1,
      address_line2: parsed.address_line2,
      city_text: parsed.city_text,
      state_text: parsed.state_text,
      country_text: parsed.country_text,
      pincode: parsed.pincode,
      phone: parsed.phone,
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

  await upsertType('shipping', shipParsed, true);
  await upsertType('billing', billParsed, false);
}

module.exports = {
  formatAddressRowPlain,
  loadShippingBillingByUserIds,
  loadAddressCityStateCountryByUserIds,
  syncClientAddressesFromVendorData,
};

/**
 * Keeps Items List price-list tables in sync with Vendor Master → data.vendorItems.
 * Resolves RM/PM by item code, ensures items_list row exists, upserts item_list_vendor_rates + item_list_tiers.
 */
const { Op } = require('sequelize');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { ItemsList, ItemListVendorRate, ItemListTier } = require('../itemsList/models');
const { vendorRatesPartyWhere } = require('../itemsList/partyTypeWhere');

function normType(t) {
  const s = String(t || '')
    .trim()
    .toUpperCase();
  if (s === 'RM' || s === 'RAW' || s === 'RAW MATERIAL') return 'RM';
  if (s === 'PM' || s === 'PACK' || s === 'PACKAGING') return 'PM';
  return null;
}

function normCode(c) {
  return String(c || '')
    .trim();
}

function toNum(x) {
  if (x == null || x === '') return null;
  const n = Number(x);
  return Number.isNaN(n) ? null : n;
}

/**
 * Find RM or PM master row by code (exact, then case-insensitive).
 */
async function findMasterRow(itemType, code, transaction) {
  const c = normCode(code);
  if (!c) return null;
  if (itemType === 'RM') {
    let rm = await RawMaterial.findOne({ where: { code: c }, transaction });
    if (!rm) {
      rm = await RawMaterial.findOne({
        where: { code: { [Op.iLike]: c } },
        transaction,
      });
    }
    return rm ? { kind: 'RM', id: rm.id, row: rm } : null;
  }
  if (itemType === 'PM') {
    let pm = await PackMaterial.findOne({ where: { code: c }, transaction });
    if (!pm) {
      pm = await PackMaterial.findOne({
        where: { code: { [Op.iLike]: c } },
        transaction,
      });
    }
    return pm ? { kind: 'PM', id: pm.id, row: pm } : null;
  }
  return null;
}

async function findOrCreateItemsListRow(kind, masterId, transaction) {
  const where =
    kind === 'RM'
      ? { type: 'RM', raw_material_id: masterId }
      : { type: 'PM', pack_material_id: masterId };
  let listRow = await ItemsList.findOne({ where, transaction });
  if (!listRow) {
    listRow = await ItemsList.create(
      {
        type: kind,
        raw_material_id: kind === 'RM' ? masterId : null,
        pack_material_id: kind === 'PM' ? masterId : null,
        product_id: null,
        status: 'Active',
      },
      { transaction }
    );
  }
  return listRow;
}

async function removeVendorRateForItem(vendorId, itemsListId, transaction) {
  const rates = await ItemListVendorRate.findAll({
    where: { vendor_id: vendorId, items_list_id: itemsListId, ...vendorRatesPartyWhere() },
    transaction,
  });
  for (const r of rates) {
    await ItemListTier.destroy({ where: { item_list_vendor_rate_id: r.id }, transaction });
    await r.destroy({ transaction });
  }
}

/**
 * Upsert one vendor line: rate + single MOQ tier (vendor form is one row per price band).
 */
async function upsertVendorRateAndTier(vendorId, itemsListId, item, transaction) {
  const price = toNum(item.unitPrice != null && item.unitPrice !== '' ? item.unitPrice : item.price);
  if (price == null) {
    throw new Error(`unit price required for item code ${normCode(item.itemCode)}`);
  }
  let moq = parseInt(String(item.moq ?? '').trim(), 10);
  if (Number.isNaN(moq) || moq < 1) moq = 1;

  let rate = await ItemListVendorRate.findOne({
    where: { items_list_id: itemsListId, vendor_id: vendorId, ...vendorRatesPartyWhere() },
    transaction,
  });

  const payTerms =
    item.paymentTermsOverride != null && String(item.paymentTermsOverride).trim()
      ? String(item.paymentTermsOverride).trim()
      : null;

  if (!rate) {
    rate = await ItemListVendorRate.create(
      {
        items_list_id: itemsListId,
        vendor_id: vendorId,
        party_type: 'vendor',
        default_rate: price,
        default_moq: moq,
        currency: 'INR',
        payment_terms: payTerms,
        status: 'active',
      },
      { transaction }
    );
  } else {
    rate.default_rate = price;
    rate.default_moq = moq;
    if (payTerms !== null) rate.payment_terms = payTerms;
    await rate.save({ transaction });
  }

  await ItemListTier.destroy({ where: { item_list_vendor_rate_id: rate.id }, transaction });

  const noteParts = [];
  if (item.leadTime != null && String(item.leadTime).trim()) {
    noteParts.push(`Lead (days): ${String(item.leadTime).trim()}`);
  }
  if (item.itemName != null && String(item.itemName).trim()) {
    noteParts.push(`Name: ${String(item.itemName).trim()}`);
  }
  const note = noteParts.length ? noteParts.join(' · ') : null;

  await ItemListTier.create(
    {
      item_list_vendor_rate_id: rate.id,
      moq_min: moq,
      moq_max: null,
      price_per_unit: price,
      valid_till: item.priceValidTill || null,
      note,
    },
    { transaction }
  );
}

/**
 * Resolve vendorItems[] to items_list ids (for diffing removals). Skips invalid rows.
 */
async function resolveVendorItemsToItemsListIds(vendorItems, transaction) {
  const list = Array.isArray(vendorItems) ? vendorItems : [];
  const ids = [];
  for (const item of list) {
    const t = normType(item.itemType);
    if (t !== 'RM' && t !== 'PM') continue;
    const master = await findMasterRow(t, item.itemCode, transaction);
    if (!master) continue;
    const listRow = await findOrCreateItemsListRow(master.kind, master.id, transaction);
    ids.push(listRow.id);
  }
  return [...new Set(ids)];
}

/**
 * Sync vendor master lines to items_list / item_list_vendor_rates / item_list_tiers.
 * @param {object} opts
 * @param {number} opts.vendorId - vendor_clients.id
 * @param {Array} [opts.previousVendorItems] - data.vendorItems before update (for removals)
 * @param {Array} [opts.nextVendorItems] - data.vendorItems after save
 * @param {import('sequelize').Transaction} [opts.transaction]
 * @returns {Promise<{ synced: number, removed: number, skipped: Array<{ code: string, type: string, reason: string }> }>}
 */
async function syncVendorMasterItemsToPriceList({
  vendorId,
  previousVendorItems,
  nextVendorItems,
  transaction,
}) {
  const skipped = [];
  const prevIds = await resolveVendorItemsToItemsListIds(previousVendorItems, transaction);
  const prevSet = new Set(prevIds);

  const next = Array.isArray(nextVendorItems) ? nextVendorItems : [];
  const nextResolvedIds = new Set();

  let synced = 0;

  for (const item of next) {
    const t = normType(item.itemType);
    if (t !== 'RM' && t !== 'PM') {
      skipped.push({
        code: normCode(item.itemCode) || '(empty)',
        type: String(item.itemType || ''),
        reason: 'Only RM and PM lines are synced to the price list',
      });
      continue;
    }
    const code = normCode(item.itemCode);
    if (!code) {
      skipped.push({ code: '', type: t, reason: 'Item code is required' });
      continue;
    }

    const master = await findMasterRow(t, code, transaction);
    if (!master) {
      skipped.push({
        code,
        type: t,
        reason: 'No matching RM/PM master with this code',
      });
      continue;
    }

    const price = toNum(item.unitPrice != null && item.unitPrice !== '' ? item.unitPrice : item.price);
    if (price == null) {
      skipped.push({ code, type: t, reason: 'Unit price is required' });
      continue;
    }

    const listRow = await findOrCreateItemsListRow(master.kind, master.id, transaction);
    nextResolvedIds.add(listRow.id);

    await upsertVendorRateAndTier(vendorId, listRow.id, item, transaction);
    synced += 1;
  }

  let removed = 0;
  for (const id of prevSet) {
    if (!nextResolvedIds.has(id)) {
      await removeVendorRateForItem(vendorId, id, transaction);
      removed += 1;
    }
  }

  return { synced, removed, skipped };
}

/**
 * Delete all price-list rates for this vendor (used when vendor master row is deleted).
 */
async function deleteAllVendorPriceListRates(vendorId, transaction) {
  const rates = await ItemListVendorRate.findAll({
    where: { vendor_id: vendorId, ...vendorRatesPartyWhere() },
    transaction,
  });
  for (const r of rates) {
    await ItemListTier.destroy({ where: { item_list_vendor_rate_id: r.id }, transaction });
    await r.destroy({ transaction });
  }
  return rates.length;
}

module.exports = {
  syncVendorMasterItemsToPriceList,
  deleteAllVendorPriceListRates,
  normType,
  findOrCreateItemsListRow,
  upsertVendorRateAndTier,
};

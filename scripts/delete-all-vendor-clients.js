#!/usr/bin/env node
/**
 * Delete all rows in vendor_clients (vendors + clients).
 * Removes linked items-list rates/tiers and procurement quotations first.
 * Does not delete portal users; clears vendor_clients.user_id links only.
 *
 * Usage:
 *   node scripts/delete-all-vendor-clients.js --dry-run
 *   node scripts/delete-all-vendor-clients.js --yes
 */
require('dotenv').config();
require('../registerModelsForSync');

const db = require('../db');
const VendorClient = require('../src/vendorClient/models');
const ProcurementQuotation = require('../src/procurementQuotations/models');
const { ItemListVendorRate, ItemListTier } = require('../src/itemsList/models');

function assertAllowed(argv) {
  if (argv.includes('--dry-run')) return;
  const hasYes = argv.includes('--yes') || argv.includes('-y');
  const envOk = String(process.env.ALLOW_DELETE_VENDOR_CLIENTS || '').toLowerCase() === 'true';
  if (!hasYes && !envOk) {
    console.error(
      'Refusing to run: deletes all vendors and clients.\n' +
        '  Dry run:  node scripts/delete-all-vendor-clients.js --dry-run\n' +
        '  Execute:  node scripts/delete-all-vendor-clients.js --yes'
    );
    process.exit(1);
  }
}

async function countRatesForPartyIds(ids, t) {
  if (!ids.length) return 0;
  return ItemListVendorRate.count({
    where: { vendor_id: ids },
    transaction: t,
  });
}

async function deleteRatesForPartyIds(ids, t) {
  if (!ids.length) return 0;
  const rates = await ItemListVendorRate.findAll({
    where: { vendor_id: ids },
    attributes: ['id'],
    transaction: t,
  });
  const rateIds = rates.map((r) => r.id);
  if (rateIds.length) {
    await ItemListTier.destroy({
      where: { item_list_vendor_rate_id: rateIds },
      transaction: t,
    });
    await ItemListVendorRate.destroy({ where: { id: rateIds }, transaction: t });
  }
  return rateIds.length;
}

async function main() {
  const argv = process.argv.slice(2);
  assertAllowed(argv);
  const dryRun = argv.includes('--dry-run');

  const vendors = await VendorClient.findAll({
    where: { type: 'vendor' },
    attributes: ['id', 'entity_code', 'name'],
  });
  const clients = await VendorClient.findAll({
    where: { type: 'client' },
    attributes: ['id', 'entity_code', 'name'],
  });
  const allIds = [...vendors, ...clients].map((r) => r.id);

  console.log(
    dryRun
      ? `[delete-vendor-clients] DRY RUN — ${vendors.length} vendor(s), ${clients.length} client(s)\n`
      : `[delete-vendor-clients] Deleting ${vendors.length} vendor(s) and ${clients.length} client(s)…\n`
  );

  const t = await db.transaction();
  try {
    const rateCount = await countRatesForPartyIds(allIds, t);
    const quoteCount = allIds.length
      ? await ProcurementQuotation.count({ where: { vendor_id: allIds }, transaction: t })
      : 0;

    if (dryRun) {
      console.log(`  item_list_vendor_rates (+ tiers): ${rateCount}`);
      console.log(`  procurement_quotations: ${quoteCount}`);
      console.log(`  vendor_clients: ${allIds.length}`);
      await t.rollback();
      return;
    }

    const ratesDeleted = await deleteRatesForPartyIds(allIds, t);
    const quotesDeleted = allIds.length
      ? await ProcurementQuotation.destroy({ where: { vendor_id: allIds }, transaction: t })
      : 0;

    await VendorClient.update({ user_id: null }, { where: {}, transaction: t });
    const mastersDeleted = await VendorClient.destroy({ where: {}, transaction: t });

    await t.commit();

    console.log(`  item_list_vendor_rates removed: ${ratesDeleted}`);
    console.log(`  procurement_quotations removed: ${quotesDeleted}`);
    console.log(`  vendor_clients removed: ${mastersDeleted}`);
    console.log('\n[delete-vendor-clients] Done. Portal users were not deleted.');
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

main().catch((err) => {
  console.error('[delete-vendor-clients] Failed:', err);
  process.exit(1);
});

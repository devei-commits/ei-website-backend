/**
 * One-time script: create one placeholder fulfillment_batch_split per
 * fulfillment_order_item that currently has no splits at all.
 *
 * Effect on Batches Dashboard:
 *   • All 255 imported SO line items become visible (stage = PLANNING).
 *   • bpr_no / production_batch_id stay null → shows "Pending" in Batch column.
 *   • Once real production batches are created and linked, these stubs can be
 *     deleted or replaced by the production sync.
 *
 * Usage:
 *   node scripts/seed-placeholder-batch-splits.js           → live run
 *   node scripts/seed-placeholder-batch-splits.js --dry-run → preview only
 *
 * Idempotent: items that already have a split (real or stub) are skipped.
 */

require('dotenv').config();

// Remap Docker service name → localhost when running from host machine
if (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('@db:')) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace('@db:', '@127.0.0.1:');
}

const db = require('../db');
const { FulfillmentOrderItem, FulfillmentBatchSplit } = require('../src/fulfillment/models');
const { Op } = require('sequelize');

const DRY_RUN = process.argv.includes('--dry-run');
const CHUNK = 50; // insert in batches to avoid a single huge transaction

(async () => {
  try {
    await db.authenticate();
    console.log('[seed-splits] DB connected.\n');

    // 1. Load all active items
    const allItems = await FulfillmentOrderItem.findAll({
      where: { deleted_at: null },
      attributes: ['id', 'fulfillment_order_id', 'ordered_qty', 'product_name', 'sku'],
      order: [['fulfillment_order_id', 'ASC'], ['id', 'ASC']],
      raw: true,
    });

    console.log(`[seed-splits] Total items found: ${allItems.length}`);

    // 2. Find which items already have at least one split
    const existingSplitItemIds = new Set(
      (
        await FulfillmentBatchSplit.findAll({
          where: {
            fulfillment_order_item_id: { [Op.in]: allItems.map((i) => i.id) },
            deleted_at: null,
          },
          attributes: ['fulfillment_order_item_id'],
          raw: true,
        })
      ).map((s) => s.fulfillment_order_item_id)
    );

    // 3. Items that need a placeholder
    const itemsToSeed = allItems.filter((i) => !existingSplitItemIds.has(i.id));

    if (itemsToSeed.length === 0) {
      console.log('[seed-splits] All items already have splits. Nothing to do.');
      process.exit(0);
    }

    console.log(`[seed-splits] Items already with splits: ${existingSplitItemIds.size}`);
    console.log(`[seed-splits] Items needing a placeholder: ${itemsToSeed.length}\n`);

    if (DRY_RUN) {
      console.log('[seed-splits] DRY RUN — sample of what would be created:');
      itemsToSeed.slice(0, 5).forEach((i) => {
        console.log(`  order_id=${i.fulfillment_order_id}  item_id=${i.id}  product="${i.product_name}"  planned_qty=${i.ordered_qty}`);
      });
      if (itemsToSeed.length > 5) console.log(`  ... and ${itemsToSeed.length - 5} more`);
      console.log('\n[seed-splits] Remove --dry-run to apply.');
      process.exit(0);
    }

    // 4. Build payload rows
    const now = new Date();
    const rows = itemsToSeed.map((item) => ({
      fulfillment_order_id: item.fulfillment_order_id,
      fulfillment_order_item_id: item.id,
      production_batch_id: null,
      bmr_no: null,
      bpr_no: null,
      planned_qty: item.ordered_qty || 0,
      fg_qty: 0,
      picked_qty: 0,
      ff_status: 'fg_pending',
      lifecycle_status: 'active',
      created_at: now,
      updated_at: now,
    }));

    // 5. Insert in chunks
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await FulfillmentBatchSplit.bulkCreate(chunk, { validate: false });
      inserted += chunk.length;
      process.stdout.write(`\r[seed-splits] Inserted ${inserted}/${rows.length}…`);
    }

    console.log(`\n\n[seed-splits] ✓ Created ${inserted} placeholder batch splits.`);
    console.log('[seed-splits] Products & Batches dashboard will now show all SO line items (stage = PLANNING).');
    console.log('[seed-splits] These stubs will be replaced when real production batches are linked.');
  } catch (err) {
    console.error('\n[seed-splits] Error:', err?.stack ?? err);
    process.exit(1);
  } finally {
    await db.close();
  }
})();

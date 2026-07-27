/**
 * Materialize pack-inventory rows from a completed GRN's packaging list.
 *
 * Reads source_documents.packaging (per-pack) + source_documents.batches (vendor batch,
 * MFG/EXP) and the GRN's putaway location, and upserts one warehouse_packs row per pack.
 * Idempotent on packaging_no, so re-completing a GRN won't duplicate packs. Non-fatal — a
 * failure here must not roll back the GRN's inventory bucket update.
 */
const WarehousePack = require('./models');

async function applyGrnPacksToInventory(grnPlain, opts = {}) {
  const transaction = opts.transaction;
  if (!grnPlain || grnPlain.id == null) return { created: 0 };

  const sd = grnPlain.source_documents && typeof grnPlain.source_documents === 'object' ? grnPlain.source_documents : {};
  const packaging = sd.packaging && Array.isArray(sd.packaging.rows) ? sd.packaging.rows : [];
  if (packaging.length === 0) return { created: 0 };

  const batches = sd.batches && Array.isArray(sd.batches.rows) ? sd.batches.rows : [];
  const line = Array.isArray(grnPlain.line_items) && grnPlain.line_items[0] ? grnPlain.line_items[0] : {};
  const itemType =
    grnPlain.type ||
    (line.raw_material_id != null ? 'RM' : line.pack_material_id != null ? 'PM' : line.product_id != null ? 'PR' : null);
  const zone = grnPlain.location_zone || null;
  const rack = grnPlain.location_prefix || null;
  const unit = line.unit || 'KG';

  let created = 0;
  for (const p of packaging) {
    const packagingNo = String(p.packagingNo || '').trim();
    if (!packagingNo) continue;
    const batch = (Number.isInteger(p.batchIndex) && batches[p.batchIndex]) || {};
    try {
      const [, wasCreated] = await WarehousePack.findOrCreate({
        where: { packaging_no: packagingNo },
        defaults: {
          packaging_no: packagingNo,
          grn_id: grnPlain.id,
          batch_index: Number.isInteger(p.batchIndex) ? p.batchIndex : null,
          item_type: itemType,
          raw_material_id: line.raw_material_id ?? null,
          pack_material_id: line.pack_material_id ?? null,
          product_id: line.product_id ?? null,
          zone,
          rack,
          vendor_batch: batch.vendorBatchNo || null,
          mfg_date: batch.mfgDate || null,
          exp_date: batch.expDate || null,
          qty: Number(p.qty) || 0,
          unit,
          status: 'available',
        },
        transaction,
      });
      if (wasCreated) created += 1;
    } catch (e) {
      console.warn('[warehouse-packs] upsert failed for', packagingNo, e && e.message ? e.message : e);
    }
  }
  return { created };
}

module.exports = { applyGrnPacksToInventory };

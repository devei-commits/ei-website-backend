/**
 * POST /api/v1/products/formula-summary/chunk
 * Summary worksheet: PR category, sub-category, name, SKU BOM net fill, product SG.
 */

const BOM = require('../bom/models');
const {
  findOrCreateProductForFormulaBom,
  syncProductSkuCodesFromCompositeImport,
  computeProductSgFromTotalRmGm,
  mergeBomNotesPrSubCategory,
  skuBomLimitFromSummaryRow,
} = require('./formulaBomProductResolve');

/**
 * @param {Record<string, unknown>} row — FormulaSummaryParsedRow shape from client
 */
async function processSummaryRow(row) {
  const sku = String(row?.sku ?? '').trim();
  if (!sku) {
    return {
      sku: '',
      row_number: row?.row_number ?? null,
      success: false,
      error: 'missing_sku',
      product_id: null,
      bom_id: null,
    };
  }

  const productName = String(row?.product_name ?? '').trim();
  const category = String(row?.category ?? '').trim();
  const prSubCategory = String(row?.pr_sub_category ?? row?.prSubCategory ?? '').trim();

  const { product, created } = await findOrCreateProductForFormulaBom(sku, productName);
  if (!product) {
    return {
      sku,
      row_number: row?.row_number ?? null,
      success: false,
      error: 'product_not_created',
      product_id: null,
      bom_id: null,
    };
  }

  await syncProductSkuCodesFromCompositeImport(product, sku);

  const productUpdates = { updated_at: new Date() };
  if (category) productUpdates.category = category;
  if (productName) productUpdates.product_name = productName;
  await product.update(productUpdates);

  const productId = product.product_id;
  const now = new Date();

  let bom = await BOM.findOne({ where: { product_id: productId } });
  if (!bom) {
    const productCode = product.product_code ? product.product_code : `PR-${productId}`;
    bom = await BOM.create({
      bom_code: `BOM-${productCode}`,
      name: product.product_name || `Product ${productId}`,
      product_id: productId,
      type: 'FG',
      status: 'Draft',
      rm_lines: [],
      sku_rm_lines: [],
      sku_bom_limit_qty: null,
      sku_bom_limit_uom: null,
      pm_lines: [],
      process_steps: [],
      created_at: now,
      updated_at: now,
    });
  }

  const bomUpdates = { updated_at: now };
  const lim = skuBomLimitFromSummaryRow(row);
  let packSizeFormatted = null;
  if (lim) {
    const { formatSkuBomLimitAsPack } = require('../lib/skuBomPackSize');
    packSizeFormatted = formatSkuBomLimitAsPack(lim.qty, lim.uom);
    bomUpdates.sku_bom_limit_qty = lim.qty;
    bomUpdates.sku_bom_limit_uom = lim.uom;
    bomUpdates.pack_size = packSizeFormatted;
  }

  const sg = computeProductSgFromTotalRmGm(row?.total_rm_gm, row?.pack_size);
  if (sg != null) {
    bomUpdates.spec_bulk = String(sg);
  }

  if (prSubCategory || bom.notes) {
    bomUpdates.notes = mergeBomNotesPrSubCategory(bom.notes, prSubCategory);
  }

  await bom.update(bomUpdates);

  if (packSizeFormatted) {
    await product.update({ fill_size: packSizeFormatted, updated_at: now });
  }

  return {
    sku,
    row_number: row?.row_number ?? null,
    success: true,
    product_id: productId,
    bom_id: bom.id,
    product_created: created,
    specific_gravity: sg,
    pack_size: packSizeFormatted,
    category: category || null,
    pr_sub_category: prSubCategory || null,
  };
}

/**
 * POST JSON body: { chunk_index, chunk_total, rows: FormulaSummaryParsedRow[] }
 */
async function processFormulaSummaryChunk(req, res) {
  try {
    const chunkIndex = req.body?.chunk_index;
    const chunkTotal = req.body?.chunk_total;
    const rows = req.body?.rows;

    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: 'Body must include rows: FormulaSummaryParsedRow[]' });
    }

    const results = [];
    const errors = [];

    for (const row of rows) {
      const sku = String(row?.sku ?? '').trim();
      try {
        const r = await processSummaryRow(row);
        results.push(r);
        if (!r.success) {
          errors.push({ sku: sku || '(empty)', error: r.error || 'update_failed', row_number: r.row_number });
        }
      } catch (e) {
        console.error('formulaSummary chunk row error', sku, e);
        errors.push({ sku: sku || '(empty)', error: e.message || 'update_failed', row_number: row?.row_number });
        results.push({
          sku,
          row_number: row?.row_number ?? null,
          success: false,
          error: e.message || 'update_failed',
          product_id: null,
          bom_id: null,
        });
      }
    }

    const okCount = results.filter((r) => r.success).length;
    return res.status(200).json({
      success: true,
      chunk_index: chunkIndex ?? null,
      chunk_total: chunkTotal ?? null,
      rows_in_chunk: results.length,
      rows_ok: okCount,
      results,
      errors,
    });
  } catch (err) {
    console.error('processFormulaSummaryChunk error', err);
    return res.status(500).json({ error: err.message || 'Failed to import Summary chunk' });
  }
}

module.exports = {
  processSummaryRow,
  processFormulaSummaryChunk,
};

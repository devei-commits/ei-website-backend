/**
 * Bulk SIH updates from internal warehouse workbooks (sku, item_name, SIH).
 * - Main warehouse: worksheet "CONSOLIDATED SIH" (columns ITEM CODE, ITEM NAME, SIH) → wh_stock
 * - ML1: worksheet "Inventory Summary", column quantity_available (sku, item_name also used) → ml1_stock
 *   (legacy: worksheet "STOCK IN HAND", column PHYSICAL QTY — still supported as a fallback)
 * - ML2: worksheet "Inventory Summary", column quantity_available (sku, item_name also used) → ml2_stock
 *   (legacy: worksheet "Sheet3" — still supported as a fallback)
 */
const ExcelJS = require('exceljs');
const multer = require('multer');
const { Op } = require('sequelize');
const WarehouseInventory = require('./models');
const { logLocationMovement } = require('./locationHistoryHelpers');
const { computeStockInHand } = require('./inventoryMath');
const {
  resolveInventoryMaster,
  masterCode,
  masterSourceId,
  masterWhUnit,
} = require('../products/inventoryMasterLookup');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { Product } = require('../products/models');
const redis = require('../cache/redis');
const { reconcileRackStockToTarget } = require('./allocateUnallocatedStock');

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_DATA_ROWS = 50000;
const CHUNK_SIZE = 200;
const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

const BUCKET_CONFIG = {
  warehouse: {
    label: 'Main warehouse',
    sheetRule: 'consolidated_sih_sheet',
    sheetRule: 'consolidated_sih_sheet',
    stockField: 'wh_stock',
    auditSource: 'warehouse_sih_excel_wh',
  },
  ml1: {
    label: 'ML1',
    sheetRule: 'inventory_summary_sheet',
    stockField: 'ml1_stock',
    auditSource: 'warehouse_sih_excel_ml1',
  },
  ml2: {
    label: 'ML2',
    sheetRule: 'inventory_summary_sheet',
    stockField: 'ml2_stock',
    auditSource: 'warehouse_sih_excel_ml2',
  },
};

const HEADER_ALIASES = {
  sku: ['sku', 'item sku', 'sku code', 'item code', 'zoho sku'],
  itemName: ['item_name', 'item name', 'name', 'description', 'item description'],
  sih: [
    'sih',
    'stock in hand',
    'stock_in_hand',
    'stock in hand qty',
    'qty',
    'quantity',
    'on hand',
    'on_hand',
    'available',
    'available qty',
  ],
  /** ML1 / ML2 workbook: stock column on the "Inventory Summary" sheet */
  quantityAvailable: ['quantity_available', 'quantity available', 'qty available', 'qty_available', 'available_quantity'],
  /** ML1 legacy workbook: stock column on STOCK IN HAND sheet */
  physicalQty: ['physical qty', 'physical_qty', 'physical quantity', 'physical qty.'],
};

function cellToText(cell) {
  if (cell == null) return '';
  const v = cell.value;
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (v.richText && Array.isArray(v.richText)) return v.richText.map((r) => r.text || '').join('').trim();
  if (v.text) return String(v.text).trim();
  if (v.result != null) return String(v.result).trim();
  return String(v).trim();
}

function normHeader(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function matchHeaderAlias(cellText, aliases) {
  const h = normHeader(cellText);
  return aliases.some((a) => h === a || h.replace(/_/g, ' ') === a.replace(/_/g, ' '));
}

function parseQuantity(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function findWorksheetForBucket(workbook, bucketKey) {
  if (!workbook?.worksheets?.length) return null;
  const rule = BUCKET_CONFIG[bucketKey]?.sheetRule;
  if (rule === 'consolidated_sih_sheet') {
    for (const ws of workbook.worksheets) {
      const n = String(ws.name || '').trim();
      const lower = n.toLowerCase();
      if (lower === 'consolidated sih' || lower === 'consolidated_sih') return ws;
    }
    for (const ws of workbook.worksheets) {
      const n = String(ws.name || '')
        .trim()
        .toLowerCase();
      if (n.includes('consolidated sih') || n.includes('consolidated_sih')) return ws;
    }
    return workbook.worksheets[0];
  }
  if (rule === 'inventory_summary_sheet') {
    for (const ws of workbook.worksheets) {
      const n = String(ws.name || '').trim();
      const lower = n.toLowerCase();
      if (lower === 'inventory summary' || lower === 'inventory_summary') return ws;
    }
    for (const ws of workbook.worksheets) {
      const n = String(ws.name || '')
        .trim()
        .toLowerCase();
      if (n.includes('inventory summary') || n.includes('inventory_summary')) return ws;
    }
    // Legacy workbook formats — still supported as a fallback.
    if (bucketKey === 'ml1') {
      for (const ws of workbook.worksheets) {
        const n = String(ws.name || '').trim();
        const lower = n.toLowerCase();
        if (lower === 'stock in hand' || lower === 'stock_in_hand') return ws;
      }
      for (const ws of workbook.worksheets) {
        const n = String(ws.name || '')
          .trim()
          .toLowerCase();
        if (n.includes('stock in hand') || n.includes('stock_in_hand')) return ws;
      }
    }
    if (bucketKey === 'ml2') {
      for (const ws of workbook.worksheets) {
        const n = String(ws.name || '')
          .trim()
          .toLowerCase();
        if (n === 'sheet3' || n === 'sheet 3') return ws;
      }
    }
    return workbook.worksheets[0];
  }
  return workbook.worksheets[0];
}

function resolveQtyColumnIndex(headerTexts, bucketKey) {
  const usesInventorySummary = bucketKey === 'ml1' || bucketKey === 'ml2';
  const isMl1 = bucketKey === 'ml1';
  let quantityAvailableCol = null;
  let physicalCol = null;
  let sihCol = null;
  for (let c = 0; c < headerTexts.length; c += 1) {
    const text = headerTexts[c];
    if (!text) continue;
    if (usesInventorySummary && !quantityAvailableCol && matchHeaderAlias(text, HEADER_ALIASES.quantityAvailable)) {
      quantityAvailableCol = c + 1;
      continue;
    }
    if (isMl1 && !physicalCol && matchHeaderAlias(text, HEADER_ALIASES.physicalQty)) {
      physicalCol = c + 1;
      continue;
    }
    if (!sihCol && matchHeaderAlias(text, HEADER_ALIASES.sih)) sihCol = c + 1;
  }
  if (usesInventorySummary) return quantityAvailableCol ?? physicalCol ?? sihCol;
  return sihCol;
}

function detectSihHeaderColumns(worksheet, bucketKey) {
  for (let headerRowNum = 1; headerRowNum <= 8; headerRowNum += 1) {
    const row = worksheet.getRow(headerRowNum);
    const cols = {};
    const colCount = Math.max(row.cellCount || 0, 30);
    const headerTexts = [];
    for (let c = 1; c <= colCount; c += 1) {
      const text = cellToText(row.getCell(c));
      headerTexts.push(text);
      if (!text) continue;
      if (!cols.sku && matchHeaderAlias(text, HEADER_ALIASES.sku)) cols.sku = c;
      else if (!cols.itemName && matchHeaderAlias(text, HEADER_ALIASES.itemName)) cols.itemName = c;
    }
    const qtyCol = resolveQtyColumnIndex(headerTexts, bucketKey);
    if (qtyCol != null) cols.sih = qtyCol;
    if (cols.sih != null && (cols.sku != null || cols.itemName != null)) {
      return {
        headerRowNum,
        dataStartRow: headerRowNum + 1,
        cols,
        qtyColumn: bucketKey === 'ml1' || bucketKey === 'ml2' ? 'quantity_available' : 'sih',
      };
    }
  }
  return null;
}

/**
 * @param {Buffer} buffer
 * @param {'warehouse'|'ml1'|'ml2'} bucketKey
 */
async function parseSihBucketWorkbook(buffer, bucketKey) {
  const cfg = BUCKET_CONFIG[bucketKey];
  if (!cfg) throw new Error(`Unknown bucket: ${bucketKey}`);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = findWorksheetForBucket(workbook, bucketKey);
  if (!worksheet) {
    throw new Error('Workbook has no worksheets');
  }

  const layout = detectSihHeaderColumns(worksheet, bucketKey);
  if (!layout) {
    const qtyHint =
      bucketKey === 'ml1' || bucketKey === 'ml2'
        ? 'quantity_available (on Inventory Summary sheet)'
        : 'SIH / stock in hand';
    throw new Error(
      `Could not find headers on "${worksheet.name}". Expected columns: sku (or item_name) and ${qtyHint}.`
    );
  }

  const rows = [];
  const lastRow = worksheet.rowCount || layout.dataStartRow;
  for (let r = layout.dataStartRow; r <= lastRow; r += 1) {
    const row = worksheet.getRow(r);
    const sku = layout.cols.sku ? cellToText(row.getCell(layout.cols.sku)) : '';
    const itemName = layout.cols.itemName ? cellToText(row.getCell(layout.cols.itemName)) : '';
    const sihRaw = cellToText(row.getCell(layout.cols.sih));
    if (!sku && !itemName && !sihRaw) continue;
    rows.push({
      excel_row: r,
      sku,
      item_name: itemName,
      sih: parseQuantity(sihRaw),
    });
  }

  return { rows, sheetName: worksheet.name, bucket: bucketKey, label: cfg.label };
}

function toNum(x) {
  if (x == null) return 0;
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

function inventoryAuditSnapshot(wh) {
  const w = wh?.get ? wh.get({ plain: true }) : wh;
  const whStock = toNum(w.wh_stock);
  const ml1 = toNum(w.ml1_stock);
  const ml2 = toNum(w.ml2_stock);
  return {
    wh_stock: whStock,
    ml1_stock: ml1,
    ml2_stock: ml2,
    stock_in_hand: whStock + ml1 + ml2,
    reserved: toNum(w.reserved),
    in_transit: toNum(w.in_transit),
    zone: w.zone != null ? String(w.zone) : '',
    rack: w.rack != null ? String(w.rack) : '',
    qc_status: w.qc_status != null ? String(w.qc_status) : '',
    wh_unit: w.wh_unit != null ? String(w.wh_unit) : '',
    reorder_pt: toNum(w.reorder_pt),
    avg_mo: toNum(w.avg_mo),
    batch_number: w.batch_number != null ? String(w.batch_number) : '',
    expiry_date: w.expiry_date != null ? String(w.expiry_date).slice(0, 10) : '',
  };
}

function deriveQcStatusAfterStock(qty, reorderPt, previousQc) {
  const q = toNum(qty);
  const rp = toNum(reorderPt);
  const prev = String(previousQc || 'In Stock').trim();
  if (q <= 0) return 'Out of Stock';
  if (prev === 'Out of Stock') return 'In Stock';
  if (rp > 0) {
    if (q < rp * 0.5) return 'Critical';
    if (q < rp) return 'Low Stock';
  }
  if (prev === 'Critical' || prev === 'Low Stock') return 'In Stock';
  return prev || 'In Stock';
}

async function findOrCreateWarehouseRow(kind, masterRow) {
  const sourceId = masterSourceId(kind, masterRow);
  const whUnit = masterWhUnit(kind, masterRow);
  const defaults = {
    wh_stock: 0,
    wh_unit: whUnit,
    ml1_stock: 0,
    ml2_stock: 0,
    stock_in_hand: 0,
    reserved: 0,
    in_transit: 0,
    reorder_pt: 0,
    avg_mo: 0,
    qc_status: 'Out of Stock',
  };

  if (kind === 'RM') {
    const [row] = await WarehouseInventory.findOrCreate({
      where: { item_type: 'RM', raw_material_id: sourceId },
      defaults: { item_type: 'RM', raw_material_id: sourceId, ...defaults },
    });
    return row;
  }
  if (kind === 'PM') {
    const [row] = await WarehouseInventory.findOrCreate({
      where: { item_type: 'PM', pack_material_id: sourceId },
      defaults: { item_type: 'PM', pack_material_id: sourceId, ...defaults },
    });
    return row;
  }
  const [row] = await WarehouseInventory.findOrCreate({
    where: { item_type: 'PR', product_id: sourceId },
    defaults: { item_type: 'PR', product_id: sourceId, ...defaults },
  });
  return row;
}

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

async function findAllMastersByItemName(itemName) {
  const t = String(itemName || '').trim();
  if (!t) return [];
  const [rm, pm, pr] = await Promise.all([
    RawMaterial.findOne({ where: { name: { [Op.iLike]: t } } }),
    PackMaterial.findOne({ where: { description: { [Op.iLike]: t } } }),
    PackMaterial.findOne({ where: { description: { [Op.iLike]: t } } }),
    Product.findOne({ where: { product_name: { [Op.iLike]: t } } }),
  ]);
  const out = [];
  if (rm) out.push({ kind: 'RM', row: plain(rm) });
  if (pm) out.push({ kind: 'PM', row: plain(pm) });
  if (pr) out.push({ kind: 'PR', row: plain(pr) });
  return out;
}

async function resolveMasterFromSihRow(row) {
  const resolved = await resolveInventoryMaster({ zohoItemId: '', sku: row.sku });
  if (resolved && !resolved.ambiguous) return resolved;
  if (resolved?.ambiguous) return resolved;

  const byName = await findAllMastersByItemName(row.item_name);
  if (byName.length === 1) return { ...byName[0], matchBy: 'item_name' };
  if (byName.length > 1) return { ambiguous: byName, matchBy: 'item_name' };
  return null;
}

function buildBucketUpdates(bucketKey, qty, beforeSnap) {
  const wh = toNum(beforeSnap.wh_stock);
  const ml1 = toNum(beforeSnap.ml1_stock);
  const ml2 = toNum(beforeSnap.ml2_stock);
  const cfg = BUCKET_CONFIG[bucketKey];
  const updates = {};
  if (cfg.stockField === 'wh_stock') {
    updates.wh_stock = qty;
    updates.ml1_stock = ml1;
    updates.ml2_stock = ml2;
  } else if (cfg.stockField === 'ml1_stock') {
    updates.wh_stock = wh;
    updates.ml1_stock = qty;
    updates.ml2_stock = ml2;
  } else {
    updates.wh_stock = wh;
    updates.ml1_stock = ml1;
    updates.ml2_stock = qty;
  }
  updates.stock_in_hand = computeStockInHand(updates.wh_stock, updates.ml1_stock, updates.ml2_stock);
  updates.qc_status = deriveQcStatusAfterStock(updates.stock_in_hand, beforeSnap.reorder_pt, beforeSnap.qc_status);
  return updates;
}

/**
 * @param {Array<{ excel_row, sku, item_name, sih }>} rows
 * @param {'warehouse'|'ml1'|'ml2'} bucketKey
 * @param {{ details?: boolean }} opts
 */
async function executeSihBucketRows(rows, bucketKey, opts = {}) {
  const cfg = BUCKET_CONFIG[bucketKey];
  const details = Boolean(opts.details);
  const summary = {
    rm_updated: 0,
    pm_updated: 0,
    pr_updated: 0,
    created: 0,
    skipped: 0,
    errors: 0,
    rack_allocated: 0,
    row_log: [],
  };

  for (const row of rows) {
    const logBase = {
      excel_row: row.excel_row,
      sku: row.sku || null,
      item_name: row.item_name || null,
    };

    if (row.sih == null) {
      summary.skipped += 1;
      if (details) {
        summary.row_log.push({ ...logBase, action: 'skipped', reason: 'invalid_sih' });
      }
      continue;
    }

    if (!row.sku && !row.item_name) {
      summary.skipped += 1;
      if (details) {
        summary.row_log.push({ ...logBase, action: 'skipped', reason: 'missing_sku_and_item_name' });
      }
      continue;
    }

    try {
      const resolved = await resolveMasterFromSihRow(row);

      if (!resolved) {
        summary.skipped += 1;
        if (details) {
          summary.row_log.push({ ...logBase, action: 'skipped', reason: 'master_not_found' });
        }
        continue;
      }

      if (resolved.ambiguous) {
        summary.errors += 1;
        if (details) {
          summary.row_log.push({
            ...logBase,
            action: 'error',
            reason: 'ambiguous_master',
            match_by: resolved.matchBy,
            matches: resolved.ambiguous.map((m) => ({
              kind: m.kind,
              code: masterCode(m.kind, m.row),
            })),
          });
        }
        continue;
      }

      const { kind, row: masterRow, matchBy } = resolved;
      const qty = Math.max(0, toNum(row.sih));
      const whRow = await findOrCreateWarehouseRow(kind, masterRow);
      const beforeSnap = inventoryAuditSnapshot(whRow);
      const wasNew =
        toNum(beforeSnap.wh_stock) === 0 &&
        toNum(beforeSnap.ml1_stock) === 0 &&
        toNum(beforeSnap.ml2_stock) === 0 &&
        toNum(beforeSnap.stock_in_hand) === 0;

      const updates = buildBucketUpdates(bucketKey, qty, beforeSnap);
      const whUnit = masterWhUnit(kind, masterRow);
      if (whUnit) updates.wh_unit = whUnit.slice(0, 20);

      await whRow.update(updates);
      await whRow.reload();
      // Was allocateUnallocatedToDefaultRack (top-up only) — a bucket import that LOWERS the
      // number left racks stuck at their old, higher qty forever (nothing ever trimmed them),
      // so pick/transfer screens kept offering stock this import just said isn't there anymore.
      // reconcileRackStockToTarget handles both directions.
      const alloc = await reconcileRackStockToTarget(whRow, bucketKey);
      if (alloc.direction !== 'none') summary.rack_allocated += 1;
      const afterSnap = inventoryAuditSnapshot(whRow);

      await logLocationMovement({
        warehouseInventoryId: whRow.id,
        itemType: kind,
        rawMaterialId: kind === 'RM' ? masterSourceId(kind, masterRow) : null,
        packMaterialId: kind === 'PM' ? masterSourceId(kind, masterRow) : null,
        productId: kind === 'PR' ? masterSourceId(kind, masterRow) : null,
        fromZone: beforeSnap.zone || null,
        fromRack: beforeSnap.rack || null,
        toZone: afterSnap.zone || null,
        toRack: afterSnap.rack || null,
        qtyDelta: afterSnap.stock_in_hand - beforeSnap.stock_in_hand,
        actionType: 'INVENTORY_ADJUST',
        changesJson: { before: beforeSnap, after: afterSnap, source: cfg.auditSource, bucket: bucketKey },
        note: `${cfg.label} SIH Excel import (row ${row.excel_row}, ${cfg.stockField}=${qty})`,
      });

      if (kind === 'RM') summary.rm_updated += 1;
      else if (kind === 'PM') summary.pm_updated += 1;
      else summary.pr_updated += 1;
      if (wasNew) summary.created += 1;

      if (details) {
        summary.row_log.push({
          ...logBase,
          action: wasNew ? 'created_and_updated' : 'updated',
          item_type: kind,
          master_code: masterCode(kind, masterRow),
          match_by: matchBy,
          sih: qty,
          bucket: bucketKey,
          warehouse_inventory_id: whRow.id,
        });
      }
    } catch (err) {
      summary.errors += 1;
      if (details) {
        summary.row_log.push({
          ...logBase,
          action: 'error',
          reason: err?.message || 'update_failed',
        });
      }
    }
  }

  return summary;
}

async function invalidateWarehouseCaches() {
  await Promise.all([
    redis.delByPattern('warehouse-inventory:').catch(() => {}),
    redis.delByPattern('planning-extracted:').catch(() => {}),
    redis.delByPattern('dashboard:').catch(() => {}),
  ]);
}

function makePostHandler(bucketKey) {
  return async function postSihBucketExcelImport(req, res) {
    try {
      if (!req.file?.buffer?.length) {
        return res.status(400).json({ error: 'No file uploaded (field name: file)' });
      }
      const details = req.query.details === '1' || req.query.details === 'true';
      const cfg = BUCKET_CONFIG[bucketKey];

      let parsed;
      try {
        parsed = await parseSihBucketWorkbook(req.file.buffer, bucketKey);
      } catch (loadErr) {
        console.error(`[sih-excel-${bucketKey}] parse error`, loadErr);
        return res.status(400).json({ error: loadErr.message || 'Invalid Excel file' });
      }

      const { rows, sheetName } = parsed;
      if (!rows.length) {
        return res.status(400).json({
          error: `No data rows found on "${sheetName}". Need sku (or item_name) and SIH.`,
          sheet_name: sheetName,
          bucket: bucketKey,
        });
      }
      if (rows.length > MAX_DATA_ROWS) {
        return res.status(400).json({ error: `At most ${MAX_DATA_ROWS} data rows per file` });
      }

      const aggregated = {
        rm_updated: 0,
        pm_updated: 0,
        pr_updated: 0,
        created: 0,
        skipped: 0,
        errors: 0,
        rack_allocated: 0,
        row_log: [],
      };

      for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
        const slice = rows.slice(offset, offset + CHUNK_SIZE);
        const part = await executeSihBucketRows(slice, bucketKey, { details });
        aggregated.rm_updated += part.rm_updated;
        aggregated.pm_updated += part.pm_updated;
        aggregated.pr_updated += part.pr_updated;
        aggregated.created += part.created;
        aggregated.skipped += part.skipped;
        aggregated.errors += part.errors;
        aggregated.rack_allocated += part.rack_allocated || 0;
        if (details && part.row_log?.length) aggregated.row_log.push(...part.row_log);
      }

      await invalidateWarehouseCaches();

      return res.json({
        ok: true,
        bucket: bucketKey,
        bucket_label: cfg.label,
        sheet_name: sheetName,
        rows_total: rows.length,
        summary: {
          rm_updated: aggregated.rm_updated,
          pm_updated: aggregated.pm_updated,
          pr_updated: aggregated.pr_updated,
          created: aggregated.created,
          skipped: aggregated.skipped,
          errors: aggregated.errors,
          rack_allocated: aggregated.rack_allocated,
        },
        ...(details ? { row_log: aggregated.row_log } : {}),
      });
    } catch (err) {
      console.error(`[sih-excel-${bucketKey}] import error`, err);
      return res.status(500).json({ error: err.message || `${BUCKET_CONFIG[bucketKey].label} SIH import failed` });
    }
  };
}

const MAX_CHUNK_ROWS = CHUNK_SIZE;

/**
 * Stateless per-chunk handler — the client parses the workbook itself and POSTs bounded batches
 * of rows here (same shape as src/masterBulk/itemReferenceBulkChunk.js's postItemReferenceBulkChunk),
 * so no single request ever does a full-file parse + full-file DB write. No server-side job/session
 * state: chunk_index/chunk_total are only echoed back as percent_complete.
 */
function makeChunkPostHandler(bucketKey) {
  return async function postSihBucketExcelChunk(req, res) {
    try {
      const cfg = BUCKET_CONFIG[bucketKey];
      const b = req.body || {};
      const rowsIn = Array.isArray(b.rows) ? b.rows : [];
      const chunkIndex = Number(b.chunk_index);
      const chunkTotal = Number(b.chunk_total);
      const details = Boolean(b.details);

      if (!Number.isFinite(chunkIndex) || chunkIndex < 0) {
        return res.status(400).json({ error: 'chunk_index must be a non-negative number' });
      }
      if (!Number.isFinite(chunkTotal) || chunkTotal < 1) {
        return res.status(400).json({ error: 'chunk_total must be >= 1' });
      }
      if (rowsIn.length === 0) {
        return res.status(400).json({ error: 'rows array is required' });
      }
      if (rowsIn.length > MAX_CHUNK_ROWS) {
        return res.status(400).json({ error: `At most ${MAX_CHUNK_ROWS} rows per chunk` });
      }

      const rows = rowsIn.map((r, idx) => ({
        excel_row: Number.isFinite(Number(r?.excel_row)) ? Number(r.excel_row) : idx,
        sku: String(r?.sku ?? '').trim(),
        item_name: String(r?.item_name ?? '').trim(),
        sih: r?.sih == null || r.sih === '' ? null : parseQuantity(r.sih),
      }));

      const summary = await executeSihBucketRows(rows, bucketKey, { details });
      await invalidateWarehouseCaches();

      const percentComplete = Math.min(100, Math.round(((chunkIndex + 1) / chunkTotal) * 100));

      return res.json({
        ok: true,
        bucket: bucketKey,
        bucket_label: cfg.label,
        chunk_index: chunkIndex,
        chunk_total: chunkTotal,
        percent_complete: percentComplete,
        rows_in_chunk: rows.length,
        summary: {
          rm_updated: summary.rm_updated,
          pm_updated: summary.pm_updated,
          pr_updated: summary.pr_updated,
          created: summary.created,
          skipped: summary.skipped,
          errors: summary.errors,
          rack_allocated: summary.rack_allocated,
        },
        ...(details ? { row_log: summary.row_log } : {}),
      });
    } catch (err) {
      console.error(`[sih-excel-${bucketKey}-chunk] import error`, err);
      return res.status(500).json({ error: err.message || `${BUCKET_CONFIG[bucketKey].label} SIH chunk import failed` });
    }
  };
}

const uploadSihExcelMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    const name = String(file?.originalname || '').toLowerCase();
    const okName = name.endsWith('.xlsx') || name.endsWith('.xlsm');
    const okMime = !file?.mimetype || ALLOWED_MIME.has(file.mimetype);
    if (okName && okMime) return cb(null, true);
    cb(new Error('Only .xlsx / .xlsm files are accepted'));
  },
}).single('file');

function uploadSihExcelSafe(req, res, next) {
  uploadSihExcelMiddleware(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    return next();
  });
}

module.exports = {
  BUCKET_CONFIG,
  uploadSihExcelSafe,
  postWarehouseSihExcelImport: makePostHandler('warehouse'),
  postMl1SihExcelImport: makePostHandler('ml1'),
  postMl2SihExcelImport: makePostHandler('ml2'),
  postWarehouseSihExcelChunk: makeChunkPostHandler('warehouse'),
  parseSihBucketWorkbook,
  detectSihHeaderColumns,
  findWorksheetForBucket,
  executeSihBucketRows,
  buildBucketUpdates,
};

/**
 * POST /api/v1/warehouse-inventory/import-inventory-summary-excel
 * Zoho "Inventory Summary" workbook: sheet "Inventory Summary", columns item_id, sku, quantity_available.
 * Sets warehouse wh_stock (and stock_in_hand) from quantity_available for matched RM/PM/PR masters.
 */
const ExcelJS = require('exceljs');
const multer = require('multer');
const WarehouseInventory = require('./models');
const { logLocationMovement } = require('./locationHistoryHelpers');
const {
  resolveInventoryMaster,
  masterCode,
  masterSourceId,
  masterWhUnit,
} = require('../products/inventoryMasterLookup');
const redis = require('../cache/redis');

const INVENTORY_SUMMARY_SHEET = 'inventory summary';
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_DATA_ROWS = 50000;
const CHUNK_SIZE = 200;
const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

const HEADER_ALIASES = {
  itemId: ['item_id', 'item id', 'zoho item id', 'zoho_id', 'zoho id'],
  sku: ['sku', 'item sku', 'sku code', 'zoho sku', 'item code'],
  quantityAvailable: [
    'quantity_available',
    'quantity available',
    'available quantity',
    'qty available',
    'stock available',
    'available stock',
  ],
};

/** Zoho export columns that must never be used as on-hand stock (SIH). */
const EXCLUDED_QUANTITY_HEADERS = new Set([
  'quantity_ordered',
  'quantity_in_transit',
  'quantity_purchased',
  'quantity_sold',
  'quantity_demanded',
  'quantity_available_for_sale',
]);

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

function isExcludedQuantityHeader(cellText) {
  const h = normHeader(cellText);
  return EXCLUDED_QUANTITY_HEADERS.has(h);
}

function resolveQuantityAvailableColumnIndex(headerCells) {
  let exactCol = null;
  let aliasCol = null;
  for (let c = 0; c < headerCells.length; c += 1) {
    const text = headerCells[c];
    if (!text || isExcludedQuantityHeader(text)) continue;
    const h = normHeader(text);
    if (h === 'quantity_available') {
      exactCol = c + 1;
      break;
    }
    if (aliasCol == null && matchHeaderAlias(text, HEADER_ALIASES.quantityAvailable)) {
      aliasCol = c + 1;
    }
  }
  return exactCol ?? aliasCol;
}

function parseQuantity(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function findInventorySummaryWorksheet(workbook) {
  if (!workbook?.worksheets?.length) return null;
  for (const ws of workbook.worksheets) {
    const n = String(ws.name || '')
      .trim()
      .toLowerCase();
    if (n === INVENTORY_SUMMARY_SHEET) return ws;
  }
  return workbook.worksheets[0];
}

function detectHeaderColumns(worksheet) {
  for (let headerRowNum = 1; headerRowNum <= 5; headerRowNum += 1) {
    const row = worksheet.getRow(headerRowNum);
    const cols = {};
    const colCount = Math.max(row.cellCount || 0, 30);
    const headerTexts = [];
    for (let c = 1; c <= colCount; c += 1) {
      const text = cellToText(row.getCell(c));
      headerTexts.push(text);
      if (!text) continue;
      if (!cols.itemId && matchHeaderAlias(text, HEADER_ALIASES.itemId)) cols.itemId = c;
      else if (!cols.sku && matchHeaderAlias(text, HEADER_ALIASES.sku)) cols.sku = c;
    }
    const qtyCol = resolveQuantityAvailableColumnIndex(headerTexts);
    if (qtyCol != null) cols.quantityAvailable = qtyCol;
    if (cols.quantityAvailable != null && (cols.itemId != null || cols.sku != null)) {
      return { headerRowNum, dataStartRow: headerRowNum + 1, cols };
    }
  }
  return null;
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<{ rows: object[], sheetName: string }>}
 */
async function parseInventorySummaryWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = findInventorySummaryWorksheet(workbook);
  if (!worksheet) {
    throw new Error('Workbook has no worksheets');
  }
  const layout = detectHeaderColumns(worksheet);
  if (!layout) {
    throw new Error(
      'Could not find headers on "Inventory Summary". Expected columns: item_id (or sku) and quantity_available.'
    );
  }

  const rows = [];
  const lastRow = worksheet.rowCount || layout.dataStartRow;
  for (let r = layout.dataStartRow; r <= lastRow; r += 1) {
    const row = worksheet.getRow(r);
    const itemId = layout.cols.itemId ? cellToText(row.getCell(layout.cols.itemId)) : '';
    const sku = layout.cols.sku ? cellToText(row.getCell(layout.cols.sku)) : '';
    const qtyRaw = cellToText(row.getCell(layout.cols.quantityAvailable));
    if (!itemId && !sku && !qtyRaw) continue;
    rows.push({
      excel_row: r,
      item_id: itemId,
      sku,
      quantity_available: parseQuantity(qtyRaw),
    });
  }

  return { rows, sheetName: worksheet.name };
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

/**
 * @param {Array<{ excel_row, item_id, sku, quantity_available }>} rows
 * @param {{ details?: boolean }} opts
 */
async function executeInventorySummaryRows(rows, opts = {}) {
  const details = Boolean(opts.details);
  const summary = {
    rm_updated: 0,
    pm_updated: 0,
    pr_updated: 0,
    created: 0,
    skipped: 0,
    errors: 0,
    row_log: [],
  };

  for (const row of rows) {
    const logBase = {
      excel_row: row.excel_row,
      item_id: row.item_id || null,
      sku: row.sku || null,
    };

    if (row.quantity_available == null) {
      summary.skipped += 1;
      if (details) {
        summary.row_log.push({ ...logBase, action: 'skipped', reason: 'invalid_quantity_available' });
      }
      continue;
    }

    if (!row.item_id && !row.sku) {
      summary.skipped += 1;
      if (details) {
        summary.row_log.push({ ...logBase, action: 'skipped', reason: 'missing_item_id_and_sku' });
      }
      continue;
    }

    try {
      const resolved = await resolveInventoryMaster({
        zohoItemId: row.item_id,
        sku: row.sku,
      });

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
      const qty = Math.max(0, toNum(row.quantity_available));
      const whRow = await findOrCreateWarehouseRow(kind, masterRow);
      const wh = whRow.get ? whRow.get({ plain: true }) : whRow;
      const beforeSnap = inventoryAuditSnapshot(whRow);
      const wasNew =
        toNum(beforeSnap.wh_stock) === 0 &&
        toNum(beforeSnap.ml1_stock) === 0 &&
        toNum(beforeSnap.ml2_stock) === 0 &&
        toNum(beforeSnap.stock_in_hand) === 0;

      const updates = {
        wh_stock: qty,
        ml1_stock: 0,
        ml2_stock: 0,
        stock_in_hand: qty,
        qc_status: deriveQcStatusAfterStock(qty, beforeSnap.reorder_pt, beforeSnap.qc_status),
      };
      const whUnit = masterWhUnit(kind, masterRow);
      if (whUnit) updates.wh_unit = whUnit.slice(0, 20);

      await whRow.update(updates);
      const afterSnap = inventoryAuditSnapshot(whRow);

      await logLocationMovement({
        warehouseInventoryId: wh.id,
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
        changesJson: { before: beforeSnap, after: afterSnap, source: 'zoho_inventory_summary_excel' },
        note: `Zoho Inventory Summary import (row ${row.excel_row}, qty ${qty})`,
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
          quantity_available: qty,
          warehouse_inventory_id: wh.id,
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

async function postInventorySummaryExcelImport(req, res) {
  try {
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'No file uploaded (field name: file)' });
    }
    const details = req.query.details === '1' || req.query.details === 'true';

    let parsed;
    try {
      parsed = await parseInventorySummaryWorkbook(req.file.buffer);
    } catch (loadErr) {
      console.error('[inventory-summary-excel] parse error', loadErr);
      return res.status(400).json({ error: loadErr.message || 'Invalid Excel file' });
    }

    const { rows, sheetName } = parsed;
    if (!rows.length) {
      return res.status(400).json({
        error:
          'No data rows found on "Inventory Summary". Need item_id or sku plus quantity_available.',
        sheet_name: sheetName,
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
      row_log: [],
    };

    for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
      const slice = rows.slice(offset, offset + CHUNK_SIZE);
      const part = await executeInventorySummaryRows(slice, { details });
      aggregated.rm_updated += part.rm_updated;
      aggregated.pm_updated += part.pm_updated;
      aggregated.pr_updated += part.pr_updated;
      aggregated.created += part.created;
      aggregated.skipped += part.skipped;
      aggregated.errors += part.errors;
      if (details && part.row_log?.length) aggregated.row_log.push(...part.row_log);
    }

    await invalidateWarehouseCaches();

    return res.json({
      ok: true,
      sheet_name: sheetName,
      rows_total: rows.length,
      summary: {
        rm_updated: aggregated.rm_updated,
        pm_updated: aggregated.pm_updated,
        pr_updated: aggregated.pr_updated,
        created: aggregated.created,
        skipped: aggregated.skipped,
        errors: aggregated.errors,
      },
      ...(details ? { row_log: aggregated.row_log } : {}),
    });
  } catch (err) {
    console.error('[inventory-summary-excel] import error', err);
    return res.status(500).json({ error: err.message || 'Inventory summary import failed' });
  }
}

const uploadInventorySummaryExcelMiddleware = multer({
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

function uploadInventorySummaryExcelSafe(req, res, next) {
  uploadInventorySummaryExcelMiddleware(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    return next();
  });
}

/**
 * Re-apply SIH (wh_stock + stock_in_hand) from latest Zoho Inventory Summary import audit rows.
 * Does not modify in_transit, reserved, or purchase_orders (PO qty is derived separately).
 *
 * @param {{ dryRun?: boolean }} [opts]
 */
async function repairSihFromInventoryExcelImportHistory(opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const db = require('../../db');
  const sequelize = db;
  const [rows] = await sequelize.query(`
    SELECT DISTINCT ON (h.warehouse_inventory_id)
      h.warehouse_inventory_id,
      h.changes_json,
      h.note
    FROM warehouse_inventory_location_history h
    WHERE h.note LIKE '%Zoho Inventory Summary%'
    ORDER BY h.warehouse_inventory_id, h.id DESC
  `);

  const summary = { scanned: rows.length, updated: 0, skipped: 0, errors: 0 };
  for (const row of rows) {
    try {
      const changes =
        typeof row.changes_json === 'string' ? JSON.parse(row.changes_json) : row.changes_json;
      const targetQty = Math.max(0, toNum(changes?.after?.wh_stock ?? changes?.after?.stock_in_hand));
      const whRow = await WarehouseInventory.findByPk(row.warehouse_inventory_id);
      if (!whRow) {
        summary.skipped += 1;
        continue;
      }
      const beforeSnap = inventoryAuditSnapshot(whRow);
      const currentSih = toNum(beforeSnap.wh_stock) + toNum(beforeSnap.ml1_stock) + toNum(beforeSnap.ml2_stock);
      if (Math.abs(currentSih - targetQty) < 0.005 && toNum(beforeSnap.ml1_stock) === 0 && toNum(beforeSnap.ml2_stock) === 0) {
        summary.skipped += 1;
        continue;
      }
      if (!dryRun) {
        const updates = {
          wh_stock: targetQty,
          ml1_stock: 0,
          ml2_stock: 0,
          stock_in_hand: targetQty,
          qc_status: deriveQcStatusAfterStock(targetQty, beforeSnap.reorder_pt, beforeSnap.qc_status),
        };
        await whRow.update(updates);
        const afterSnap = inventoryAuditSnapshot(whRow);
        await logLocationMovement({
          warehouseInventoryId: whRow.id,
          itemType: whRow.item_type,
          rawMaterialId: whRow.raw_material_id,
          packMaterialId: whRow.pack_material_id,
          productId: whRow.product_id,
          fromZone: beforeSnap.zone || null,
          fromRack: beforeSnap.rack || null,
          toZone: afterSnap.zone || null,
          toRack: afterSnap.rack || null,
          qtyDelta: afterSnap.stock_in_hand - beforeSnap.stock_in_hand,
          actionType: 'INVENTORY_ADJUST',
          changesJson: {
            before: beforeSnap,
            after: afterSnap,
            source: 'zoho_inventory_summary_excel_repair_sih',
          },
          note: `Repair SIH from Inventory Summary import (${row.note || 'audit'})`,
        });
      }
      summary.updated += 1;
    } catch {
      summary.errors += 1;
    }
  }
  if (!dryRun) await invalidateWarehouseCaches();
  return { ...summary, dryRun };
}

module.exports = {
  uploadInventorySummaryExcelSafe,
  postInventorySummaryExcelImport,
  parseInventorySummaryWorkbook,
  executeInventorySummaryRows,
  detectHeaderColumns,
  findInventorySummaryWorksheet,
  resolveQuantityAvailableColumnIndex,
  isExcludedQuantityHeader,
  repairSihFromInventoryExcelImportHistory,
};

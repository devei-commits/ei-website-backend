/**
 * POST body: { rows, chunk_index, chunk_total }
 * Each row: { excel_row?, line_type: 'Packaging' | 'Raw Material', zoho_sku_code, description }
 * Packaging: match pack_materials by Item Name = description (case-insensitive, trimmed). Exactly one row
 * updates zoho_sku_code; when not found, create EI-PM-BULK-* with that description + Zoho SKU.
 * Raw material (legacy): match by Item Name = name (LOWER(TRIM)). Exactly one row → update zoho_sku_code only
 * (price_per_kg and other fields unchanged). Zero rows → create EI-RM-BULK-* with name + zoho SKU.
 * Raw material (import_profile: 'rm_multi_sheet'): multi-worksheet template — match by code/zoho_sku_code then name;
 * create/update with SKU as code, plus name, INCI, category/sub-category, UOM, HSN, GST%, purchase rate.
 * Packaging (import_profile: 'pm_multi_sheet'): same row/column layout; match by code/zoho_sku_code then description;
 * create/update with SKU as code, group/material from sub-category & category columns & sheet tab, UOM, HSN, tax, price_per_pc.
 * Multiple name matches → error. No Zoho Books API calls.
 */
const { Op, fn, col, where: sqlWhere } = require('sequelize');
const db = require('../../db');
const PackMaterial = require('../packMaterials/models');
const RawMaterial = require('../rawMaterials/models');
const WarehouseInventory = require('../warehouseInventory/models');
const { findConflictingMasterRow } = require('../lib/itemCodeUniqueness');
const redis = require('../cache/redis');
const { mapRmImportCategories, mapPmImportCategories } = require('./masterCategoryImportMap');

function mergeFormData(existing, patch) {
  const base =
    existing != null && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  return { ...base, ...patch };
}

const RM_PREFIX = 'EI-RM-BULK';
const PM_PREFIX = 'EI-PM-BULK';

function parsePercent(input) {
  if (input == null || input === '') return null;
  const s = String(input).replace(/%/g, '').replace(/,/g, '').trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parseMoney(input) {
  if (input == null || input === '') return null;
  const s = String(input).replace(/,/g, '').trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parseSuffix(code, prefix) {
  if (!code || !prefix || !String(code).startsWith(prefix)) return null;
  const rest = String(code).slice(prefix.length).replace(/^-+/, '');
  const num = parseInt(rest, 10);
  return Number.isNaN(num) ? null : num;
}

async function nextCodeForModel(Model, prefix) {
  const rows = await Model.findAll({
    attributes: ['code'],
    where: { code: { [Op.iLike]: `${prefix}%` } },
  });
  let maxNum = 0;
  for (const row of rows) {
    const code = row.get ? row.get('code') : row.code;
    const n = parseSuffix(code, prefix);
    if (n != null && n > maxNum) maxNum = n;
  }
  return `${prefix}-${String(maxNum + 1).padStart(5, '0')}`;
}

function normalizeLineType(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (s === 'packaging') return 'packaging';
  if (s === 'raw material' || s === 'raw_material' || s === 'rawmaterial') return 'raw_material';
  return null;
}

function userAllows(user, moduleId) {
  const a = user?.allowedModules || [];
  return a.includes('*') || a.includes(moduleId);
}

async function invalidateMasterListCaches() {
  await Promise.all([
    redis.delByPattern('pack-materials:').catch(() => {}),
    redis.delByPattern('raw-materials:').catch(() => {}),
    redis.delByPattern('warehouse-inventory:').catch(() => {}),
    redis.delByPattern('planning-extracted:').catch(() => {}),
    redis.delByPattern('fulfillment:').catch(() => {}),
    redis.delByPattern('items-list:').catch(() => {}),
  ]);
}

async function upsertPackMaterialRow({ sku, description, excelRow }, results, details) {
  const skuTrim = sku != null ? String(sku).trim() : '';
  const descTrim = description != null ? String(description).trim() : '';

  if (!descTrim) {
    results.skipped += 1;
    if (details) results.row_log.push({ excel_row: excelRow, kind: 'packaging', action: 'skipped', reason: 'missing_description' });
    return;
  }
  if (!skuTrim) {
    results.skipped += 1;
    if (details) results.row_log.push({ excel_row: excelRow, kind: 'packaging', action: 'skipped', reason: 'missing_sku' });
    return;
  }

  const matches = await PackMaterial.findAll({
    where: sqlWhere(fn('LOWER', fn('TRIM', col('description'))), descTrim.toLowerCase()),
    limit: 3,
  });

  if (matches.length === 0) {
    const code = await nextCodeForModel(PackMaterial, PM_PREFIX);
    const dupNew = await findConflictingMasterRow(PackMaterial, code, skuTrim, null);
    if (dupNew) {
      results.errors += 1;
      if (details) {
        results.row_log.push({
          excel_row: excelRow,
          kind: 'packaging',
          action: 'error',
          reason: 'create_conflict',
        });
      }
      return;
    }

    const t = await db.transaction();
    try {
      const created = await PackMaterial.create(
        {
          code,
          description: descTrim,
          zoho_sku_code: skuTrim,
          type: 'Packaging',
          level: 'Primary',
          unit: 'PCS',
          products: [],
        },
        { transaction: t }
      );
      await WarehouseInventory.findOrCreate({
        where: { item_type: 'PM', pack_material_id: created.id },
        defaults: {
          item_type: 'PM',
          pack_material_id: created.id,
          wh_stock: 0,
          wh_unit: 'PCS',
          ml1_stock: 0,
          ml2_stock: 0,
          stock_in_hand: 0,
          reserved: 0,
          in_transit: 0,
          reorder_pt: 0,
          avg_mo: 0,
          qc_status: 'Out of Stock',
        },
        transaction: t,
      });
      await t.commit();
      results.packaging_created += 1;
      if (details) {
        results.row_log.push({ excel_row: excelRow, kind: 'packaging', action: 'created', id: String(created.id) });
      }
    } catch (e) {
      await t.rollback();
      results.errors += 1;
      if (details) {
        results.row_log.push({
          excel_row: excelRow,
          kind: 'packaging',
          action: 'error',
          reason: e?.message || 'create_failed',
        });
      }
    }
    return;
  }
  if (matches.length > 1) {
    results.errors += 1;
    if (details) {
      results.row_log.push({
        excel_row: excelRow,
        kind: 'packaging',
        action: 'error',
        reason: 'ambiguous_description',
        count: matches.length,
      });
    }
    return;
  }

  const row = matches[0];
  const dup = await findConflictingMasterRow(PackMaterial, row.code, skuTrim, row.id);
  if (dup) {
    results.errors += 1;
    if (details) {
      results.row_log.push({
        excel_row: excelRow,
        kind: 'packaging',
        action: 'error',
        reason: 'sku_or_code_conflict',
      });
    }
    return;
  }

  await row.update({
    zoho_sku_code: skuTrim,
    type: 'Packaging',
  });
  results.packaging_updated += 1;
  if (details) {
    results.row_log.push({ excel_row: excelRow, kind: 'packaging', action: 'updated', id: String(row.id) });
  }
}

/**
 * Multi-worksheet PM import (row 4 = headers A–M, data from row 5). Same layout as RM workbook.
 * Match: code or zoho_sku_code, else unique description; create uses SKU as code when unique.
 * group ≈ RM category (sub-category / sheet / category); material = Excel category column.
 */
async function upsertPackMaterialMultiSheetRow(
  {
    sku,
    description,
    excelRow,
    sheetName,
    categoryCol,
    subCategoryCol,
    uom,
    hsnCode,
    gstPct,
    purchaseRate,
  },
  results,
  details
) {
  const skuTrim = sku != null ? String(sku).trim() : '';
  const descTrim = description != null ? String(description).trim() : '';
  const subFromCol = subCategoryCol != null ? String(subCategoryCol).trim() : '';
  const catFromCol = categoryCol != null ? String(categoryCol).trim() : '';
  const mapped = mapPmImportCategories({
    sheetName,
    categoryCol: catFromCol,
    subCategoryCol: subFromCol,
  });
  const groupDb = mapped.groupDb;
  const uomTrim = uom != null ? String(uom).trim() : '';
  const hsnTrim = hsnCode != null ? String(hsnCode).trim() : '';
  const gstNum = parsePercent(gstPct);
  const rateNum = parseMoney(purchaseRate);
  const whUnitDefault = (uomTrim || 'PCS').slice(0, 20);

  const logCtx = { excel_row: excelRow, sheet: sheetName || null, kind: 'packaging' };

  if (!descTrim && !skuTrim) {
    results.skipped += 1;
    if (details) results.row_log.push({ ...logCtx, action: 'skipped', reason: 'empty_row' });
    return;
  }
  if (!descTrim) {
    results.skipped += 1;
    if (details) results.row_log.push({ ...logCtx, action: 'skipped', reason: 'missing_description' });
    return;
  }
  if (!skuTrim) {
    results.skipped += 1;
    if (details) results.row_log.push({ ...logCtx, action: 'skipped', reason: 'missing_sku' });
    return;
  }

  let row = await PackMaterial.findOne({
    where: {
      [Op.or]: [
        { code: { [Op.iLike]: skuTrim } },
        { zoho_sku_code: { [Op.iLike]: skuTrim } },
      ],
    },
  });

  if (!row) {
    const descMatches = await PackMaterial.findAll({
      where: sqlWhere(fn('LOWER', fn('TRIM', col('description'))), descTrim.toLowerCase()),
      limit: 3,
    });
    if (descMatches.length > 1) {
      results.errors += 1;
      if (details) {
        results.row_log.push({ ...logCtx, action: 'error', reason: 'ambiguous_description', count: descMatches.length });
      }
      return;
    }
    if (descMatches.length === 1) [row] = descMatches;
  }

  const taxPref =
    hsnTrim && gstNum != null && gstNum > 0 ? 'Taxable' : hsnTrim ? 'Taxable' : null;

  if (row) {
    const dup = await findConflictingMasterRow(PackMaterial, skuTrim, skuTrim, row.id);
    if (dup) {
      results.errors += 1;
      if (details) results.row_log.push({ ...logCtx, action: 'error', reason: 'sku_or_code_conflict' });
      return;
    }

    const updatePayload = {
      description: descTrim,
      group: groupDb,
      material: mapped.materialDb,
      type: 'Packaging',
      unit: uomTrim || row.unit || 'PCS',
      hsn_code: hsnTrim || null,
      price_per_pc: rateNum != null ? rateNum : row.price_per_pc,
      zoho_sku_code: skuTrim,
    };
    if (taxPref) updatePayload.tax_pref = taxPref;
    updatePayload.form_data = mergeFormData(row.form_data, mapped.formDataPatch);

    const codeLower = String(row.code || '').trim().toLowerCase();
    if (skuTrim && codeLower !== skuTrim.toLowerCase()) {
      const codeConflict = await PackMaterial.findOne({
        where: {
          [Op.and]: [
            { id: { [Op.ne]: row.id } },
            {
              [Op.or]: [{ code: { [Op.iLike]: skuTrim } }, { zoho_sku_code: { [Op.iLike]: skuTrim } }],
            },
          ],
        },
      });
      if (!codeConflict) {
        updatePayload.code = skuTrim;
      }
    }

    await row.update(updatePayload);

    const wh = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: row.id } });
    if (wh && uomTrim && String(wh.wh_unit || '') !== uomTrim.slice(0, 20)) {
      await wh.update({ wh_unit: uomTrim.slice(0, 20) });
    }

    results.packaging_updated += 1;
    if (details) results.row_log.push({ ...logCtx, action: 'updated', id: String(row.id) });
    return;
  }

  const dupNew = await findConflictingMasterRow(PackMaterial, skuTrim, skuTrim, null);
  if (dupNew) {
    results.errors += 1;
    if (details) results.row_log.push({ ...logCtx, action: 'error', reason: 'create_conflict' });
    return;
  }

  const t = await db.transaction();
  try {
    const created = await PackMaterial.create(
      {
        code: skuTrim,
        description: descTrim,
        zoho_sku_code: skuTrim,
        type: 'Packaging',
        level: 'Primary',
        group: groupDb,
        material: mapped.materialDb,
        unit: uomTrim || 'PCS',
        hsn_code: hsnTrim || null,
        price_per_pc: rateNum != null ? rateNum : null,
        tax_pref: taxPref,
        products: [],
        form_data: mapped.formDataPatch,
      },
      { transaction: t }
    );
    await WarehouseInventory.findOrCreate({
      where: { item_type: 'PM', pack_material_id: created.id },
      defaults: {
        item_type: 'PM',
        pack_material_id: created.id,
        wh_stock: 0,
        wh_unit: whUnitDefault,
        ml1_stock: 0,
        ml2_stock: 0,
        stock_in_hand: 0,
        reserved: 0,
        in_transit: 0,
        reorder_pt: 0,
        avg_mo: 0,
        qc_status: 'Out of Stock',
      },
      transaction: t,
    });
    await t.commit();
    results.packaging_created += 1;
    if (details) results.row_log.push({ ...logCtx, action: 'created', id: String(created.id) });
  } catch (e) {
    await t.rollback();
    results.errors += 1;
    if (details) {
      results.row_log.push({ ...logCtx, action: 'error', reason: e?.message || 'create_failed' });
    }
  }
}

/**
 * Multi-worksheet RM import (row 4 = headers A–M, data from row 5).
 * Match: code or zoho_sku_code, else unique name; create uses SKU as code when unique.
 */
async function upsertRawMaterialMultiSheetRow(
  {
    sku,
    description,
    excelRow,
    sheetName,
    inci,
    categoryCol,
    subCategoryCol,
    uom,
    hsnCode,
    gstPct,
    purchaseRate,
  },
  results,
  details
) {
  const skuTrim = sku != null ? String(sku).trim() : '';
  const nameTrim = description != null ? String(description).trim() : '';
  const inciTrim = inci != null ? String(inci).trim() : '';
  const subFromCol = subCategoryCol != null ? String(subCategoryCol).trim() : '';
  const catFromCol = categoryCol != null ? String(categoryCol).trim() : '';
  const mapped = mapRmImportCategories({
    sheetName,
    categoryCol: catFromCol,
    subCategoryCol: subFromCol,
  });
  const categoryDb = mapped.categoryDb;
  const groupDb = mapped.subCategory;
  const uomTrim = uom != null ? String(uom).trim() : '';
  const hsnTrim = hsnCode != null ? String(hsnCode).trim() : '';
  const gstNum = parsePercent(gstPct);
  const rateNum = parseMoney(purchaseRate);
  const whUnitDefault = (uomTrim || 'KG').slice(0, 20);

  const logCtx = { excel_row: excelRow, sheet: sheetName || null, kind: 'raw_material' };

  if (!nameTrim && !skuTrim) {
    results.skipped += 1;
    if (details) results.row_log.push({ ...logCtx, action: 'skipped', reason: 'empty_row' });
    return;
  }
  if (!nameTrim) {
    results.skipped += 1;
    if (details) results.row_log.push({ ...logCtx, action: 'skipped', reason: 'missing_name' });
    return;
  }
  if (!skuTrim) {
    results.skipped += 1;
    if (details) results.row_log.push({ ...logCtx, action: 'skipped', reason: 'missing_sku' });
    return;
  }

  let row = await RawMaterial.findOne({
    where: {
      [Op.or]: [
        { code: { [Op.iLike]: skuTrim } },
        { zoho_sku_code: { [Op.iLike]: skuTrim } },
      ],
    },
  });

  if (!row) {
    const nameMatches = await RawMaterial.findAll({
      where: sqlWhere(fn('LOWER', fn('TRIM', col('name'))), nameTrim.toLowerCase()),
      limit: 3,
    });
    if (nameMatches.length > 1) {
      results.errors += 1;
      if (details) {
        results.row_log.push({ ...logCtx, action: 'error', reason: 'ambiguous_name', count: nameMatches.length });
      }
      return;
    }
    if (nameMatches.length === 1) [row] = nameMatches;
  }

  const taxPref =
    hsnTrim && gstNum != null && gstNum > 0 ? 'Taxable' : hsnTrim ? 'Taxable' : null;

  if (row) {
    const dup = await findConflictingMasterRow(RawMaterial, skuTrim, skuTrim, row.id);
    if (dup) {
      results.errors += 1;
      if (details) results.row_log.push({ ...logCtx, action: 'error', reason: 'sku_or_code_conflict' });
      return;
    }

    const updatePayload = {
      name: nameTrim,
      inci: inciTrim || null,
      category: categoryDb,
      group: groupDb,
      uom: uomTrim || row.uom || 'KG',
      hsn_code: hsnTrim || null,
      gst: gstNum != null ? gstNum : row.gst,
      price_per_kg: rateNum != null ? rateNum : row.price_per_kg,
      zoho_sku_code: skuTrim,
    };
    if (taxPref) updatePayload.tax_pref = taxPref;
    updatePayload.form_data = mergeFormData(row.form_data, mapped.formDataPatch);

    const codeLower = String(row.code || '').trim().toLowerCase();
    if (skuTrim && codeLower !== skuTrim.toLowerCase()) {
      const codeConflict = await RawMaterial.findOne({
        where: {
          [Op.and]: [
            { id: { [Op.ne]: row.id } },
            {
              [Op.or]: [{ code: { [Op.iLike]: skuTrim } }, { zoho_sku_code: { [Op.iLike]: skuTrim } }],
            },
          ],
        },
      });
      if (!codeConflict) {
        updatePayload.code = skuTrim;
      }
    }

    await row.update(updatePayload);

    const wh = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: row.id } });
    if (wh && uomTrim && String(wh.wh_unit || '') !== uomTrim) {
      await wh.update({ wh_unit: uomTrim.slice(0, 20) });
    }

    results.raw_updated += 1;
    if (details) results.row_log.push({ ...logCtx, action: 'updated', id: String(row.id) });
    return;
  }

  const dupNew = await findConflictingMasterRow(RawMaterial, skuTrim, skuTrim, null);
  if (dupNew) {
    results.errors += 1;
    if (details) results.row_log.push({ ...logCtx, action: 'error', reason: 'create_conflict' });
    return;
  }

  const t = await db.transaction();
  try {
    const created = await RawMaterial.create(
      {
        code: skuTrim,
        name: nameTrim,
        inci: inciTrim || null,
        category: categoryDb,
        group: groupDb,
        uom: uomTrim || 'KG',
        hsn_code: hsnTrim || null,
        gst: gstNum != null ? gstNum : null,
        price_per_kg: rateNum != null ? rateNum : null,
        zoho_sku_code: skuTrim,
        tax_pref: taxPref,
        status: 'active',
        products: [],
        form_data: mapped.formDataPatch,
      },
      { transaction: t }
    );
    await WarehouseInventory.findOrCreate({
      where: { item_type: 'RM', raw_material_id: created.id },
      defaults: {
        item_type: 'RM',
        raw_material_id: created.id,
        wh_stock: 0,
        wh_unit: whUnitDefault,
        ml1_stock: 0,
        ml2_stock: 0,
        stock_in_hand: 0,
        reserved: 0,
        in_transit: 0,
        reorder_pt: 0,
        avg_mo: 0,
        qc_status: 'Out of Stock',
      },
      transaction: t,
    });
    await t.commit();
    results.raw_created += 1;
    if (details) results.row_log.push({ ...logCtx, action: 'created', id: String(created.id) });
  } catch (e) {
    await t.rollback();
    results.errors += 1;
    if (details) {
      results.row_log.push({ ...logCtx, action: 'error', reason: e?.message || 'create_failed' });
    }
  }
}

async function upsertRawMaterialRow({ sku, description, excelRow }, results, details) {
  const skuTrim = sku != null ? String(sku).trim() : '';
  const nameTrim = description != null ? String(description).trim() : '';

  if (!nameTrim) {
    results.skipped += 1;
    if (details) results.row_log.push({ excel_row: excelRow, kind: 'raw_material', action: 'skipped', reason: 'missing_name' });
    return;
  }

  const matches = await RawMaterial.findAll({
    where: sqlWhere(fn('LOWER', fn('TRIM', col('name'))), nameTrim.toLowerCase()),
    limit: 3,
  });

  if (matches.length > 1) {
    results.errors += 1;
    if (details) {
      results.row_log.push({
        excel_row: excelRow,
        kind: 'raw_material',
        action: 'error',
        reason: 'ambiguous_name',
        count: matches.length,
      });
    }
    return;
  }

  if (matches.length === 1) {
    if (!skuTrim) {
      results.skipped += 1;
      if (details) results.row_log.push({ excel_row: excelRow, kind: 'raw_material', action: 'skipped', reason: 'missing_sku' });
      return;
    }
    const row = matches[0];
    const dup = await findConflictingMasterRow(RawMaterial, row.code, skuTrim, row.id);
    if (dup) {
      results.errors += 1;
      if (details) {
        results.row_log.push({
          excel_row: excelRow,
          kind: 'raw_material',
          action: 'error',
          reason: 'sku_or_code_conflict',
        });
      }
      return;
    }
    await row.update({ zoho_sku_code: skuTrim });
    results.raw_updated += 1;
    if (details) results.row_log.push({ excel_row: excelRow, kind: 'raw_material', action: 'updated', id: String(row.id) });
    return;
  }

  if (!skuTrim) {
    results.skipped += 1;
    if (details) results.row_log.push({ excel_row: excelRow, kind: 'raw_material', action: 'skipped', reason: 'missing_sku' });
    return;
  }

  const code = await nextCodeForModel(RawMaterial, RM_PREFIX);
  const dupNew = await findConflictingMasterRow(RawMaterial, code, skuTrim, null);
  if (dupNew) {
    results.errors += 1;
    if (details) results.row_log.push({ excel_row: excelRow, kind: 'raw_material', action: 'error', reason: 'create_conflict' });
    return;
  }

  const t = await db.transaction();
  try {
    const created = await RawMaterial.create(
      {
        code,
        name: nameTrim,
        zoho_sku_code: skuTrim,
        rm_type: 'Raw Material',
        status: 'active',
        products: [],
        uom: 'KG',
      },
      { transaction: t }
    );
    await WarehouseInventory.findOrCreate({
      where: { item_type: 'RM', raw_material_id: created.id },
      defaults: {
        item_type: 'RM',
        raw_material_id: created.id,
        wh_stock: 0,
        wh_unit: 'KG',
        ml1_stock: 0,
        ml2_stock: 0,
        stock_in_hand: 0,
        reserved: 0,
        in_transit: 0,
        reorder_pt: 0,
        avg_mo: 0,
        qc_status: 'Out of Stock',
      },
      transaction: t,
    });
    await t.commit();
    results.raw_created += 1;
    if (details) results.row_log.push({ excel_row: excelRow, kind: 'raw_material', action: 'created', id: String(created.id) });
  } catch (e) {
    await t.rollback();
    results.errors += 1;
    if (details) {
      results.row_log.push({
        excel_row: excelRow,
        kind: 'raw_material',
        action: 'error',
        reason: e?.message || 'create_failed',
      });
    }
  }
}

/**
 * Shared bulk processor (used by chunked JSON API and full-file excel import).
 * @param {Array<object>} rowsIn
 * @param {object} user req.user
 * @param {boolean} details
 * @returns {Promise<{ packaging_created: number, packaging_updated: number, raw_created: number, raw_updated: number, skipped: number, errors: number, row_log: object[] }>}
 */
async function executeItemReferenceBulkRows(rowsIn, user, details = false) {
  const canPm = userAllows(user, 'packaging-management');
  const canRm = userAllows(user, 'raw-materials-management');

  const results = {
    packaging_created: 0,
    packaging_updated: 0,
    raw_created: 0,
    raw_updated: 0,
    skipped: 0,
    errors: 0,
    row_log: [],
  };

  for (const r of rowsIn) {
    const excelRow = r.excel_row != null ? Number(r.excel_row) : null;
    const lineType = normalizeLineType(r.line_type ?? r.lineType ?? r.type);
    const sku = r.zoho_sku_code ?? r.zohoSkuCode ?? r.sku ?? '';
    const description = r.description ?? r.item_name ?? r.itemName ?? r.name ?? '';
    const importProfile = r.import_profile ?? r.importProfile ?? '';

    if (lineType == null) {
      results.skipped += 1;
      if (details) results.row_log.push({ excel_row: excelRow, action: 'skipped', reason: 'unknown_line_type' });
      continue;
    }

    if (lineType === 'packaging') {
      if (!canPm) {
        results.skipped += 1;
        if (details) results.row_log.push({ excel_row: excelRow, kind: 'packaging', action: 'skipped', reason: 'forbidden' });
        continue;
      }
      if (importProfile === 'pm_multi_sheet') {
        await upsertPackMaterialMultiSheetRow(
          {
            sku,
            description,
            excelRow,
            sheetName: r.sheet_name ?? r.sheetName ?? '',
            categoryCol: r.category ?? r.category_col ?? '',
            subCategoryCol: r.sub_category ?? r.subCategory ?? '',
            uom: r.uom ?? r.unit ?? '',
            hsnCode: r.hsn_code ?? r.hsnCode ?? '',
            gstPct: r.gst_pct ?? r.gstPct ?? r.gst ?? '',
            purchaseRate: r.purchase_rate_inr ?? r.purchaseRateInr ?? r.purchase_rate ?? '',
          },
          results,
          details
        );
      } else {
        await upsertPackMaterialRow({ sku, description, excelRow }, results, details);
      }
    } else {
      if (!canRm) {
        results.skipped += 1;
        if (details) results.row_log.push({ excel_row: excelRow, kind: 'raw_material', action: 'skipped', reason: 'forbidden' });
        continue;
      }
      if (importProfile === 'rm_multi_sheet') {
        await upsertRawMaterialMultiSheetRow(
          {
            sku,
            description,
            excelRow,
            sheetName: r.sheet_name ?? r.sheetName ?? '',
            inci: r.inci_name ?? r.inciName ?? r.inci ?? '',
            categoryCol: r.category ?? r.category_col ?? '',
            subCategoryCol: r.sub_category ?? r.subCategory ?? '',
            uom: r.uom ?? r.unit ?? '',
            hsnCode: r.hsn_code ?? r.hsnCode ?? '',
            gstPct: r.gst_pct ?? r.gstPct ?? r.gst ?? '',
            purchaseRate: r.purchase_rate_inr ?? r.purchaseRateInr ?? r.purchase_rate ?? '',
          },
          results,
          details
        );
      } else {
        await upsertRawMaterialRow({ sku, description, excelRow }, results, details);
      }
    }
  }

  const anyMutation =
    results.packaging_created + results.packaging_updated + results.raw_created + results.raw_updated > 0;
  if (anyMutation) {
    await invalidateMasterListCaches();
  }

  return results;
}

async function postItemReferenceBulkChunk(req, res) {
  try {
    const user = req.user;
    if (!user) return res.sendStatus(401);

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
    const maxChunk = 200;
    if (rowsIn.length > maxChunk) {
      return res.status(400).json({ error: `At most ${maxChunk} rows per chunk` });
    }

    const results = await executeItemReferenceBulkRows(rowsIn, user, details);

    const pctAcrossChunks = Math.min(100, Math.round(((chunkIndex + 1) / chunkTotal) * 100));

    return res.json({
      chunk_index: chunkIndex,
      chunk_total: chunkTotal,
      percent_complete: pctAcrossChunks,
      summary: {
        packaging_created: results.packaging_created,
        packaging_updated: results.packaging_updated,
        raw_material_created: results.raw_created,
        raw_material_updated: results.raw_updated,
        skipped: results.skipped,
        errors: results.errors,
      },
      ...(details ? { row_log: results.row_log } : {}),
    });
  } catch (err) {
    console.error('postItemReferenceBulkChunk error', err);
    return res.status(500).json({ error: err.message || 'Bulk chunk failed' });
  }
}

module.exports = { postItemReferenceBulkChunk, executeItemReferenceBulkRows, userAllows };

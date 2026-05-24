const { Op } = require('sequelize');
const db = require('../../db');
const GoodsReceivedNote = require('./models');

let grnLocationZoneColumnEnsured = false;
async function ensureGrnLocationZoneColumn() {
  if (grnLocationZoneColumnEnsured) return;
  grnLocationZoneColumnEnsured = true;
  try {
    const dialect = db.getDialect && db.getDialect();
    if (dialect === 'postgres') {
      await db.query(
        'ALTER TABLE goods_received_notes ADD COLUMN IF NOT EXISTS location_zone VARCHAR(200)'
      );
    }
  } catch (e) {
    console.warn('[grn] ensure location_zone column skipped:', e && e.message ? e.message : e);
  }
}

let warehouseInventoryZoneRackTextEnsured = false;
/** Allow multiple rack/zone labels on one inventory row (merged list, not a single slot). */
async function ensureWarehouseInventoryZoneRackTextColumns() {
  if (warehouseInventoryZoneRackTextEnsured) return;
  warehouseInventoryZoneRackTextEnsured = true;
  try {
    const dialect = db.getDialect && db.getDialect();
    if (dialect === 'postgres') {
      await db.query(`
        ALTER TABLE warehouse_inventory
          ALTER COLUMN zone TYPE TEXT,
          ALTER COLUMN rack TYPE TEXT
      `);
    }
  } catch (e) {
    console.warn(
      '[grn] ensure warehouse_inventory zone/rack TEXT columns skipped:',
      e && e.message ? e.message : e
    );
  }
}

const { User } = require('../users/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { Product } = require('../products/models');
const PurchaseOrder = require('../purchaseOrders/models');
const WarehouseInventory = require('../warehouseInventory/models');
const { mergeLocationTokens } = require('../warehouseInventory/locationTokensMerge');
const { logLocationMovement } = require('../warehouseInventory/locationHistoryHelpers');
const { applyWhInboundStock } = require('./applyWhInboundStock');
const { quantityToKg } = require('../warehouseInventory/quantityToKg');
const { WarehouseLocation, WarehouseRack } = require('../warehouseLocations/models');

/** Usertypes that have order-management (warehouse/GRN) access — can be assigned to GRN. */
const ASSIGNABLE_USERTYPES = ['super_admin', 'admin', 'bd_manager'];

/**
 * GET /api/v1/grn/assignable-users — users with correct permissions for "Assigned To" dropdown.
 * Returns [{ id, email, displayName }] for staff who can be assigned to a GRN.
 */
async function assignableUsers(req, res) {
  try {
    const users = await User.findAll({
      where: { usertype: ASSIGNABLE_USERTYPES },
      attributes: ['userid', 'email', 'fname', 'lname', 'display_name'],
      order: [['display_name', 'ASC'], ['fname', 'ASC']],
    });
    const list = users.map((u) => {
      const d = u.get ? u.get({ plain: true }) : u;
      const displayName = d.display_name && d.display_name.trim() ? d.display_name.trim() : [d.fname, d.lname].filter(Boolean).join(' ') || d.email || `User ${d.userid}`;
      return {
        id: d.userid,
        email: d.email || '',
        displayName,
      };
    });
    res.json(list);
  } catch (err) {
    console.error('[grn] assignableUsers error:', err);
    res.status(500).json({ error: err.message || 'Failed to list assignable users' });
  }
}

/**
 * Enrich line_items from RM/PM/Product masters: resolve item, itemCode; set diff = rcvdQty - poQty; auto Hold when diff < 0 (shortfall).
 *
 * @param {Array} lineItems - raw line_items (may have raw_material_id, pack_material_id, product_id)
 * @param {{ [id: string]: { code: string, name: string } }} rmMap
 * @param {{ [id: string]: { code: string, name: string } }} pmMap - name from description
 * @param {{ [id: string]: { code: string, name: string } }} productMap - Product uses product_id
 * @param {string|null} [grnType] - 'RM' | 'PM' | null. When the GRN type is known, the matching FK
 *   wins even if a stale FK from the other side is also present on the line. This is what stops
 *   legacy contaminated rows (PM line carrying both raw_material_id=AQUA AND pack_material_id=PM)
 *   from displaying as the wrong master in the warehouse Inbound list.
 */
function enrichLineItems(lineItems, rmMap, pmMap, productMap, grnType) {
  if (!Array.isArray(lineItems)) return [];
  const typeU = String(grnType || '').trim().toUpperCase();
  return lineItems.map((line) => {
    const poQty = Number(line.poQty ?? line.po_qty) || 0;
    const rcvdQty = Number(line.rcvdQty ?? line.rcvd_qty) || 0;
    const diff = rcvdQty - poQty;
    let item = line.item || '';
    let itemCode = line.itemCode || '';
    const rmHit = line.raw_material_id != null ? rmMap[String(line.raw_material_id)] : null;
    const pmHit = line.pack_material_id != null ? pmMap[String(line.pack_material_id)] : null;
    const productHit = line.product_id != null ? productMap[String(line.product_id)] : null;
    let preferred = null;
    if (typeU === 'PM' && pmHit) preferred = pmHit;
    else if (typeU === 'RM' && rmHit) preferred = rmHit;
    else if (rmHit) preferred = rmHit;
    else if (pmHit) preferred = pmHit;
    else if (productHit) preferred = productHit;
    if (preferred) {
      item = preferred.name || item;
      itemCode = preferred.code || itemCode;
    }
    const qcStatus = diff < 0 ? 'Hold' : (line.qcStatus || 'Pending');
    return {
      id: line.id,
      raw_material_id: line.raw_material_id,
      pack_material_id: line.pack_material_id,
      product_id: line.product_id,
      item,
      itemCode,
      poQty,
      rcvdQty,
      invoiceQty: Number(line.invoiceQty) || 0,
      unitPrice: Number(line.unitPrice) || 0,
      diff,
      qcStatus,
      qcBy: line.qcBy || '',
    };
  });
}

async function getMastersForLineItems(rows) {
  const lineItems = (rows || []).flatMap((r) => {
    const d = r.get ? r.get({ plain: true }) : r;
    return d.line_items || [];
  });
  const rmIds = [...new Set(lineItems.map((l) => l.raw_material_id).filter(Boolean))];
  const pmIds = [...new Set(lineItems.map((l) => l.pack_material_id).filter(Boolean))];
  const productIds = [...new Set(lineItems.map((l) => l.product_id).filter(Boolean))];
  const [rms, pms, products] = await Promise.all([
    rmIds.length ? RawMaterial.findAll({ where: { id: rmIds }, attributes: ['id', 'code', 'name'] }) : [],
    pmIds.length ? PackMaterial.findAll({ where: { id: pmIds }, attributes: ['id', 'code', 'description'] }) : [],
    productIds.length ? Product.findAll({ where: { product_id: productIds }, attributes: ['product_id', 'product_code', 'generic_name', 'brand_name'] }) : [],
  ]);
  const rmMap = {};
  rms.forEach((x) => {
    const d = x.get ? x.get({ plain: true }) : x;
    rmMap[String(d.id)] = { code: d.code || '', name: d.name || '' };
  });
  const pmMap = {};
  pms.forEach((x) => {
    const d = x.get ? x.get({ plain: true }) : x;
    pmMap[String(d.id)] = { code: d.code || '', name: d.description || '' };
  });
  const productMap = {};
  products.forEach((x) => {
    const d = x.get ? x.get({ plain: true }) : x;
    const name = [d.generic_name, d.brand_name].filter(Boolean).join(' ') || d.product_code || '';
    productMap[String(d.product_id)] = { code: d.product_code || '', name };
  });
  return { rmMap, pmMap, productMap };
}

function extractMasterCodeFromText(text) {
  if (!text) return '';
  const s = String(text);
  const m = s.match(/EI-[A-Z0-9-]+/i);
  if (m && m[0]) return String(m[0]).trim().toUpperCase();
  // Parenthesized fallback must look like a real master code (contain at least one digit),
  // otherwise vendor / common-name suffixes like "(ROMAT)", "(ALCH)" get mistaken for codes
  // and route a GRN line to the wrong RM/PM master row.
  const m2 = s.match(/\(([A-Z0-9-]+)\)/);
  if (m2 && m2[1] && /[0-9]/.test(m2[1])) return String(m2[1]).trim().toUpperCase();
  return '';
}

/** purchase_orders.items rows use itemCode/itemName; older shapes use code/name. */
function normalizePurchaseOrderLineItem(poItem) {
  const p = poItem && typeof poItem === 'object' ? poItem : {};
  const code = String(p.code ?? p.itemCode ?? p.item_code ?? '').trim();
  const name = String(p.name ?? p.itemName ?? p.item_name ?? '').trim();
  const qty = Number(p.quantity_requested ?? p.quantity ?? p.qty ?? 0) || 0;
  const unitPrice = Number(p.planned_unit_price ?? p.rate ?? p.price ?? 0) || 0;
  return {
    raw_material_id: p.raw_material_id ?? null,
    pack_material_id: p.pack_material_id ?? null,
    product_id: p.product_id ?? null,
    code,
    name,
    qty,
    unit: String(p.unit ?? p.Unit ?? p.UOM ?? p.uom ?? '').trim(),
    unitPrice,
  };
}

/**
 * Prefer EI-code embedded in display text (e.g. "Name (EI-RM-ACT-00012)") over a stale itemCode field
 * so split-PO / mis-keyed lines still post to the correct RM/PM bucket.
 */
function resolveLineItemMasterCode(line) {
  const fromText = extractMasterCodeFromText(line?.item ?? line?.item_text ?? '');
  const fromField = String(line?.itemCode ?? line?.item_code ?? '').trim().toUpperCase();
  return fromText || fromField;
}

/**
 * Repair wrong RM/PM links in persisted line_items using itemCode/name.
 * This specifically fixes split-PO GRNs where index-based mapping may attach
 * the first PR line ids to all GRN lines.
 */
async function repairLineItemsMasterLinks(rows, transaction) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const allLines = rows.flatMap((r) => {
    const d = r.get ? r.get({ plain: true }) : r;
    return Array.isArray(d.line_items) ? d.line_items : [];
  });
  if (allLines.length === 0) return rows;

  const codeSet = new Set();
  const nameSet = new Set();
  allLines.forEach((line) => {
    const code = resolveLineItemMasterCode(line);
    const name = String(line.item ?? '')
      .split('(')[0]
      .trim()
      .toLowerCase();
    if (code) codeSet.add(code);
    if (name) nameSet.add(name);
  });

  const codes = [...codeSet];
  const names = [...nameSet];
  if (!codes.length && !names.length) return rows;

  const rmWhere = codes.length > 0 && names.length > 0
    ? { [Op.or]: [{ code: { [Op.in]: codes } }, { name: { [Op.in]: names } }] }
    : (codes.length > 0 ? { code: { [Op.in]: codes } } : { name: { [Op.in]: names } });
  const pmWhere = codes.length > 0 && names.length > 0
    ? { [Op.or]: [{ code: { [Op.in]: codes } }, { description: { [Op.in]: names } }] }
    : (codes.length > 0 ? { code: { [Op.in]: codes } } : { description: { [Op.in]: names } });

  const [rms, pms] = await Promise.all([
    RawMaterial.findAll({ where: rmWhere, attributes: ['id', 'code', 'name'], ...(transaction ? { transaction } : {}) }),
    PackMaterial.findAll({ where: pmWhere, attributes: ['id', 'code', 'description'], ...(transaction ? { transaction } : {}) }),
  ]);

  const rmByCode = {};
  const rmByName = {};
  const pmByCode = {};
  const pmByName = {};
  rms.forEach((r) => {
    const d = r.get ? r.get({ plain: true }) : r;
    if (d.code) rmByCode[String(d.code).trim().toUpperCase()] = Number(d.id);
    if (d.name) rmByName[String(d.name).trim().toLowerCase()] = Number(d.id);
  });
  pms.forEach((p) => {
    const d = p.get ? p.get({ plain: true }) : p;
    if (d.code) pmByCode[String(d.code).trim().toUpperCase()] = Number(d.id);
    if (d.description) pmByName[String(d.description).trim().toLowerCase()] = Number(d.id);
  });

  await Promise.all(rows.map(async (row) => {
    const d = row.get ? row.get({ plain: true }) : row;
    const existing = Array.isArray(d.line_items) ? d.line_items : [];
    if (!existing.length) return;
    let changed = false;
    const grnType = String(d.type || '').toUpperCase();
    const next = existing.map((line) => {
      const code =
        extractMasterCodeFromText(line.item ?? line.item_text ?? '') ||
        String(line.itemCode ?? line.item_code ?? '').trim().toUpperCase();
      const name = String(line.item ?? '')
        .split('(')[0]
        .trim()
        .toLowerCase();
      const resolvedRm = rmByCode[code] ?? (name ? rmByName[name] : undefined);
      const resolvedPm = pmByCode[code] ?? (name ? pmByName[name] : undefined);
      const currentRm = line.raw_material_id != null ? Number(line.raw_material_id) : null;
      const currentPm = line.pack_material_id != null ? Number(line.pack_material_id) : null;
      // Only repair when the line is missing its FK. If a FK is already present, trust it —
      // overwriting with name-resolved twins (e.g. trade name "LICORICE EXTRACT (ROMAT)"
      // stripped to "LICORICE EXTRACT") can silently re-point lines at the wrong master.
      const rmFkPresent = currentRm != null && !Number.isNaN(currentRm);
      const pmFkPresent = currentPm != null && !Number.isNaN(currentPm);
      let updated = line;
      if (grnType === 'RM' && resolvedRm != null && !rmFkPresent) {
        updated = { ...line, raw_material_id: Number(resolvedRm) };
        if (updated.pack_material_id != null) delete updated.pack_material_id;
        changed = true;
      } else if (grnType === 'PM' && resolvedPm != null && !pmFkPresent) {
        updated = { ...line, pack_material_id: Number(resolvedPm) };
        if (updated.raw_material_id != null) delete updated.raw_material_id;
        changed = true;
      } else if (resolvedRm != null && !rmFkPresent && !pmFkPresent) {
        updated = { ...line, raw_material_id: Number(resolvedRm) };
        changed = true;
      } else if (resolvedPm != null && !rmFkPresent && !pmFkPresent) {
        updated = { ...line, pack_material_id: Number(resolvedPm) };
        changed = true;
      }
      return updated;
    });
    if (changed) {
      await row.update({ line_items: next }, transaction ? { transaction } : {});
    }
  }));

  return rows;
}

function formatRow(r, enrichedLineItems) {
  if (!r) return null;
  const d = r.get ? r.get({ plain: true }) : r;
  const lineItems = enrichedLineItems !== undefined ? enrichedLineItems : (d.line_items || []);
  return {
    id: String(d.id),
    grnNo: d.grn_no,
    poNo: d.po_no || '',
    vendor: d.vendor || '',
    type: d.type || 'RM',
    items: d.items != null ? Number(d.items) : 0,
    poValue: d.po_value != null ? Number(d.po_value) : 0,
    expectedDate: d.expected_date || '',
    receivedDate: d.received_date || null,
    assignedTo: d.assigned_to || '',
    qcStatus: d.qc_status || 'Pending',
    qcBy: d.qc_by || '',
    status: d.status || 'Pending',
    lineItems,
    workflowSteps: d.workflow_steps || [],
    invoiceNo: d.invoice_no || null,
    invoiceAmount: d.invoice_amount != null ? Number(d.invoice_amount) : null,
    grnDate: d.grn_date || null,
    noOfBoxes: d.no_of_boxes != null ? Number(d.no_of_boxes) : null,
    unitsPerBox: d.units_per_box != null ? Number(d.units_per_box) : null,
    lastBoxUnits: d.last_box_units != null ? Number(d.last_box_units) : null,
    locationPrefix: d.location_prefix || null,
    locationZone: d.location_zone || null,
    grnBatchMfg: d.grn_batch_mfg || null,
    expiry: d.expiry || null,
    mfgBatch: d.mfg_batch || null,
    generatedLabels: d.generated_labels || null,
  };
}

/**
 * GET /api/v1/grn — list all GRNs.
 */
async function list(req, res) {
  try {
    await ensureGrnLocationZoneColumn();
    const rows = await GoodsReceivedNote.findAll({
      order: [['expected_date', 'DESC'], ['id', 'DESC']],
    });
    await repairLineItemsMasterLinks(rows);
    const { rmMap, pmMap, productMap } = await getMastersForLineItems(rows);
    const out = rows.map((r) => {
      const d = r.get ? r.get({ plain: true }) : r;
      const enriched = enrichLineItems(d.line_items || [], rmMap, pmMap, productMap, d.type);
      return formatRow(r, enriched);
    });
    res.json(out);
  } catch (err) {
    console.error('[grn] list error:', err);
    res.status(500).json({ error: err.message || 'Failed to list GRNs' });
  }
}

/**
 * GET /api/v1/grn/:id — get one GRN by id.
 */
async function getById(req, res) {
  try {
    await ensureGrnLocationZoneColumn();
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await GoodsReceivedNote.findByPk(id);
    if (!row) return res.status(404).json({ error: 'GRN not found' });
    await repairLineItemsMasterLinks([row]);
    const { rmMap, pmMap, productMap } = await getMastersForLineItems([row]);
    const d = row.get ? row.get({ plain: true }) : row;
    const enriched = enrichLineItems(d.line_items || [], rmMap, pmMap, productMap, d.type);
    res.json(formatRow(row, enriched));
  } catch (err) {
    console.error('[grn] getById error:', err);
    res.status(500).json({ error: err.message || 'Failed to get GRN' });
  }
}

/**
 * POST /api/v1/grn — create GRN. Body: grnNo, purchase_order_id?, po_no?, vendor?, type?, items?, po_value?, expected_date?, received_date?, assigned_to?, qc_status?, status?, line_items?, workflow_steps?, invoice_no?, invoice_amount?, grn_date?
 */
async function create(req, res) {
  try {
    const body = req.body || {};
    const payload = {
      grn_no: body.grnNo || body.grn_no,
      purchase_order_id: body.purchase_order_id != null ? body.purchase_order_id : null,
      po_no: body.poNo ?? body.po_no,
      vendor: body.vendor,
      type: body.type || 'RM',
      items: body.items != null ? body.items : 0,
      po_value: body.poValue ?? body.po_value,
      expected_date: body.expectedDate ?? body.expected_date,
      received_date: body.receivedDate ?? body.received_date,
      assigned_to: body.assignedTo ?? body.assigned_to,
      qc_status: body.qcStatus ?? body.qc_status ?? 'Pending',
      qc_by: body.qcBy ?? body.qc_by ?? null,
      status: body.status ?? 'Pending',
      line_items: body.lineItems ?? body.line_items ?? [],
      workflow_steps: body.workflowSteps ?? body.workflow_steps ?? [],
      invoice_no: body.invoiceNo ?? body.invoice_no,
      invoice_amount: body.invoiceAmount ?? body.invoice_amount,
      grn_date: body.grnDate ?? body.grn_date,
      no_of_boxes: body.noOfBoxes ?? body.no_of_boxes,
      units_per_box: body.unitsPerBox ?? body.units_per_box,
      location_prefix: body.locationPrefix ?? body.location_prefix,
      location_zone: body.locationZone ?? body.location_zone,
      grn_batch_mfg: body.grnBatchMfg ?? body.grn_batch_mfg,
      expiry: body.expiry,
      mfg_batch: body.mfgBatch ?? body.mfg_batch,
    };
    // When a PO is referenced, do not blindly expand to all PO items.
    // If client sends line_items, keep it item-scoped (GRN can be per-item even under one PO).
    // We only use PO data to enrich/match those selected lines; fallback to all PO items
    // only when the client did not send any line_items.
    if (payload.purchase_order_id != null) {
      const po = await PurchaseOrder.findByPk(payload.purchase_order_id, { attributes: ['id', 'items'] });
      if (po) {
        const poPlain = po.get({ plain: true });
        const poItems = Array.isArray(poPlain.items) ? poPlain.items : [];
        if (poItems.length > 0) {
          const clientLines = Array.isArray(body.lineItems ?? body.line_items) ? (body.lineItems ?? body.line_items) : [];
          const sourceLines = clientLines.length > 0 ? clientLines : poItems;
          const allPm = sourceLines.every((i) => i.pack_material_id != null || i.packMaterialId != null);
          payload.type = allPm ? 'PM' : 'RM';
          // Master resolution rule for GRN line creation:
          //   1. Honour explicit raw_material_id / pack_material_id from the client. These are FKs
          //      flowing PR -> PO -> PR-line-mapper, so they're authoritative.
          //   2. Otherwise try to find a PO row whose code matches srcCode (NOT a positional fallback —
          //      `poItems[idx]` was silently mapping every PM line to the first RM row of mixed POs,
          //      which is how we ended up with PM lines stored as "AQUA" / 1000612 / raw_material_id 3411).
          //   3. PM lines never carry raw_material_id, and RM lines never carry pack_material_id. We
          //      mutually exclude them here so a stale value from one side cannot cross-contaminate
          //      the other (and through enrichLineItems, flip the display name to the wrong master).
          payload.line_items = sourceLines.map((srcLine, idx) => {
            const srcCode = String(srcLine.itemCode ?? srcLine.item_code ?? srcLine.code ?? '').trim();
            const explicitRm = srcLine.raw_material_id ?? srcLine.rawMaterialId ?? null;
            const explicitPm = srcLine.pack_material_id ?? srcLine.packMaterialId ?? null;
            // First try FK match against PO, then code match. Positional fallback is intentionally
            // dropped — it was the root cause of the "PM shows as AQUA" bug.
            const poItemByFk = poItems.find((poIt) => {
              const norm = normalizePurchaseOrderLineItem(poIt);
              if (explicitPm != null && norm.pack_material_id != null && Number(norm.pack_material_id) === Number(explicitPm)) return true;
              if (explicitRm != null && norm.raw_material_id != null && Number(norm.raw_material_id) === Number(explicitRm)) return true;
              return false;
            });
            const poItemByCode = poItemByFk || poItems.find((poIt) => {
              const norm = normalizePurchaseOrderLineItem(poIt);
              return srcCode && norm.code && srcCode === norm.code;
            });
            const norm = poItemByCode ? normalizePurchaseOrderLineItem(poItemByCode) : { code: '', name: '', qty: 0, unit: '', unitPrice: 0, raw_material_id: null, pack_material_id: null, product_id: null };
            const lineUnit =
              String(srcLine.unit ?? srcLine.UOM ?? '').trim() ||
              norm.unit ||
              (allPm ? 'PCS' : 'KG');
            // Determine which side this line belongs to. Explicit FKs win; only when both are
            // missing do we look at the matched PO line's FKs.
            const resolvedRmId = explicitRm != null
              ? Number(explicitRm)
              : (explicitPm == null && norm.raw_material_id != null ? Number(norm.raw_material_id) : null);
            const resolvedPmId = explicitPm != null
              ? Number(explicitPm)
              : (explicitRm == null && norm.pack_material_id != null ? Number(norm.pack_material_id) : null);
            const resolvedProductId = srcLine.product_id ?? srcLine.productId ?? norm.product_id ?? null;
            // For item / itemCode text, only inherit from `norm` when the matched PO row is for the
            // same master as the resolved FK. Otherwise stick to what the client sent (which itself
            // may be a synthetic code like "EI-RM-004" — that's OK; enrichLineItems will hydrate the
            // display from the master tables using the correct FK).
            const normMatchesMaster = (() => {
              if (resolvedRmId != null && norm.raw_material_id != null) return Number(norm.raw_material_id) === Number(resolvedRmId);
              if (resolvedPmId != null && norm.pack_material_id != null) return Number(norm.pack_material_id) === Number(resolvedPmId);
              return false;
            })();
            const fallbackItem = normMatchesMaster ? (norm.name || '') : '';
            const fallbackCode = normMatchesMaster ? (norm.code || '') : '';
            return {
              id: srcLine.id ?? String(Date.now() + idx),
              raw_material_id: resolvedRmId,
              pack_material_id: resolvedPmId,
              product_id: resolvedProductId,
              item: String(srcLine.item ?? '').trim() || fallbackItem,
              itemCode: srcCode || fallbackCode,
              poQty: Number(srcLine.poQty ?? srcLine.po_qty ?? norm.qty ?? 0) || 0,
              unit: lineUnit,
              rcvdQty: Number(srcLine.rcvdQty ?? srcLine.rcvd_qty ?? 0) || 0,
              invoiceQty: Number(srcLine.invoiceQty ?? srcLine.invoice_qty ?? 0) || 0,
              unitPrice: Number(srcLine.unitPrice ?? srcLine.unit_price ?? norm.unitPrice ?? 0) || 0,
              diff: 0,
              qcStatus: 'Pending',
              qcBy: '',
            };
          });
        }
      }
    }

    let row;
    await db.transaction(async (transaction) => {
      row = await GoodsReceivedNote.create(payload, { transaction });
      const st = String((row.get ? row.get('status') : row.status) || '').trim();
      if (st === 'GRN Complete') {
        await repairLineItemsMasterLinks([row], transaction);
        await row.reload({ transaction });
        await applyGrnCompletionToInventory(row, { transaction });
      }
    });
    try {
      const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
      await syncWarehouseInTransitAll();
    } catch (e) {
      console.warn('[grn] syncWarehouseInTransitAll after create failed:', e && e.message ? e.message : e);
    }
    const { rmMap, pmMap, productMap } = await getMastersForLineItems([row]);
    const d = row.get ? row.get({ plain: true }) : row;
    const enriched = enrichLineItems(d.line_items || [], rmMap, pmMap, productMap, d.type);
    res.status(201).json(formatRow(row, enriched));
  } catch (err) {
    console.error('[grn] create error:', err);
    res.status(500).json({ error: err.message || 'Failed to create GRN' });
  }
}

/**
 * When GRN status transitions to 'GRN Complete', add each line item's received qty to warehouse_inventory
 * (wh_stock and stock_in_hand) so SIH reflects in Planning / Plan Batches.
 *
 * Master resolution rule (must match the rest of the codebase):
 *   1. If line carries a valid raw_material_id / pack_material_id, USE IT. Never override with name.
 *   2. Only when the FK is missing (or points at a deleted master) fall back to itemCode, then name.
 *   3. Name collisions are common (e.g. "LICORICE EXTRACT (ROMAT)" vs "LICORICE EXTRACT") so name
 *      resolution is the last resort, not a parallel source of truth.
 */
async function applyGrnCompletionToInventory(grnRow, opts = {}) {
  const transaction = opts.transaction;
  const d = grnRow.get ? grnRow.get({ plain: true }) : grnRow;
  const lineItems = d.line_items || [];
  // #region agent log
  fetch('http://host.docker.internal:7419/ingest/d5243865-7daa-4432-a736-94efa19612b4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7da641'},body:JSON.stringify({sessionId:'7da641',runId:'apply-entry',hypothesisId:'H2',location:'grn/controller.js:applyGrnCompletionToInventory:entry',message:'applyGrnCompletionToInventory entry',data:{grnId:d.id,grnNo:d.grn_no||null,lineCount:lineItems.length,grnType:d.type||null,purchaseOrderId:d.purchase_order_id??null},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (lineItems.length === 0) {
    // #region agent log
    fetch('http://host.docker.internal:7419/ingest/d5243865-7daa-4432-a736-94efa19612b4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7da641'},body:JSON.stringify({sessionId:'7da641',runId:'apply-early',hypothesisId:'H1',location:'grn/controller.js:applyGrnCompletionToInventory:emptyLines',message:'early return: no line_items',data:{grnId:d.id,grnNo:d.grn_no||null},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return;
  }

  // Some GRN UIs embed the master code inside the display text, e.g.:
  // "Niacinamide (EI-RM-ACT-002)". When line.raw_material_id is missing/mismatched,
  // we try to extract a code from the display text to resolve the correct RM/PM.
  const extractMasterCodeFromText = (text) => {
    if (!text) return '';
    const s = String(text);
    // Prefer codes that start with "EI-" (seeded master codes).
    const m = s.match(/EI-[A-Z0-9-]+/i);
    if (m && m[0]) return m[0];
    // Parenthesized fallback must contain at least one digit so vendor/common-name
    // suffixes like "(ROMAT)" / "(ALCH)" are not mistaken for codes.
    const m2 = s.match(/\(([A-Z0-9-]+)\)/);
    if (m2 && m2[1] && /[0-9]/.test(m2[1])) return m2[1];
    return '';
  };

  const grnType = (d.type || 'RM').toUpperCase(); // 'RM' | 'PM'
  console.log('[grn] GRN Complete inventory apply START', {
    grnId: d.id,
    grnNo: d.grn_no,
    purchaseOrderId: d.purchase_order_id,
    poNo: d.po_no,
    type: d.type,
    lineCount: lineItems.length,
  });
  const codes = [
    ...new Set(
      lineItems
        .flatMap((l) => {
          const resolved = resolveLineItemMasterCode(l);
          return resolved ? [resolved] : [];
        })
        .filter(Boolean)
    ),
  ];
  const names = [
    ...new Set(
      lineItems
        .map((l) => (l.item || '').trim())
        .filter(Boolean)
        .map((s) => String(s).split('(')[0].trim())
    ),
  ];
  let rmByCode = {};
  let pmByCode = {};
  let rmByName = {};
  let pmByName = {};
  let validRmIds = new Set();
  let validPmIds = new Set();
  const rmUomById = new Map();
  const rmSgById = new Map();
  const pmMetaById = new Map();

  const mergeRmMasterRows = (rms) => {
    for (const r of rms || []) {
      const x = r.get ? r.get({ plain: true }) : r;
      validRmIds.add(Number(x.id));
      rmUomById.set(Number(x.id), x.uom || '');
      rmSgById.set(
        Number(x.id),
        x.specific_gravity != null && Number(x.specific_gravity) > 0 ? Number(x.specific_gravity) : null
      );
      if (x.code) rmByCode[String(x.code).trim().toUpperCase()] = x.id;
      if (x.name) rmByName[String(x.name).trim().toLowerCase()] = x.id;
    }
  };
  const mergePmMasterRows = (pms) => {
    for (const p of pms || []) {
      const x = p.get ? p.get({ plain: true }) : p;
      validPmIds.add(Number(x.id));
      pmMetaById.set(Number(x.id), { unit: x.unit || '', size_spec: x.size_spec || '' });
      if (x.code) pmByCode[String(x.code).trim().toUpperCase()] = x.id;
      if (x.description) pmByName[String(x.description).trim().toLowerCase()] = x.id;
    }
  };

  // FK-first: lines often carry raw_material_id / pack_material_id only (no itemCode / blank item text).
  // Previously validRmIds / validPmIds were filled only from code/name queries — when both were empty,
  // explicit IDs were never "valid" and GRN Complete skipped warehouse_inventory updates entirely.
  const explicitRmIdsFromLines = [
    ...new Set(
      lineItems
        .map((l) => (l.raw_material_id != null ? Number(l.raw_material_id) : NaN))
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ];
  const explicitPmIdsFromLines = [
    ...new Set(
      lineItems
        .map((l) => (l.pack_material_id != null ? Number(l.pack_material_id) : NaN))
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ];
  if (explicitRmIdsFromLines.length > 0 || explicitPmIdsFromLines.length > 0) {
    const [rmsById, pmsById] = await Promise.all([
      explicitRmIdsFromLines.length > 0
        ? RawMaterial.findAll({
            where: { id: { [Op.in]: explicitRmIdsFromLines } },
            attributes: ['id', 'code', 'name', 'uom', 'specific_gravity'],
            ...(transaction ? { transaction } : {}),
          })
        : Promise.resolve([]),
      explicitPmIdsFromLines.length > 0
        ? PackMaterial.findAll({
            where: { id: { [Op.in]: explicitPmIdsFromLines } },
            attributes: ['id', 'code', 'description', 'unit', 'size_spec'],
            ...(transaction ? { transaction } : {}),
          })
        : Promise.resolve([]),
    ]);
    mergeRmMasterRows(rmsById);
    mergePmMasterRows(pmsById);
  }

  if (codes.length > 0 || names.length > 0) {
    const rmWhere = codes.length > 0 && names.length > 0 ? { [Op.or]: [{ code: { [Op.in]: codes } }, { name: { [Op.in]: names } }] } : (codes.length > 0 ? { code: { [Op.in]: codes } } : { name: { [Op.in]: names } });
    const pmWhere = codes.length > 0 && names.length > 0 ? { [Op.or]: [{ code: { [Op.in]: codes } }, { description: { [Op.in]: names } }] } : (codes.length > 0 ? { code: { [Op.in]: codes } } : { description: { [Op.in]: names } });
    const [rms, pms] = await Promise.all([
      RawMaterial.findAll({
        where: rmWhere,
        attributes: ['id', 'code', 'name', 'uom', 'specific_gravity'],
        ...(transaction ? { transaction } : {}),
      }),
      PackMaterial.findAll({ where: pmWhere, attributes: ['id', 'code', 'description', 'unit', 'size_spec'], ...(transaction ? { transaction } : {}) }),
    ]);
    mergeRmMasterRows(rms);
    mergePmMasterRows(pms);
  }

  const toAddByRm = new Map(); // raw_material_id -> kg to add
  const toAddByPm = new Map(); // pack_material_id -> kg to add
  const toAddByProduct = new Map(); // product_id -> kg to add

  for (const line of lineItems) {
    // Some GRNs (e.g. created from Procurement) may arrive with rcvdQty=0 and rely
    // on the warehouse UI to update quantities before marking "GRN Complete".
    // To avoid "GRN Complete" not moving stock due to missing/zero received qty,
    // fall back to poQty when rcvdQty is missing/zero.
    const rawRcvdQty = Number(line.rcvdQty ?? line.rcvd_qty);
    let rcvdQty = Math.max(0, Number.isFinite(rawRcvdQty) ? (rawRcvdQty || 0) : 0);
    if (rcvdQty === 0) {
      const poQtyFallback = Math.max(0, Number(line.poQty ?? line.po_qty ?? 0) || 0);
      if (poQtyFallback > 0) {
        rcvdQty = poQtyFallback;
        console.warn('[grn] GRN Complete: rcvdQty was 0/missing; using poQty fallback', {
          itemCode: line.itemCode ?? line.item_code ?? null,
          item: line.item ?? null,
          poQty: poQtyFallback,
        });
      }
    }
    if (rcvdQty === 0) continue;
    const lineUnit = String(line.unit ?? line.UOM ?? '').trim() || (grnType === 'PM' ? 'PCS' : 'KG');
    const code = String(resolveLineItemMasterCode(line) || '').trim().toUpperCase();

    console.log('[grn] GRN Complete line resolved (qty -> WH)', {
      grnId: d.id,
      itemCode: code || null,
      item: line.item || null,
      poQty: Number(line.poQty ?? line.po_qty) || 0,
      rcvdQtyUsed: rcvdQty,
      lineUnit,
      raw_material_id: line.raw_material_id ?? null,
      pack_material_id: line.pack_material_id ?? null,
      product_id: line.product_id ?? null,
    });

    const explicitRmId = line.raw_material_id != null ? Number(line.raw_material_id) : null;
    const explicitPmId = line.pack_material_id != null ? Number(line.pack_material_id) : null;
    const explicitRmIdValid = explicitRmId != null && !Number.isNaN(explicitRmId) && validRmIds.has(explicitRmId);
    const explicitPmIdValid = explicitPmId != null && !Number.isNaN(explicitPmId) && validPmIds.has(explicitPmId);
    const nameKey = String(line.item || '')
      .split('(')[0]
      .trim()
      .toLowerCase();
    const resolvedRmId = rmByCode[code] ?? (nameKey ? rmByName[nameKey] : undefined);
    const resolvedPmId = pmByCode[code] ?? (nameKey ? pmByName[nameKey] : undefined);

    if (line.product_id != null) {
      const id = line.product_id;
      const kg = quantityToKg(rcvdQty, lineUnit, { itemType: 'PR' });
      toAddByProduct.set(id, (toAddByProduct.get(id) || 0) + kg);
    } else if (code || (line.item && String(line.item).trim()) || explicitRmIdValid || explicitPmIdValid) {
      // Prefer the explicit raw_material_id / pack_material_id when it points at a real master row.
      // Falling back to name resolution (e.g. "LICORICE EXTRACT (ROMAT)" -> "LICORICE EXTRACT")
      // can otherwise route stock to a same-named twin RM and silently dump qty into the wrong row.
      const rmId = explicitRmIdValid
        ? explicitRmId
        : (resolvedRmId != null ? resolvedRmId : null);
      const pmId = explicitPmIdValid
        ? explicitPmId
        : (resolvedPmId != null ? resolvedPmId : null);

      if (explicitRmIdValid && resolvedRmId != null && Number(explicitRmId) !== Number(resolvedRmId)) {
        console.warn('[grn] RM id mismatch on line, keeping explicit raw_material_id from line', {
          explicitRmId,
          resolvedRmId,
          itemCode: code || null,
          item: line.item || null,
        });
      }
      if (explicitPmIdValid && resolvedPmId != null && Number(explicitPmId) !== Number(resolvedPmId)) {
        console.warn('[grn] PM id mismatch on line, keeping explicit pack_material_id from line', {
          explicitPmId,
          resolvedPmId,
          itemCode: code || null,
          item: line.item || null,
        });
      }

      if (grnType === 'PM' && pmId != null) {
        const meta = pmMetaById.get(Number(pmId)) || { unit: '', size_spec: '' };
        const kg = quantityToKg(rcvdQty, lineUnit, { itemType: 'PM', masterUom: meta.unit, sizeSpec: meta.size_spec });
        toAddByPm.set(pmId, (toAddByPm.get(pmId) || 0) + kg);
      } else if (grnType === 'RM' && rmId != null) {
        const uom = rmUomById.get(Number(rmId)) || '';
        const kg = quantityToKg(rcvdQty, lineUnit, {
          itemType: 'RM',
          masterUom: uom,
          sizeSpec: null,
          specificGravity: rmSgById.get(Number(rmId)),
        });
        toAddByRm.set(rmId, (toAddByRm.get(rmId) || 0) + kg);
      } else if (rmId != null) {
        const uom = rmUomById.get(Number(rmId)) || '';
        const kg = quantityToKg(rcvdQty, lineUnit, {
          itemType: 'RM',
          masterUom: uom,
          sizeSpec: null,
          specificGravity: rmSgById.get(Number(rmId)),
        });
        toAddByRm.set(rmId, (toAddByRm.get(rmId) || 0) + kg);
      } else if (pmId != null) {
        const meta = pmMetaById.get(Number(pmId)) || { unit: '', size_spec: '' };
        const kg = quantityToKg(rcvdQty, lineUnit, { itemType: 'PM', masterUom: meta.unit, sizeSpec: meta.size_spec });
        toAddByPm.set(pmId, (toAddByPm.get(pmId) || 0) + kg);
      } else {
        console.warn('[grn] GRN Complete: line item code "%s" / name "%s" not found in RM/PM masters; skipping inventory update', code, line.item || '');
      }
    }
  }

  console.log('[grn] GRN Complete totals by inventory bucket', {
    toAddByRm: Array.from(toAddByRm.entries()),
    toAddByPm: Array.from(toAddByPm.entries()),
    toAddByProduct: Array.from(toAddByProduct.entries()),
  });

  // #region agent log
  fetch('http://host.docker.internal:7419/ingest/d5243865-7daa-4432-a736-94efa19612b4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7da641'},body:JSON.stringify({sessionId:'7da641',runId:'apply-buckets',hypothesisId:'H2',location:'grn/controller.js:applyGrnCompletionToInventory:buckets',message:'bucket totals before WH writes',data:{grnId:d.id,toAddByRmCount:toAddByRm.size,toAddByPmCount:toAddByPm.size,toAddByProductCount:toAddByProduct.size,rmEntries:Array.from(toAddByRm.entries()),codesLen:codes.length,namesLen:names.length},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (toAddByRm.size === 0 && toAddByPm.size === 0 && toAddByProduct.size === 0) {
    console.warn('[grn] GRN Complete: nothing to add into warehouse_inventory (bucket maps empty)', {
      grnId: d.id,
      grnNo: d.grn_no,
      poNo: d.po_no,
      type: d.type,
      resolvedCodes: codes,
      resolvedNames: names,
      lineItemsDebug: lineItems.map((li) => ({
        itemCode: li.itemCode ?? li.item_code ?? null,
        item: li.item ?? null,
        poQty: li.poQty ?? null,
        rcvdQty: li.rcvdQty ?? li.rcvd_qty ?? null,
        raw_material_id: li.raw_material_id ?? null,
        pack_material_id: li.pack_material_id ?? null,
        product_id: li.product_id ?? null,
      })),
    });
  }

  for (const [rawMaterialId, qty] of toAddByRm) {
    let whRow = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rawMaterialId }, ...(transaction ? { transaction } : {}) });
    if (!whRow) {
      whRow = await WarehouseInventory.create({
        item_type: 'RM',
        raw_material_id: rawMaterialId,
        pack_material_id: null,
        product_id: null,
        wh_stock: 0,
        wh_unit: 'KG',
        ml1_stock: 0,
        ml2_stock: 0,
        stock_in_hand: 0,
        reserved: 0,
        in_transit: 0,
        reorder_pt: 0,
        avg_mo: 0,
        qc_status: 'In Stock',
      }, transaction ? { transaction } : {});
      console.log('[grn] GRN Complete: created RM warehouse_inventory id=%d', rawMaterialId);
    }
    whRow = await applyWhInboundStock(
      whRow,
      qty,
      { rawMaterialId },
      { transaction, grnId: d.id }
    );
    console.log('[grn] GRN Complete: added RM id=%d qty=%s', rawMaterialId, qty);

    const plainWh = whRow.get ? whRow.get({ plain: true }) : whRow;
    await logLocationMovement({
      warehouseInventoryId: plainWh.id,
      itemType: plainWh.item_type,
      rawMaterialId: plainWh.raw_material_id,
      packMaterialId: plainWh.pack_material_id,
      productId: plainWh.product_id,
      fromZone: null,
      fromRack: null,
      toZone: plainWh.zone || null,
      toRack: plainWh.rack || null,
      qtyDelta: qty,
      actionType: 'GRN_IN',
      sourceGrnId: d.id,
      transaction,
    });
  }

  for (const [packMaterialId, qty] of toAddByPm) {
    let whRow = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: packMaterialId }, ...(transaction ? { transaction } : {}) });
    if (!whRow) {
      whRow = await WarehouseInventory.create({
        item_type: 'PM',
        raw_material_id: null,
        pack_material_id: packMaterialId,
        product_id: null,
        wh_stock: 0,
        wh_unit: 'KG',
        ml1_stock: 0,
        ml2_stock: 0,
        stock_in_hand: 0,
        reserved: 0,
        in_transit: 0,
        reorder_pt: 0,
        avg_mo: 0,
        qc_status: 'In Stock',
      }, transaction ? { transaction } : {});
      console.log('[grn] GRN Complete: created PM warehouse_inventory id=%d', packMaterialId);
    }
    whRow = await applyWhInboundStock(
      whRow,
      qty,
      { packMaterialId },
      { transaction, grnId: d.id }
    );
    console.log('[grn] GRN Complete: added PM id=%d qty=%s', packMaterialId, qty);

    const plainWh = whRow.get ? whRow.get({ plain: true }) : whRow;
    await logLocationMovement({
      warehouseInventoryId: plainWh.id,
      itemType: plainWh.item_type,
      rawMaterialId: plainWh.raw_material_id,
      packMaterialId: plainWh.pack_material_id,
      productId: plainWh.product_id,
      fromZone: null,
      fromRack: null,
      toZone: plainWh.zone || null,
      toRack: plainWh.rack || null,
      qtyDelta: qty,
      actionType: 'GRN_IN',
      sourceGrnId: d.id,
      transaction,
    });
  }

  for (const [productId, qty] of toAddByProduct) {
    let whRow = await WarehouseInventory.findOne({ where: { item_type: 'PR', product_id: productId }, ...(transaction ? { transaction } : {}) });
    if (!whRow) {
      whRow = await WarehouseInventory.create({
        item_type: 'PR',
        raw_material_id: null,
        pack_material_id: null,
        product_id: productId,
        wh_stock: 0,
        wh_unit: 'KG',
        ml1_stock: 0,
        ml2_stock: 0,
        stock_in_hand: 0,
        reserved: 0,
        in_transit: 0,
        reorder_pt: 0,
        avg_mo: 0,
        qc_status: 'In Stock',
      }, transaction ? { transaction } : {});
      console.log('[grn] GRN Complete: created PR warehouse_inventory product_id=%d', productId);
    }
    whRow = await applyWhInboundStock(
      whRow,
      qty,
      { productId },
      { transaction, grnId: d.id }
    );
    console.log('[grn] GRN Complete: added PR product_id=%d qty=%s', productId, qty);

    const plainWh = whRow.get ? whRow.get({ plain: true }) : whRow;
    await logLocationMovement({
      warehouseInventoryId: plainWh.id,
      itemType: plainWh.item_type,
      rawMaterialId: plainWh.raw_material_id,
      packMaterialId: plainWh.pack_material_id,
      productId: plainWh.product_id,
      fromZone: null,
      fromRack: null,
      toZone: plainWh.zone || null,
      toRack: plainWh.rack || null,
      qtyDelta: qty,
      actionType: 'GRN_IN',
      sourceGrnId: d.id,
      transaction,
    });
  }

  console.log('[grn] GRN Complete inventory apply END', {
    grnId: d.id,
    grnNo: d.grn_no,
    purchaseOrderId: d.purchase_order_id,
    poNo: d.po_no,
    type: d.type,
  });
  // #region agent log
  fetch('http://host.docker.internal:7419/ingest/d5243865-7daa-4432-a736-94efa19612b4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7da641'},body:JSON.stringify({sessionId:'7da641',runId:'apply-done',hypothesisId:'H6',location:'grn/controller.js:applyGrnCompletionToInventory:done',message:'applyGrnCompletionToInventory finished without throw',data:{grnId:d.id,grnNo:d.grn_no||null},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
}

/**
 * PUT /api/v1/grn/:id — update GRN. Body: any of assigned_to, grn_date, received_date, qc_status, status, line_items, workflow_steps, invoice_no, invoice_amount.
 */
async function update(req, res) {
  try {
    await ensureGrnLocationZoneColumn();
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await GoodsReceivedNote.findByPk(id);
    if (!row) return res.status(404).json({ error: 'GRN not found' });
    const body = req.body || {};
    const updates = {};
    if (body.assignedTo !== undefined) updates.assigned_to = body.assignedTo;
    if (body.assigned_to !== undefined) updates.assigned_to = body.assigned_to;
    if (body.grnDate !== undefined) updates.grn_date = body.grnDate;
    if (body.grn_date !== undefined) updates.grn_date = body.grn_date;
    if (body.receivedDate !== undefined) updates.received_date = body.receivedDate;
    if (body.received_date !== undefined) updates.received_date = body.received_date;
    if (body.qcStatus !== undefined) updates.qc_status = body.qcStatus;
    if (body.qc_status !== undefined) updates.qc_status = body.qc_status;
    if (body.qcBy !== undefined) updates.qc_by = body.qcBy;
    if (body.qc_by !== undefined) updates.qc_by = body.qc_by;
    if (body.status !== undefined) updates.status = body.status;
    if (body.lineItems !== undefined) updates.line_items = body.lineItems;
    if (body.line_items !== undefined) updates.line_items = body.line_items;
    if (body.workflowSteps !== undefined) updates.workflow_steps = body.workflowSteps;
    if (body.workflow_steps !== undefined) updates.workflow_steps = body.workflow_steps;
    if (body.invoiceNo !== undefined) updates.invoice_no = body.invoiceNo;
    if (body.invoice_no !== undefined) updates.invoice_no = body.invoice_no;
    if (body.invoiceAmount !== undefined) updates.invoice_amount = body.invoiceAmount;
    if (body.invoice_amount !== undefined) updates.invoice_amount = body.invoice_amount;
    if (body.noOfBoxes !== undefined) updates.no_of_boxes = body.noOfBoxes;
    if (body.no_of_boxes !== undefined) updates.no_of_boxes = body.no_of_boxes;
    if (body.unitsPerBox !== undefined) updates.units_per_box = body.unitsPerBox;
    if (body.units_per_box !== undefined) updates.units_per_box = body.units_per_box;
    if (body.lastBoxUnits !== undefined) updates.last_box_units = body.lastBoxUnits;
    if (body.last_box_units !== undefined) updates.last_box_units = body.last_box_units;
    if (body.locationPrefix !== undefined) updates.location_prefix = body.locationPrefix;
    if (body.location_prefix !== undefined) updates.location_prefix = body.location_prefix;
    if (body.locationZone !== undefined) updates.location_zone = body.locationZone;
    if (body.location_zone !== undefined) updates.location_zone = body.location_zone;
    if (body.grnBatchMfg !== undefined) updates.grn_batch_mfg = body.grnBatchMfg;
    if (body.grn_batch_mfg !== undefined) updates.grn_batch_mfg = body.grn_batch_mfg;
    if (body.expiry !== undefined) updates.expiry = body.expiry;
    if (body.mfgBatch !== undefined) updates.mfg_batch = body.mfgBatch;
    if (body.mfg_batch !== undefined) updates.mfg_batch = body.mfg_batch;
    const rowPlain = row.get ? row.get({ plain: true }) : row;
    const nextStatus = updates.status !== undefined ? updates.status : rowPlain.status;
    const nextQcStatus = updates.qc_status !== undefined ? updates.qc_status : rowPlain.qc_status;
    const nextQcByRaw = updates.qc_by !== undefined ? updates.qc_by : rowPlain.qc_by;
    const nextAssignedToRaw = updates.assigned_to !== undefined ? updates.assigned_to : rowPlain.assigned_to;
    const nextWorkflowSteps = updates.workflow_steps !== undefined ? updates.workflow_steps : rowPlain.workflow_steps;
    const nextGeneratedLabels = rowPlain.generated_labels;
    if (nextStatus === 'GRN Complete') {
      const blockers = [];
      if (String(nextQcStatus || '').trim() !== 'Passed') blockers.push('QC status must be Passed');
      if (!String(nextQcByRaw || '').trim()) blockers.push('QC by (inspector name) is required');
      if (!String(nextAssignedToRaw || '').trim()) blockers.push('Assigned To must be allocated');
      const hasLabelGenerationStep = Array.isArray(nextWorkflowSteps) && nextWorkflowSteps.includes('Label Generation');
      const hasGeneratedLabels = Array.isArray(nextGeneratedLabels) && nextGeneratedLabels.length > 0;
      if (!hasLabelGenerationStep && !hasGeneratedLabels) blockers.push('QR labels must be generated');
      const nextLocPrefix =
        updates.location_prefix !== undefined ? updates.location_prefix : rowPlain.location_prefix;
      const nextLocZone =
        updates.location_zone !== undefined ? updates.location_zone : rowPlain.location_zone;
      if (!String(nextLocPrefix || '').trim()) blockers.push('Location prefix (rack code) is required');
      if (!String(nextLocZone || '').trim()) blockers.push('Storage zone is required');
      if (blockers.length > 0) {
        return res.status(400).json({ error: `Cannot mark GRN Complete: ${blockers.join('; ')}.` });
      }
    }
    const previousStatus = (row.get ? row.get({ plain: true }) : row).status;
    // #region agent log
    fetch('http://host.docker.internal:7419/ingest/d5243865-7daa-4432-a736-94efa19612b4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7da641'},body:JSON.stringify({sessionId:'7da641',runId:'update-pre',hypothesisId:'H1',location:'grn/controller.js:update:beforeCommit',message:'GRN PUT before row.update',data:{grnId:id,previousStatus,updatesStatus:updates.status??null,willRunInventoryApply:updates.status==='GRN Complete'&&previousStatus!=='GRN Complete',lineItemsInUpdates:Array.isArray(updates.line_items)?updates.line_items.length:updates.line_items===undefined?'omit':'non-array'},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    await db.transaction(async (transaction) => {
      await row.update(updates, { transaction });
      const refreshedInTx = await GoodsReceivedNote.findByPk(id, { transaction });
      if (updates.status === 'GRN Complete' && previousStatus !== 'GRN Complete') {
        const refreshedPlain = refreshedInTx.get ? refreshedInTx.get({ plain: true }) : refreshedInTx;
        const lineItems = refreshedPlain.line_items || [];
        console.log('[grn] Status transition -> GRN Complete', {
          grnId: id,
          grnNo: refreshedPlain.grn_no,
          poNo: refreshedPlain.po_no,
          vendor: refreshedPlain.vendor,
          purchaseOrderId: refreshedPlain.purchase_order_id,
          previousStatus,
          newStatus: updates.status,
          lineCount: lineItems.length,
        });
        console.log('[grn] GRN Complete line_items payload', lineItems.map((li) => ({
          itemCode: li.itemCode ?? li.item_code ?? null,
          item: li.item ?? null,
          resolvedMasterCode: resolveLineItemMasterCode(li) || null,
          poQty: li.poQty ?? 0,
          rcvdQty: li.rcvdQty ?? li.rcvd_qty ?? null,
          raw_material_id: li.raw_material_id ?? null,
          pack_material_id: li.pack_material_id ?? null,
          product_id: li.product_id ?? null,
        })));
        await repairLineItemsMasterLinks([refreshedInTx], transaction);
        await refreshedInTx.reload({ transaction });
        // #region agent log
        const _rplain = refreshedInTx.get ? refreshedInTx.get({ plain: true }) : refreshedInTx;
        fetch('http://host.docker.internal:7419/ingest/d5243865-7daa-4432-a736-94efa19612b4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7da641'},body:JSON.stringify({sessionId:'7da641',runId:'update-invoke',hypothesisId:'H4',location:'grn/controller.js:update:beforeApplyInventory',message:'about to applyGrnCompletionToInventory',data:{grnId:id,reloadLineCount:Array.isArray(_rplain.line_items)?_rplain.line_items.length:0,statusAfterUpdate:_rplain.status},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        await applyGrnCompletionToInventory(refreshedInTx, { transaction });
        // #region agent log
        fetch('http://host.docker.internal:7419/ingest/d5243865-7daa-4432-a736-94efa19612b4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7da641'},body:JSON.stringify({sessionId:'7da641',runId:'update-post-apply',hypothesisId:'H6',location:'grn/controller.js:update:afterApplyInventory',message:'applyGrnCompletionToInventory returned OK',data:{grnId:id},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
      }
    });
    const refreshed = await GoodsReceivedNote.findByPk(id);
    if (updates.status === 'GRN Complete' && previousStatus === 'GRN Complete') {
      // #region agent log
      fetch('http://host.docker.internal:7419/ingest/d5243865-7daa-4432-a736-94efa19612b4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7da641'},body:JSON.stringify({sessionId:'7da641',runId:'update-skip-inv',hypothesisId:'H1',location:'grn/controller.js:update:skipInventoryApply',message:'GRN Complete update but inventory apply skipped (not first transition)',data:{grnId:id,previousStatus,updatesStatus:updates.status},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    }
    try {
      const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
      await syncWarehouseInTransitAll();
    } catch (e) {
      console.warn('[grn] syncWarehouseInTransitAll after update failed:', e && e.message ? e.message : e);
    }
    const { rmMap, pmMap, productMap } = await getMastersForLineItems([refreshed]);
    const d = refreshed.get ? refreshed.get({ plain: true }) : refreshed;
    const enriched = enrichLineItems(d.line_items || [], rmMap, pmMap, productMap, d.type);
    res.json(formatRow(refreshed, enriched));
  } catch (err) {
    console.error('[grn] update error:', err);
    res.status(500).json({ error: err.message || 'Failed to update GRN' });
  }
}

/**
 * DELETE /api/v1/grn/:id
 */
async function remove(req, res) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const n = await GoodsReceivedNote.destroy({ where: { id } });
    if (n === 0) return res.status(404).json({ error: 'GRN not found' });
    try {
      const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
      await syncWarehouseInTransitAll();
    } catch (e) {
      console.warn('[grn] syncWarehouseInTransitAll after delete failed:', e && e.message ? e.message : e);
    }
    res.status(204).send();
  } catch (err) {
    console.error('[grn] delete error:', err);
    res.status(500).json({ error: err.message || 'Failed to delete GRN' });
  }
}

/**
 * Persist resolved rack/zone from label generation onto warehouse_inventory for the selected line item
 * so Warehouse → Inventory shows the same location as the GRN QR payload.
 * Creates a zero-qty inventory stub if none exists yet (before GRN Complete).
 */
async function applyLabelGenerationToWarehouseInventory(grnPlain, selectedItemCode, toRack, toZone, locationPrefixRaw) {
  await ensureWarehouseInventoryZoneRackTextColumns();

  const codeU = String(selectedItemCode || '').trim().toUpperCase();
  const rackStr = String(toRack || '').trim() || String(locationPrefixRaw || '').trim() || null;
  const zoneStr = String(toZone || '').trim() || null;
  if (!rackStr && !zoneStr) return;

  const lineItems = Array.isArray(grnPlain.line_items) ? grnPlain.line_items : [];
  const grnType = (grnPlain.type || 'RM').toUpperCase();

  let line = lineItems.find((l) => {
    const ic = String(l.itemCode ?? l.item_code ?? '').trim().toUpperCase();
    const resolved = resolveLineItemMasterCode(l);
    return ic === codeU || resolved === codeU;
  });
  if (!line && lineItems.length === 1) line = lineItems[0];

  let rmId = line && line.raw_material_id != null ? Number(line.raw_material_id) : null;
  let pmId = line && line.pack_material_id != null ? Number(line.pack_material_id) : null;
  let productId = line && line.product_id != null ? Number(line.product_id) : null;

  if (
    (rmId == null || Number.isNaN(rmId)) &&
    (pmId == null || Number.isNaN(pmId)) &&
    (productId == null || Number.isNaN(productId))
  ) {
    if (grnType === 'PM') {
      const pm = await PackMaterial.findOne({ where: { code: codeU } });
      if (pm) {
        const x = pm.get ? pm.get({ plain: true }) : pm;
        pmId = Number(x.id);
      }
    } else if (grnType === 'PR') {
      const prod = await Product.findOne({ where: { product_code: codeU } });
      if (prod) {
        const x = prod.get ? prod.get({ plain: true }) : prod;
        productId = Number(x.product_id);
      }
    } else {
      const rm = await RawMaterial.findOne({ where: { code: codeU } });
      if (rm) {
        const x = rm.get ? rm.get({ plain: true }) : rm;
        rmId = Number(x.id);
      }
    }
  }

  let where = null;
  if (productId != null && !Number.isNaN(productId)) {
    where = { item_type: 'PR', product_id: productId };
  } else if (pmId != null && !Number.isNaN(pmId)) {
    where = { item_type: 'PM', pack_material_id: pmId };
  } else if (rmId != null && !Number.isNaN(rmId)) {
    where = { item_type: 'RM', raw_material_id: rmId };
  }

  if (!where) {
    console.warn('[grn] generateLabels: could not resolve warehouse_inventory master for item', codeU);
    return;
  }

  let inv = await WarehouseInventory.findOne({ where });
  if (!inv) {
    const base = {
      zone: zoneStr || null,
      rack: rackStr || null,
      wh_stock: 0,
      ml1_stock: 0,
      ml2_stock: 0,
      stock_in_hand: 0,
      reserved: 0,
      in_transit: 0,
      reorder_pt: 0,
      avg_mo: 0,
      qc_status: 'In Stock',
    };
    if (where.item_type === 'RM') {
      inv = await WarehouseInventory.create({
        ...base,
        item_type: 'RM',
        raw_material_id: where.raw_material_id,
        pack_material_id: null,
        product_id: null,
        wh_unit: 'KG',
      });
    } else if (where.item_type === 'PM') {
      inv = await WarehouseInventory.create({
        ...base,
        item_type: 'PM',
        raw_material_id: null,
        pack_material_id: where.pack_material_id,
        product_id: null,
        wh_unit: 'KG',
      });
    } else {
      inv = await WarehouseInventory.create({
        ...base,
        item_type: 'PR',
        raw_material_id: null,
        pack_material_id: null,
        product_id: where.product_id,
        wh_unit: 'KG',
      });
    }
    console.log('[grn] generateLabels: created warehouse_inventory stub for zone/rack', {
      warehouseInventoryId: inv.id,
      itemCode: codeU,
      rack: rackStr,
      zone: zoneStr,
    });
  } else {
    const plain = inv.get ? inv.get({ plain: true }) : inv;
    const patch = {};
    if (rackStr) {
      const mergedRack = mergeLocationTokens(plain.rack, rackStr);
      if (String(mergedRack || '') !== String(plain.rack || '')) patch.rack = mergedRack;
    }
    if (zoneStr) {
      const mergedZone = mergeLocationTokens(plain.zone, zoneStr);
      if (String(mergedZone || '') !== String(plain.zone || '')) patch.zone = mergedZone;
    }
    if (Object.keys(patch).length) {
      await inv.update(patch);
      console.log('[grn] generateLabels: merged warehouse_inventory zone/rack', {
        warehouseInventoryId: inv.id,
        itemCode: codeU,
        ...patch,
      });
    }
  }
}

/**
 * POST /api/v1/grn/:id/generate-labels
 * Body (optional): noOfBoxes, unitsPerBox, unitsPerBoxList,
 *                  locationPrefix, grnBatchMfg, expiry, mfgBatch, productName, itemCode.
 * Uses GRN-stored values if not in body. Generates noOfBoxes QR codes per box.
 * Also advances workflow_steps to include 'Label Generation'.
 * Returns { labels, workflowSteps }.
 */
async function generateLabels(req, res) {
  try {
    await ensureGrnLocationZoneColumn();
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await GoodsReceivedNote.findByPk(id);
    if (!row) return res.status(404).json({ error: 'GRN not found' });
    const body = req.body || {};
    const d = row.get ? row.get({ plain: true }) : row;
    const qcStatus = (d.qc_status || '').trim();
    // Block only when QC was explicitly set to something other than Passed (e.g. Rejected, Under test)
    if (qcStatus && qcStatus !== 'Passed') {
      return res.status(403).json({
        error: 'QC must be Passed before generating labels. Set QC status to Passed and save, then try again.',
      });
    }
    const noOfBoxes = body.noOfBoxes ?? body.no_of_boxes ?? d.no_of_boxes ?? 1;
    const unitsPerBox = body.unitsPerBox ?? body.units_per_box ?? d.units_per_box ?? 0;
    const unitsPerBoxListRaw = Array.isArray(body.unitsPerBoxList)
      ? body.unitsPerBoxList
      : Array.isArray(body.units_per_box_list)
        ? body.units_per_box_list
        : null;
    const locationPrefix = body.locationPrefix ?? body.location_prefix ?? d.location_prefix ?? '';
    const grnBatchMfg = body.grnBatchMfg ?? body.grn_batch_mfg ?? d.grn_batch_mfg ?? '';
    const expiry = body.expiry ?? d.expiry ?? '';
    const mfgBatch = body.mfgBatch ?? body.mfg_batch ?? d.mfg_batch ?? '';
    const productName = String(body.productName ?? '').trim();
    const itemCode = String(body.itemCode ?? '').trim();
    if (!productName || !itemCode) {
      return res.status(400).json({
        error: 'Select product / line item before generating labels.',
      });
    }

    // Populate rack + zone in the QR payload for the GRN popup preview and downstream decoding.
    // `locationPrefix` is expected to be the target rack code (e.g. `A1-L2-S3`), matching `warehouse_racks.code`.
    const desiredRackCode = String(locationPrefix || '').trim();
    let toRack = null;
    let toZone = null;
    if (desiredRackCode) {
      const rack = await WarehouseRack.findOne({
        where: { code: desiredRackCode },
        include: [{ model: WarehouseLocation, as: 'WarehouseLocation' }],
      });
      if (rack) {
        const loc =
          rack.get && rack.get({ plain: true })
            ? rack.get({ plain: true }).WarehouseLocation
            : rack.WarehouseLocation;
        const locPlain = loc && loc.get ? loc.get({ plain: true }) : loc;
        toRack = rack.code || desiredRackCode;
        toZone = locPlain?.zone_label || locPlain?.name || null;
      } else {
        // If user typed only a rack "prefix", attempt a relaxed match.
        const dialect = WarehouseRack.sequelize?.getDialect?.() || '';
        const likeOp = dialect === 'postgres' && Op.iLike ? Op.iLike : Op.like;
        const rackByPrefix = await WarehouseRack.findOne({
          where: { code: { [likeOp]: `${desiredRackCode}%` } },
          include: [{ model: WarehouseLocation, as: 'WarehouseLocation' }],
        });
        if (rackByPrefix) {
          const loc =
            rackByPrefix.get && rackByPrefix.get({ plain: true })
              ? rackByPrefix.get({ plain: true }).WarehouseLocation
              : rackByPrefix.WarehouseLocation;
          const locPlain = loc && loc.get ? loc.get({ plain: true }) : loc;
          toRack = rackByPrefix.code || desiredRackCode;
          toZone = locPlain?.zone_label || locPlain?.name || null;
        } else {
        // Fallback: if user entered a zone identifier instead of a rack code, set only zone.
          const location = await WarehouseLocation.findOne({
            where: {
              [Op.or]: [
                { zone_label: desiredRackCode },
                { code: desiredRackCode },
                { name: desiredRackCode },
              ],
            },
          });
          toZone = location?.zone_label || location?.name || null;
        }
      }
    }

    const explicitZone = String(
      body.locationZone ?? body.location_zone ?? d.location_zone ?? ''
    ).trim();
    if (explicitZone) {
      toZone = explicitZone;
    }

    const updates = {};
    if (body.noOfBoxes !== undefined) updates.no_of_boxes = body.noOfBoxes;
    if (body.unitsPerBox !== undefined) updates.units_per_box = body.unitsPerBox;
    updates.last_box_units = null;
    if (body.locationPrefix !== undefined) updates.location_prefix = body.locationPrefix;
    if (body.locationZone !== undefined) updates.location_zone = body.locationZone;
    if (body.location_zone !== undefined) updates.location_zone = body.location_zone;
    if (body.grnBatchMfg !== undefined) updates.grn_batch_mfg = body.grnBatchMfg;
    if (body.expiry !== undefined) updates.expiry = body.expiry;
    if (body.mfgBatch !== undefined) updates.mfg_batch = body.mfgBatch;
    if (Object.keys(updates).length) await row.update(updates);

    const QRCode = require('qrcode');
    const n = Math.max(1, parseInt(noOfBoxes, 10) || 1);
    const U = Math.max(0, parseInt(unitsPerBox, 10) || 0);
    let unitsPerBoxList = [];
    if (unitsPerBoxListRaw && unitsPerBoxListRaw.length) {
      unitsPerBoxList = unitsPerBoxListRaw.map((v) => Math.max(0, parseInt(v, 10) || 0));
      if (unitsPerBoxList.length !== n) {
        return res.status(400).json({ error: `unitsPerBoxList must have exactly ${n} values (one per box).` });
      }
    } else if (Array.isArray(d.generated_labels) && d.generated_labels.length === n) {
      unitsPerBoxList = d.generated_labels.map((label) => {
        try {
          const p = JSON.parse(label.qrPayload || '{}');
          return Math.max(0, parseInt(p.units_per_box, 10) || 0);
        } catch {
          return U;
        }
      });
    } else {
      unitsPerBoxList = Array.from({ length: n }, () => U);
    }

    const labels = [];
    for (let boxIndex = 1; boxIndex <= n; boxIndex++) {
      const unitsThisBox = unitsPerBoxList[boxIndex - 1] ?? 0;
      const payload = {
        grn_id: id,
        grn_no: d.grn_no,
        product_name: productName || null,
        item_code: itemCode || null,
        units_per_box: unitsThisBox,
        location_prefix: locationPrefix,
        // Rack + Zone for UI preview + QR decoder.
        toRack,
        toZone,
        rack: toRack,
        zone: toZone,
        grn_batch_mfg: grnBatchMfg,
        expiry: expiry || null,
        mfg_batch: mfgBatch,
        box_index: boxIndex,
      };
      const qrPayload = JSON.stringify(payload);
      const qrImageDataUrl = await QRCode.toDataURL(qrPayload, { type: 'image/png', margin: 2 });
      labels.push({ boxIndex, qrPayload, qrImageDataUrl });
    }

    const existingSteps = d.workflow_steps || [];
    const ORDERED_STEPS = ['PO Received', 'Qty Check', 'QC Inspection', 'Label Generation'];
    const updatedSteps = [...new Set([...existingSteps, ...ORDERED_STEPS])];

    await row.update({ generated_labels: labels, workflow_steps: updatedSteps });

    try {
      await applyLabelGenerationToWarehouseInventory(d, itemCode, toRack, toZone, locationPrefix);
    } catch (syncErr) {
      console.warn(
        '[grn] generateLabels: warehouse_inventory zone/rack sync failed:',
        syncErr && syncErr.message ? syncErr.message : syncErr
      );
    }

    res.json({ labels, workflowSteps: updatedSteps });
  } catch (err) {
    console.error('[grn] generateLabels error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate labels' });
  }
}

module.exports = { list, getById, create, update, remove, assignableUsers, generateLabels, applyGrnCompletionToInventory };

const { Op } = require('sequelize');
const GoodsReceivedNote = require('./models');
const { User } = require('../users/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { Product } = require('../products/models');
const PurchaseOrder = require('../purchaseOrders/models');
const WarehouseInventory = require('../warehouseInventory/models');
const { logLocationMovement } = require('../warehouseInventory/locationHistoryHelpers');
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
 * @param {Array} lineItems - raw line_items (may have raw_material_id, pack_material_id, product_id)
 * @param {{ [id: string]: { code: string, name: string } }} rmMap
 * @param {{ [id: string]: { code: string, name: string } }} pmMap - name from description
 * @param {{ [id: string]: { code: string, name: string } }} productMap - Product uses product_id
 */
function enrichLineItems(lineItems, rmMap, pmMap, productMap) {
  if (!Array.isArray(lineItems)) return [];
  return lineItems.map((line) => {
    const poQty = Number(line.poQty ?? line.po_qty) || 0;
    const rcvdQty = Number(line.rcvdQty ?? line.rcvd_qty) || 0;
    const diff = rcvdQty - poQty; // positive = over-received, negative = shortfall
    let item = line.item || '';
    let itemCode = line.itemCode || '';
    if (line.raw_material_id != null && rmMap[String(line.raw_material_id)]) {
      const m = rmMap[String(line.raw_material_id)];
      item = m.name || item;
      itemCode = m.code || itemCode;
    } else if (line.pack_material_id != null && pmMap[String(line.pack_material_id)]) {
      const m = pmMap[String(line.pack_material_id)];
      item = m.name || item;
      itemCode = m.code || itemCode;
    } else if (line.product_id != null && productMap[String(line.product_id)]) {
      const m = productMap[String(line.product_id)];
      item = m.name || item;
      itemCode = m.code || itemCode;
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
  const m2 = s.match(/\(([A-Z0-9-]+)\)/);
  if (m2 && m2[1]) return String(m2[1]).trim().toUpperCase();
  return '';
}

/**
 * Repair wrong RM/PM links in persisted line_items using itemCode/name.
 * This specifically fixes split-PO GRNs where index-based mapping may attach
 * the first PR line ids to all GRN lines.
 */
async function repairLineItemsMasterLinks(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const allLines = rows.flatMap((r) => {
    const d = r.get ? r.get({ plain: true }) : r;
    return Array.isArray(d.line_items) ? d.line_items : [];
  });
  if (allLines.length === 0) return rows;

  const codeSet = new Set();
  const nameSet = new Set();
  allLines.forEach((line) => {
    const code = String(line.itemCode ?? line.item_code ?? '').trim().toUpperCase();
    const extracted = extractMasterCodeFromText(line.item ?? line.item_text ?? '');
    const name = String(line.item ?? '')
      .split('(')[0]
      .trim()
      .toLowerCase();
    if (code) codeSet.add(code);
    if (extracted) codeSet.add(extracted);
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
    RawMaterial.findAll({ where: rmWhere, attributes: ['id', 'code', 'name'] }),
    PackMaterial.findAll({ where: pmWhere, attributes: ['id', 'code', 'description'] }),
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
      const code = String(line.itemCode ?? line.item_code ?? '').trim().toUpperCase() || extractMasterCodeFromText(line.item ?? line.item_text ?? '');
      const name = String(line.item ?? '')
        .split('(')[0]
        .trim()
        .toLowerCase();
      const resolvedRm = rmByCode[code] ?? (name ? rmByName[name] : undefined);
      const resolvedPm = pmByCode[code] ?? (name ? pmByName[name] : undefined);
      const currentRm = line.raw_material_id != null ? Number(line.raw_material_id) : null;
      const currentPm = line.pack_material_id != null ? Number(line.pack_material_id) : null;
      let updated = line;
      if (grnType === 'RM' && resolvedRm != null) {
        if (currentRm !== Number(resolvedRm) || currentPm != null) {
          updated = { ...line, raw_material_id: Number(resolvedRm) };
          if (updated.pack_material_id != null) delete updated.pack_material_id;
          changed = true;
        }
      } else if (grnType === 'PM' && resolvedPm != null) {
        if (currentPm !== Number(resolvedPm) || currentRm != null) {
          updated = { ...line, pack_material_id: Number(resolvedPm) };
          if (updated.raw_material_id != null) delete updated.raw_material_id;
          changed = true;
        }
      } else if (resolvedRm != null && currentRm !== Number(resolvedRm)) {
        updated = { ...line, raw_material_id: Number(resolvedRm) };
        if (updated.pack_material_id != null) delete updated.pack_material_id;
        changed = true;
      } else if (resolvedPm != null && currentPm !== Number(resolvedPm)) {
        updated = { ...line, pack_material_id: Number(resolvedPm) };
        if (updated.raw_material_id != null) delete updated.raw_material_id;
        changed = true;
      }
      return updated;
    });
    if (changed) {
      await row.update({ line_items: next });
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
    const rows = await GoodsReceivedNote.findAll({
      order: [['expected_date', 'DESC'], ['id', 'DESC']],
    });
    await repairLineItemsMasterLinks(rows);
    const { rmMap, pmMap, productMap } = await getMastersForLineItems(rows);
    const out = rows.map((r) => {
      const d = r.get ? r.get({ plain: true }) : r;
      const enriched = enrichLineItems(d.line_items || [], rmMap, pmMap, productMap);
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
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await GoodsReceivedNote.findByPk(id);
    if (!row) return res.status(404).json({ error: 'GRN not found' });
    await repairLineItemsMasterLinks([row]);
    const { rmMap, pmMap, productMap } = await getMastersForLineItems([row]);
    const d = row.get ? row.get({ plain: true }) : row;
    const enriched = enrichLineItems(d.line_items || [], rmMap, pmMap, productMap);
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
      grn_batch_mfg: body.grnBatchMfg ?? body.grn_batch_mfg,
      expiry: body.expiry,
      mfg_batch: body.mfgBatch ?? body.mfg_batch,
    };
    // When a PO is referenced, derive line_items and type from the PO's items array.
    // This is the authoritative source — prevents split-PO item misassignment from the frontend.
    if (payload.purchase_order_id != null) {
      const po = await PurchaseOrder.findByPk(payload.purchase_order_id, { attributes: ['id', 'items'] });
      if (po) {
        const poPlain = po.get({ plain: true });
        const poItems = Array.isArray(poPlain.items) ? poPlain.items : [];
        if (poItems.length > 0) {
          const allPm = poItems.every((i) => i.pack_material_id != null);
          payload.type = allPm ? 'PM' : 'RM';
          const clientLines = Array.isArray(body.lineItems ?? body.line_items) ? (body.lineItems ?? body.line_items) : [];
          payload.line_items = poItems.map((poItem, idx) => {
            const clientLine = clientLines.find((cl) => {
              const clCode = String(cl.itemCode ?? cl.item_code ?? '').trim();
              const poCode = String(poItem.code ?? '').trim();
              return clCode && poCode && clCode === poCode;
            }) ?? clientLines[idx] ?? {};
            return {
              id: clientLine.id ?? String(Date.now() + idx),
              raw_material_id: poItem.raw_material_id ?? null,
              pack_material_id: poItem.pack_material_id ?? null,
              item: poItem.name ?? clientLine.item ?? '',
              itemCode: poItem.code ?? clientLine.itemCode ?? '',
              poQty: Number(poItem.quantity_requested ?? poItem.quantity ?? poItem.qty ?? 0) || 0,
              rcvdQty: Number(clientLine.rcvdQty ?? 0) || 0,
              invoiceQty: Number(clientLine.invoiceQty ?? 0) || 0,
              unitPrice: Number(clientLine.unitPrice ?? poItem.planned_unit_price ?? 0) || 0,
              diff: 0,
              qcStatus: 'Pending',
              qcBy: '',
            };
          });
        }
      }
    }

    const row = await GoodsReceivedNote.create(payload);
    try {
      const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
      await syncWarehouseInTransitAll();
    } catch (e) {
      console.warn('[grn] syncWarehouseInTransitAll after create failed:', e && e.message ? e.message : e);
    }
    const { rmMap, pmMap, productMap } = await getMastersForLineItems([row]);
    const d = row.get ? row.get({ plain: true }) : row;
    const enriched = enrichLineItems(d.line_items || [], rmMap, pmMap, productMap);
    res.status(201).json(formatRow(row, enriched));
  } catch (err) {
    console.error('[grn] create error:', err);
    res.status(500).json({ error: err.message || 'Failed to create GRN' });
  }
}

/**
 * When GRN status transitions to 'GRN Complete', add each line item's received qty to warehouse_inventory
 * (wh_stock and stock_in_hand) so SIH reflects in Planning / Plan Batches.
 * Line items from Procurement-created GRNs often have itemCode but no raw_material_id/pack_material_id;
 * we resolve by itemCode (RM/PM code) when IDs are missing.
 */
async function applyGrnCompletionToInventory(grnRow) {
  const d = grnRow.get ? grnRow.get({ plain: true }) : grnRow;
  const lineItems = d.line_items || [];
  if (lineItems.length === 0) return;

  // Some GRN UIs embed the master code inside the display text, e.g.:
  // "Niacinamide (EI-RM-ACT-002)". When line.raw_material_id is missing/mismatched,
  // we try to extract a code from the display text to resolve the correct RM/PM.
  const extractMasterCodeFromText = (text) => {
    if (!text) return '';
    const s = String(text);
    // Prefer codes that start with "EI-" (seeded master codes).
    const m = s.match(/EI-[A-Z0-9-]+/i);
    if (m && m[0]) return m[0];
    // Fallback: allow parenthesized/all-caps-ish codes.
    const m2 = s.match(/\(([A-Z0-9-]+)\)/);
    if (m2 && m2[1]) return m2[1];
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
        .flatMap((l) => [
          (l.itemCode || l.item_code || '').trim(),
          extractMasterCodeFromText(l.item || l.item_text || ''),
        ])
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
  if (codes.length > 0 || names.length > 0) {
    const rmWhere = codes.length > 0 && names.length > 0 ? { [Op.or]: [{ code: { [Op.in]: codes } }, { name: { [Op.in]: names } }] } : (codes.length > 0 ? { code: { [Op.in]: codes } } : { name: { [Op.in]: names } });
    const pmWhere = codes.length > 0 && names.length > 0 ? { [Op.or]: [{ code: { [Op.in]: codes } }, { description: { [Op.in]: names } }] } : (codes.length > 0 ? { code: { [Op.in]: codes } } : { description: { [Op.in]: names } });
    const [rms, pms] = await Promise.all([
      RawMaterial.findAll({ where: rmWhere, attributes: ['id', 'code', 'name'] }),
      PackMaterial.findAll({ where: pmWhere, attributes: ['id', 'code', 'description'] }),
    ]);
    rms.forEach((r) => {
      const x = r.get ? r.get({ plain: true }) : r;
      validRmIds.add(Number(x.id));
      if (x.code) rmByCode[String(x.code).trim().toUpperCase()] = x.id;
      if (x.name) rmByName[String(x.name).trim().toLowerCase()] = x.id;
    });
    pms.forEach((p) => {
      const x = p.get ? p.get({ plain: true }) : p;
      validPmIds.add(Number(x.id));
      if (x.code) pmByCode[String(x.code).trim().toUpperCase()] = x.id;
      if (x.description) pmByName[String(x.description).trim().toLowerCase()] = x.id;
    });
  }

  const toAddByRm = new Map(); // raw_material_id -> qty to add
  const toAddByPm = new Map(); // pack_material_id -> qty to add
  const toAddByProduct = new Map(); // product_id -> qty to add

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
    const codeRaw =
      (line.itemCode || line.item_code || '').trim() ||
      extractMasterCodeFromText(line.item || line.item_text || '');
    const code = String(codeRaw || '').trim().toUpperCase();

    console.log('[grn] GRN Complete line resolved (qty -> WH)', {
      grnId: d.id,
      itemCode: code || null,
      item: line.item || null,
      poQty: Number(line.poQty ?? line.po_qty) || 0,
      rcvdQtyUsed: rcvdQty,
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
      toAddByProduct.set(id, (toAddByProduct.get(id) || 0) + rcvdQty);
    } else if (code || (line.item && String(line.item).trim()) || explicitRmIdValid || explicitPmIdValid) {
      // Prefer master resolution from code/name when available, then fall back to validated explicit IDs.
      const rmId = resolvedRmId != null ? resolvedRmId : (resolvedPmId == null && explicitRmIdValid ? explicitRmId : null);
      const pmId = resolvedPmId != null ? resolvedPmId : (resolvedRmId == null && explicitPmIdValid ? explicitPmId : null);

      if (explicitRmIdValid && resolvedRmId != null && Number(explicitRmId) !== Number(resolvedRmId)) {
        console.warn('[grn] RM id mismatch on line, preferring code/name resolution', {
          explicitRmId,
          resolvedRmId,
          itemCode: code || null,
          item: line.item || null,
        });
      }
      if (explicitPmIdValid && resolvedPmId != null && Number(explicitPmId) !== Number(resolvedPmId)) {
        console.warn('[grn] PM id mismatch on line, preferring code/name resolution', {
          explicitPmId,
          resolvedPmId,
          itemCode: code || null,
          item: line.item || null,
        });
      }

      if (grnType === 'PM' && pmId != null) {
        toAddByPm.set(pmId, (toAddByPm.get(pmId) || 0) + rcvdQty);
      } else if (grnType === 'RM' && rmId != null) {
        toAddByRm.set(rmId, (toAddByRm.get(rmId) || 0) + rcvdQty);
      } else if (rmId != null) {
        toAddByRm.set(rmId, (toAddByRm.get(rmId) || 0) + rcvdQty);
      } else if (pmId != null) {
        toAddByPm.set(pmId, (toAddByPm.get(pmId) || 0) + rcvdQty);
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
    let whRow = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rawMaterialId } });
    if (whRow) {
      const wh = whRow.get ? whRow.get({ plain: true }) : whRow;
      const whStockBefore = Number(wh.wh_stock) || 0;
      const ml1Before = Number(wh.ml1_stock) || 0;
      const ml2Before = Number(wh.ml2_stock) || 0;
      const whStock = (Number(wh.wh_stock) || 0) + qty;
      const ml1 = Number(wh.ml1_stock) || 0;
      const ml2 = Number(wh.ml2_stock) || 0;
      await whRow.update({ wh_stock: whStock, stock_in_hand: whStock + ml1 + ml2 });
      console.log('[grn] WH inventory RM wh_stock update', {
        rawMaterialId,
        qtyToAdd: qty,
        whInventoryId: wh.id ?? null,
        whStockBefore,
        whStockAfter: whStock,
        stockInHandAfter: whStock + ml1 + ml2,
        ml1Before,
        ml1After: ml1,
        ml2Before,
        ml2After: ml2,
      });
      console.log('[grn] GRN Complete: added RM id=%d qty=%s -> wh_stock=%s', rawMaterialId, qty, whStock);
    } else {
      whRow = await WarehouseInventory.create({
        item_type: 'RM',
        raw_material_id: rawMaterialId,
        pack_material_id: null,
        product_id: null,
        wh_stock: qty,
        wh_unit: 'KG',
        ml1_stock: 0,
        ml2_stock: 0,
        stock_in_hand: qty,
        reserved: 0,
        in_transit: 0,
        reorder_pt: 0,
        avg_mo: 0,
        qc_status: 'In Stock',
      });
      console.log('[grn] WH inventory RM created', {
        rawMaterialId,
        qtyToAdd: qty,
        newWarehouseInventoryId: whRow.id ?? null,
      });
      console.log('[grn] GRN Complete: created RM warehouse_inventory id=%d wh_stock=%s', rawMaterialId, qty);
    }

    // Optional history entry – location may be null if not yet assigned.
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
    });
  }

  for (const [packMaterialId, qty] of toAddByPm) {
    let whRow = await WarehouseInventory.findOne({ where: { item_type: 'PM', pack_material_id: packMaterialId } });
    if (whRow) {
      const wh = whRow.get ? whRow.get({ plain: true }) : whRow;
      const whStockBefore = Number(wh.wh_stock) || 0;
      const ml1Before = Number(wh.ml1_stock) || 0;
      const ml2Before = Number(wh.ml2_stock) || 0;
      const whStock = (Number(wh.wh_stock) || 0) + qty;
      const ml1 = Number(wh.ml1_stock) || 0;
      const ml2 = Number(wh.ml2_stock) || 0;
      await whRow.update({ wh_stock: whStock, stock_in_hand: whStock + ml1 + ml2 });
      console.log('[grn] WH inventory PM wh_stock update', {
        packMaterialId,
        qtyToAdd: qty,
        whInventoryId: wh.id ?? null,
        whStockBefore,
        whStockAfter: whStock,
        stockInHandAfter: whStock + ml1 + ml2,
        ml1Before,
        ml1After: ml1,
        ml2Before,
        ml2After: ml2,
      });
      console.log('[grn] GRN Complete: added PM id=%d qty=%s -> wh_stock=%s', packMaterialId, qty, whStock);
    } else {
      whRow = await WarehouseInventory.create({
        item_type: 'PM',
        raw_material_id: null,
        pack_material_id: packMaterialId,
        product_id: null,
        wh_stock: qty,
        wh_unit: 'PCS',
        ml1_stock: 0,
        ml2_stock: 0,
        stock_in_hand: qty,
        reserved: 0,
        in_transit: 0,
        reorder_pt: 0,
        avg_mo: 0,
        qc_status: 'In Stock',
      });
      console.log('[grn] WH inventory PM created', {
        packMaterialId,
        qtyToAdd: qty,
        newWarehouseInventoryId: whRow.id ?? null,
      });
      console.log('[grn] GRN Complete: created PM warehouse_inventory id=%d wh_stock=%s', packMaterialId, qty);
    }

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
    });
  }

  for (const [productId, qty] of toAddByProduct) {
    let whRow = await WarehouseInventory.findOne({ where: { item_type: 'PR', product_id: productId } });
    if (whRow) {
      const wh = whRow.get ? whRow.get({ plain: true }) : whRow;
      const whStockBefore = Number(wh.wh_stock) || 0;
      const ml1Before = Number(wh.ml1_stock) || 0;
      const ml2Before = Number(wh.ml2_stock) || 0;
      const whStock = (Number(wh.wh_stock) || 0) + qty;
      const ml1 = Number(wh.ml1_stock) || 0;
      const ml2 = Number(wh.ml2_stock) || 0;
      await whRow.update({ wh_stock: whStock, stock_in_hand: whStock + ml1 + ml2 });
      console.log('[grn] WH inventory PR wh_stock update', {
        productId,
        qtyToAdd: qty,
        whInventoryId: wh.id ?? null,
        whStockBefore,
        whStockAfter: whStock,
        stockInHandAfter: whStock + ml1 + ml2,
        ml1Before,
        ml1After: ml1,
        ml2Before,
        ml2After: ml2,
      });
      console.log('[grn] GRN Complete: added PR product_id=%d qty=%s -> wh_stock=%s', productId, qty, whStock);
    } else {
      whRow = await WarehouseInventory.create({
        item_type: 'PR',
        raw_material_id: null,
        pack_material_id: null,
        product_id: productId,
        wh_stock: qty,
        wh_unit: 'PCS',
        ml1_stock: 0,
        ml2_stock: 0,
        stock_in_hand: qty,
        reserved: 0,
        in_transit: 0,
        reorder_pt: 0,
        avg_mo: 0,
        qc_status: 'In Stock',
      });
      console.log('[grn] WH inventory PR created', {
        productId,
        qtyToAdd: qty,
        newWarehouseInventoryId: whRow.id ?? null,
      });
      console.log('[grn] GRN Complete: created PR warehouse_inventory product_id=%d wh_stock=%s', productId, qty);
    }

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
    });
  }

  console.log('[grn] GRN Complete inventory apply END', {
    grnId: d.id,
    grnNo: d.grn_no,
    purchaseOrderId: d.purchase_order_id,
    poNo: d.po_no,
    type: d.type,
  });
}

/**
 * PUT /api/v1/grn/:id — update GRN. Body: any of assigned_to, grn_date, received_date, qc_status, status, line_items, workflow_steps, invoice_no, invoice_amount.
 */
async function update(req, res) {
  try {
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
      if (blockers.length > 0) {
        return res.status(400).json({ error: `Cannot mark GRN Complete: ${blockers.join('; ')}.` });
      }
    }
    const previousStatus = (row.get ? row.get({ plain: true }) : row).status;
    await row.update(updates);
    const refreshed = await GoodsReceivedNote.findByPk(id);
    if (updates.status === 'GRN Complete' && previousStatus !== 'GRN Complete') {
      const refreshedPlain = refreshed.get ? refreshed.get({ plain: true }) : refreshed;
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
        poQty: li.poQty ?? 0,
        rcvdQty: li.rcvdQty ?? li.rcvd_qty ?? null,
        raw_material_id: li.raw_material_id ?? null,
        pack_material_id: li.pack_material_id ?? null,
        product_id: li.product_id ?? null,
      })));
      await applyGrnCompletionToInventory(refreshed);
    }
    try {
      const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
      await syncWarehouseInTransitAll();
    } catch (e) {
      console.warn('[grn] syncWarehouseInTransitAll after update failed:', e && e.message ? e.message : e);
    }
    const { rmMap, pmMap, productMap } = await getMastersForLineItems([refreshed]);
    const d = refreshed.get ? refreshed.get({ plain: true }) : refreshed;
    const enriched = enrichLineItems(d.line_items || [], rmMap, pmMap, productMap);
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
 * POST /api/v1/grn/:id/generate-labels
 * Body (optional): noOfBoxes, unitsPerBox, lastBoxUnits (partial last box — box n only),
 *                  locationPrefix, grnBatchMfg, expiry, mfgBatch, productName, itemCode.
 * Uses GRN-stored values if not in body. Generates noOfBoxes QR codes per box.
 * Also advances workflow_steps to include 'Label Generation'.
 * Returns { labels, workflowSteps }.
 */
async function generateLabels(req, res) {
  try {
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
    const lastExplicit =
      Object.prototype.hasOwnProperty.call(body, 'lastBoxUnits') ||
      Object.prototype.hasOwnProperty.call(body, 'last_box_units');
    let lastBoxUnits = lastExplicit ? body.lastBoxUnits ?? body.last_box_units : d.last_box_units;
    if (lastBoxUnits === '' || lastBoxUnits === undefined) lastBoxUnits = null;
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

    const updates = {};
    if (body.noOfBoxes !== undefined) updates.no_of_boxes = body.noOfBoxes;
    if (body.unitsPerBox !== undefined) updates.units_per_box = body.unitsPerBox;
    if (body.lastBoxUnits !== undefined) updates.last_box_units = body.lastBoxUnits;
    if (body.locationPrefix !== undefined) updates.location_prefix = body.locationPrefix;
    if (body.grnBatchMfg !== undefined) updates.grn_batch_mfg = body.grnBatchMfg;
    if (body.expiry !== undefined) updates.expiry = body.expiry;
    if (body.mfgBatch !== undefined) updates.mfg_batch = body.mfgBatch;
    if (Object.keys(updates).length) await row.update(updates);

    const QRCode = require('qrcode');
    const n = Math.max(1, parseInt(noOfBoxes, 10) || 1);
    const U = Math.max(0, parseInt(unitsPerBox, 10) || 0);
    const lastParsed = lastBoxUnits != null ? parseInt(lastBoxUnits, 10) : NaN;
    const useRemainder = Number.isFinite(lastParsed) && lastParsed >= 1;
    if (useRemainder && U < 1) {
      return res.status(400).json({ error: 'Set units per full box before using remainder in last box.' });
    }
    if (useRemainder && lastParsed > U) {
      return res.status(400).json({
        error: `Last box units (${lastParsed}) cannot exceed units per full box (${U}).`,
      });
    }

    const labels = [];
    for (let boxIndex = 1; boxIndex <= n; boxIndex++) {
      const unitsThisBox = useRemainder ? (boxIndex < n ? U : lastParsed) : U;
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
      if (useRemainder && U > 0) payload.full_carton_units = U;
      if (useRemainder && boxIndex === n && lastParsed < U) payload.partial_last_box = true;
      const qrPayload = JSON.stringify(payload);
      const qrImageDataUrl = await QRCode.toDataURL(qrPayload, { type: 'image/png', margin: 2 });
      labels.push({ boxIndex, qrPayload, qrImageDataUrl });
    }

    const existingSteps = d.workflow_steps || [];
    const ORDERED_STEPS = ['PO Received', 'Qty Check', 'QC Inspection', 'Label Generation'];
    const updatedSteps = [...new Set([...existingSteps, ...ORDERED_STEPS])];

    await row.update({ generated_labels: labels, workflow_steps: updatedSteps });
    res.json({ labels, workflowSteps: updatedSteps });
  } catch (err) {
    console.error('[grn] generateLabels error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate labels' });
  }
}

module.exports = { list, getById, create, update, remove, assignableUsers, generateLabels, applyGrnCompletionToInventory };

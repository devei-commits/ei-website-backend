const { Op } = require('sequelize');
const MaterialRequestNote = require('./models');
const { User } = require('../users/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { Product } = require('../products/models');
const WarehouseInventory = require('../warehouseInventory/models');
const { applyDeltaToRack, recalculateInventoryForItem, computeStockInHand } = require('../warehouseInventory/inventoryMath');
const { logLocationMovement } = require('../warehouseInventory/locationHistoryHelpers');
const WarehouseInventoryLocationHistory = require('../warehouseInventory/locationHistoryModel');

/** Usertypes that can be assigned as Picker / Transfer Team (same as GRN). */
const ASSIGNABLE_USERTYPES = ['super_admin', 'admin', 'bd_manager'];

/** Detect RM vs PM lines when ids are missing (codes not resolved) — MTR from Production sends KG / PCS. */
function lineItemsIndicateRm(lineItems) {
  if (!Array.isArray(lineItems)) return false;
  return lineItems.some((l) => {
    if (l.raw_material_id != null) return true;
    return String(l.unit || '').toUpperCase() === 'KG';
  });
}

function lineItemsIndicatePm(lineItems) {
  if (!Array.isArray(lineItems)) return false;
  return lineItems.some((l) => {
    if (l.pack_material_id != null) return true;
    const u = String(l.unit || '').toUpperCase();
    return u === 'PCS' || u === 'PC' || u === 'PIECES';
  });
}

/**
 * GET /api/v1/mrn/assignable-pickers — users with correct permissions for Assign Picker / Transfer Team.
 */
async function assignablePickers(req, res) {
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
    console.error('[mrn] assignablePickers error:', err);
    res.status(500).json({ error: err.message || 'Failed to list assignable pickers' });
  }
}

function enrichMrnLineItems(lineItems, rmMap, pmMap, productMap) {
  if (!Array.isArray(lineItems)) return [];
  return lineItems.map((line) => {
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
    return {
      id: line.id,
      raw_material_id: line.raw_material_id,
      pack_material_id: line.pack_material_id,
      product_id: line.product_id,
      item,
      itemCode,
      quantity: Number(line.quantity) || 0,
      unit: line.unit || '',
      notes: line.notes || '',
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

/** Resolve line_items that have code/rm_code/pm_code to raw_material_id or pack_material_id. */
async function resolveLineItemCodes(lineItems, itemType) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return lineItems;
  const codes = [...new Set(lineItems.map((l) => l.code || l.rm_code || l.itemCode || l.pm_code).filter(Boolean))];
  if (codes.length === 0) return lineItems;
  const type = String(itemType || 'rm').toUpperCase();
  let rmByCode = {};
  let pmByCode = {};
  if (type === 'RM') {
    const rms = await RawMaterial.findAll({ where: { code: codes }, attributes: ['id', 'code'] });
    rms.forEach((r) => { const d = r.get ? r.get({ plain: true }) : r; rmByCode[d.code] = d.id; });
  }
  if (type === 'PM') {
    const pms = await PackMaterial.findAll({ where: { code: codes }, attributes: ['id', 'code'] });
    pms.forEach((p) => { const d = p.get ? p.get({ plain: true }) : p; pmByCode[d.code] = d.id; });
  }
  return lineItems.map((line, idx) => {
    if (line.raw_material_id != null || line.pack_material_id != null) return line;
    const code = line.code || line.rm_code || line.pm_code || line.itemCode;
    if (!code) return line;
    const rid = rmByCode[code];
    const pid = pmByCode[code];
    const { code: _c, rm_code: _rc, pm_code: _pc, ...rest } = line;
    const id = line.id || `m${idx + 1}`;
    if (rid != null) return { ...rest, id, raw_material_id: rid, quantity: Number(line.quantity) || 0, unit: line.unit || 'KG', notes: line.notes || '' };
    if (pid != null) return { ...rest, id, pack_material_id: pid, quantity: Number(line.quantity) || 0, unit: line.unit || 'PCS', notes: line.notes || '' };
    return line;
  });
}

async function generateMrnNo() {
  const { Op } = require('sequelize');
  const year = new Date().getFullYear();
  const prefix = `EI-MRN-${year}-`;
  const last = await MaterialRequestNote.findOne({
    where: { mrn_no: { [Op.like]: prefix + '%' } },
    order: [['id', 'DESC']],
    attributes: ['mrn_no'],
  });
  const lastNum = last && last.mrn_no ? parseInt(last.mrn_no.replace(prefix, ''), 10) : 0;
  return prefix + String(lastNum + 1).padStart(3, '0');
}

function formatRow(r, enrichedLineItems) {
  if (!r) return null;
  const d = r.get ? r.get({ plain: true }) : r;
  const lineItems = enrichedLineItems !== undefined ? enrichedLineItems : (d.line_items || []);
  return {
    id: String(d.id),
    mrnNo: d.mrn_no,
    requestedBy: d.requested_by || '',
    status: d.status || 'Pending',
    assignedPicker: d.assigned_picker || '',
    transferTeam: d.transfer_team || '',
    lineItems,
    notes: d.notes || '',
    bmrNo: d.bmr_no || '',
    source: d.source || '',
    isInboundFromMu: Boolean(d.is_inbound_from_mu),
    receivedAtMu: d.received_at_mu || null,
    generatedLabels: d.generated_labels || null,
    noOfBoxes: d.no_of_boxes ?? null,
    unitsPerBox: d.units_per_box ?? null,
    locationPrefix: d.location_prefix ?? null,
    grnBatchMfg: d.grn_batch_mfg ?? null,
    expiry: d.expiry ?? null,
    mfgBatch: d.mfg_batch ?? null,
    muReceiveZone: d.mu_receive_zone ?? null,
    muReceiveRack: d.mu_receive_rack ?? null,
    createdAt: d.created_at || null,
  };
}

async function list(req, res) {
  try {
    const transferType = req.query.transferType; // 'outbound' | 'inbound_from_mu'
    let where = {};
    if (transferType === 'outbound') where = { [Op.or]: [{ is_inbound_from_mu: false }, { is_inbound_from_mu: null }] };
    if (transferType === 'inbound_from_mu') where = { is_inbound_from_mu: true };
    const rows = await MaterialRequestNote.findAll({
      where: Object.keys(where).length ? where : undefined,
      order: [['id', 'DESC']],
    });
    const { rmMap, pmMap, productMap } = await getMastersForLineItems(rows);
    const out = rows.map((r) => {
      const d = r.get ? r.get({ plain: true }) : r;
      const enriched = enrichMrnLineItems(d.line_items || [], rmMap, pmMap, productMap);
      return formatRow(r, enriched);
    });
    res.json(out);
  } catch (err) {
    console.error('[mrn] list error:', err);
    res.status(500).json({ error: err.message || 'Failed to list MRNs' });
  }
}

async function getById(req, res) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await MaterialRequestNote.findByPk(id);
    if (!row) return res.status(404).json({ error: 'MRN not found' });
    const { rmMap, pmMap, productMap } = await getMastersForLineItems([row]);
    const d = row.get ? row.get({ plain: true }) : row;
    const enriched = enrichMrnLineItems(d.line_items || [], rmMap, pmMap, productMap);
    res.json(formatRow(row, enriched));
  } catch (err) {
    console.error('[mrn] getById error:', err);
    res.status(500).json({ error: err.message || 'Failed to get MRN' });
  }
}

async function create(req, res) {
  try {
    const body = req.body || {};
    let lineItems = body.lineItems ?? body.line_items ?? [];
    const itemType = body.itemType || body.item_type;
    lineItems = await resolveLineItemCodes(lineItems, itemType);
    const bmrNoForMtr = body.bmrNo ?? body.bmr_no ?? null;
    const sourceForMtr = body.source ?? null;
    const inboundMu = Boolean(body.isInboundFromMu ?? body.is_inbound_from_mu);
    if (sourceForMtr === 'MTR' && bmrNoForMtr && !inboundMu) {
      const wantRm = lineItemsIndicateRm(lineItems);
      const wantPm = lineItemsIndicatePm(lineItems);
      if (wantRm || wantPm) {
        const existing = await MaterialRequestNote.findAll({
          where: {
            bmr_no: bmrNoForMtr,
            source: 'MTR',
            [Op.or]: [{ is_inbound_from_mu: false }, { is_inbound_from_mu: null }],
          },
          attributes: ['line_items'],
        });
        for (const ex of existing) {
          const elis = ex.get ? ex.get('line_items') : ex.line_items;
          if (wantRm && lineItemsIndicateRm(elis)) {
            return res.status(409).json({
              error:
                'An RM transfer request (MTR) already exists for this batch. Complete it in Transfer orders (or remove the duplicate MRN) before creating another.',
            });
          }
          if (wantPm && lineItemsIndicatePm(elis)) {
            return res.status(409).json({
              error:
                'A PM transfer request (MTR) already exists for this batch. Complete it in Transfer orders (or remove the duplicate MRN) before creating another.',
            });
          }
        }
      }
    }
    const mrnNo = body.mrnNo || body.mrn_no || (await generateMrnNo());
    const payload = {
      mrn_no: mrnNo,
      requested_by: body.requestedBy ?? body.requested_by,
      status: body.status || 'Pending',
      assigned_picker: body.assignedPicker ?? body.assigned_picker,
      transfer_team: body.transferTeam ?? body.transfer_team,
      line_items: lineItems,
      notes: body.notes ?? body.notes,
      bmr_no: body.bmrNo ?? body.bmr_no ?? null,
      source: body.source ?? null,
      is_inbound_from_mu: body.isInboundFromMu ?? body.is_inbound_from_mu ?? false,
    };
    const row = await MaterialRequestNote.create(payload);
    const { rmMap, pmMap, productMap } = await getMastersForLineItems([row]);
    const d = row.get ? row.get({ plain: true }) : row;
    const enriched = enrichMrnLineItems(d.line_items || [], rmMap, pmMap, productMap);
    res.status(201).json(formatRow(row, enriched));
  } catch (err) {
    console.error('[mrn] create error:', err);
    res.status(500).json({ error: err.message || 'Failed to create MRN' });
  }
}

async function update(req, res) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await MaterialRequestNote.findByPk(id);
    if (!row) return res.status(404).json({ error: 'MRN not found' });
    const body = req.body || {};
    const updates = {};
    if (body.requestedBy !== undefined) updates.requested_by = body.requestedBy;
    if (body.requested_by !== undefined) updates.requested_by = body.requested_by;
    if (body.status !== undefined) updates.status = body.status;
    if (body.assignedPicker !== undefined) updates.assigned_picker = body.assignedPicker;
    if (body.assigned_picker !== undefined) updates.assigned_picker = body.assigned_picker;
    if (body.transferTeam !== undefined) updates.transfer_team = body.transferTeam;
    if (body.transfer_team !== undefined) updates.transfer_team = body.transfer_team;
    if (body.lineItems !== undefined) updates.line_items = body.lineItems;
    if (body.line_items !== undefined) updates.line_items = body.line_items;
    if (body.notes !== undefined) updates.notes = body.notes;
    if (body.bmrNo !== undefined) updates.bmr_no = body.bmrNo;
    if (body.bmr_no !== undefined) updates.bmr_no = body.bmr_no;
    if (body.source !== undefined) updates.source = body.source;
    if (body.isInboundFromMu !== undefined) updates.is_inbound_from_mu = Boolean(body.isInboundFromMu);
    if (body.is_inbound_from_mu !== undefined) updates.is_inbound_from_mu = Boolean(body.is_inbound_from_mu);
    if (body.receivedAtMu !== undefined) updates.received_at_mu = body.receivedAtMu ? new Date(body.receivedAtMu) : null;
    if (body.received_at_mu !== undefined) updates.received_at_mu = body.received_at_mu ? new Date(body.received_at_mu) : null;
    if (body.generatedLabels !== undefined) updates.generated_labels = body.generatedLabels;
    if (body.generated_labels !== undefined) updates.generated_labels = body.generated_labels;
    if (body.noOfBoxes !== undefined) updates.no_of_boxes = body.noOfBoxes;
    if (body.no_of_boxes !== undefined) updates.no_of_boxes = body.no_of_boxes;
    if (body.unitsPerBox !== undefined) updates.units_per_box = body.unitsPerBox;
    if (body.units_per_box !== undefined) updates.units_per_box = body.units_per_box;
    if (body.locationPrefix !== undefined) updates.location_prefix = body.locationPrefix;
    if (body.location_prefix !== undefined) updates.location_prefix = body.location_prefix;
    if (body.grnBatchMfg !== undefined) updates.grn_batch_mfg = body.grnBatchMfg;
    if (body.grn_batch_mfg !== undefined) updates.grn_batch_mfg = body.grn_batch_mfg;
    if (body.expiry !== undefined) updates.expiry = body.expiry;
    if (body.mfgBatch !== undefined) updates.mfg_batch = body.mfgBatch;
    if (body.mfg_batch !== undefined) updates.mfg_batch = body.mfg_batch;
    if (body.muReceiveZone !== undefined) updates.mu_receive_zone = body.muReceiveZone;
    if (body.mu_receive_zone !== undefined) updates.mu_receive_zone = body.mu_receive_zone;
    if (body.muReceiveRack !== undefined) updates.mu_receive_rack = body.muReceiveRack;
    if (body.mu_receive_rack !== undefined) updates.mu_receive_rack = body.mu_receive_rack;

    const plainBefore = row.get ? row.get({ plain: true }) : row;
    const previousStatus = plainBefore.status || '';

    await row.update(updates);
    const refreshed = await MaterialRequestNote.findByPk(id);
    const d = refreshed.get ? refreshed.get({ plain: true }) : refreshed;

    const newStatus = updates.status !== undefined ? updates.status : previousStatus;
    if (newStatus === 'Completed' && previousStatus !== 'Completed' && d.source === 'MTR' && d.bmr_no) {
      await applyMrnCompletionToInventory(d);
      if (d.mu_receive_zone || d.mu_receive_rack) {
        await logMrnReceiveAtMuLocation(d);
      }
      await applyMtrCompletionToProductionBatch(d);
    }

    const { rmMap, pmMap, productMap } = await getMastersForLineItems([refreshed]);
    const enriched = enrichMrnLineItems(d.line_items || [], rmMap, pmMap, productMap);
    res.json(formatRow(refreshed, enriched));
  } catch (err) {
    console.error('[mrn] update error:', err);
    res.status(500).json({ error: err.message || 'Failed to update MRN' });
  }
}

/**
 * True if another outbound MTR for this BMR is still not Completed, with RM (or PM) lines.
 * RM and PM are tracked separately. Uses unit fallback when line ids were not resolved.
 */
async function hasPendingMtrOfKind(bmrNo, kind) {
  const rows = await MaterialRequestNote.findAll({
    where: {
      bmr_no: bmrNo,
      source: 'MTR',
      [Op.or]: [{ is_inbound_from_mu: false }, { is_inbound_from_mu: null }],
      status: { [Op.ne]: 'Completed' },
    },
    attributes: ['line_items'],
  });
  return rows.some((row) => {
    const lis = row.get ? row.get('line_items') : row.line_items;
    if (kind === 'rm') return lineItemsIndicateRm(lis);
    if (kind === 'pm') return lineItemsIndicatePm(lis);
    return false;
  });
}

/**
 * After MTR MRN is Completed and WH→MU stock is applied, allow Production to enter dispense:
 * set rm_connected / pm_connected and advance status only when no other pending MTR of that kind remains.
 */
async function applyMtrCompletionToProductionBatch(plainMrn) {
  if (plainMrn.source !== 'MTR' || !plainMrn.bmr_no || plainMrn.is_inbound_from_mu) return;

  const lineItems = Array.isArray(plainMrn.line_items) ? plainMrn.line_items : [];
  const hasRm = lineItemsIndicateRm(lineItems);
  const hasPm = lineItemsIndicatePm(lineItems);
  if (!hasRm && !hasPm) return;

  const { ProductionBatch } = require('../production/models');
  const batch = await ProductionBatch.findOne({ where: { bmr_no: plainMrn.bmr_no } });
  if (!batch) return;

  const plain = batch.get ? batch.get({ plain: true }) : batch;
  const updates = {};

  if (hasRm) {
    const pendingRm = await hasPendingMtrOfKind(plainMrn.bmr_no, 'rm');
    if (!pendingRm) {
      updates.rm_connected = true;
      if (['rm_reserved', 'scheduled'].includes(plain.bmr_status)) {
        updates.bmr_status = 'rm_connected';
      }
    }
  }
  if (hasPm) {
    const pendingPm = await hasPendingMtrOfKind(plainMrn.bmr_no, 'pm');
    if (!pendingPm) {
      updates.pm_connected = true;
      if (plain.bpr_status === 'pm_reserved') {
        updates.bpr_status = 'pm_connected';
      }
    }
  }

  if (Object.keys(updates).length > 0) {
    await batch.update(updates);
  }
}

/**
 * Map MU receive zone code to which manufacturing location stock to credit.
 * LOC-MU01 -> ml1_stock, LOC-MU02 -> ml2_stock; default ml1.
 */
function muZoneToMl(zone) {
  if (!zone || typeof zone !== 'string') return 'ml1';
  const z = String(zone).toUpperCase();
  if (z.includes('MU02') || z === 'LOC-MU02') return 'ml2';
  return 'ml1';
}

/**
 * When an MRN from MTR is marked Completed, move stock WH -> MU (or MU -> WH for inbound).
 * Updates warehouse_inventory: wh_stock, ml1_stock, ml2_stock, stock_in_hand so that
 * /warehouse/inventory shows correct WH Stock, ML1 Stock, ML2 Stock.
 */
async function applyMrnCompletionToInventory(plainMrn) {
  if (plainMrn.source !== 'MTR' || !plainMrn.bmr_no) return;
  const lineItems = Array.isArray(plainMrn.line_items) ? plainMrn.line_items : [];
  const isInbound = !!plainMrn.is_inbound_from_mu;
  const muZone = plainMrn.mu_receive_zone || null;
  const targetMl = muZoneToMl(muZone);

  for (const line of lineItems) {
    const qty = Number(line.quantity) || 0;
    if (qty <= 0) continue;
    let whRow = null;
    if (line.raw_material_id != null) {
      whRow = await WarehouseInventory.findOne({
        where: { item_type: 'RM', raw_material_id: line.raw_material_id },
      });
    } else if (line.pack_material_id != null) {
      whRow = await WarehouseInventory.findOne({
        where: { item_type: 'PM', pack_material_id: line.pack_material_id },
      });
    }
    if (!whRow) continue;
    const plain = whRow.get ? whRow.get({ plain: true }) : whRow;

    let whStock = Number(plain.wh_stock) || 0;
    let ml1 = Number(plain.ml1_stock) || 0;
    let ml2 = Number(plain.ml2_stock) || 0;
    let reserved = Number(plain.reserved) || 0;

    console.log('[mrn][MTR] before move', {
      source: isInbound ? 'MU->WH' : 'WH->MU',
      mrnId: plainMrn.id,
      raw_material_id: line.raw_material_id,
      pack_material_id: line.pack_material_id,
      qty,
      whStockBefore: whStock,
      ml1Before: ml1,
      ml2Before: ml2,
      reservedBefore: reserved,
    });

    if (isInbound) {
      // MU -> WH: decrease ML (source), increase WH
      if (targetMl === 'ml2') {
        ml2 = Math.max(0, ml2 - qty);
      } else {
        ml1 = Math.max(0, ml1 - qty);
      }
      whStock += qty;
    } else {
      // WH -> MU: decrease WH, increase ML (target)
      whStock = Math.max(0, whStock - qty);
      if (targetMl === 'ml2') {
        ml2 += qty;
      } else {
        ml1 += qty;
      }
    }

    // Reduce reserved by moved qty so RM/PM availability table reflects that this batch's need is now at MU
    reserved = Math.max(0, reserved - qty);

    const stockInHand = computeStockInHand(whStock, ml1, ml2);
    await whRow.update({
      wh_stock: whStock,
      ml1_stock: ml1,
      ml2_stock: ml2,
      stock_in_hand: stockInHand,
      reserved,
    });
    console.log('[mrn][MTR] after move', {
      source: isInbound ? 'MU->WH' : 'WH->MU',
      whInventoryId: plain.id,
      qty,
      whStock,
      ml1,
      ml2,
      stockInHand,
      reserved,
    });
  }
}

/**
 * When MRN is completed with MU receive zone/rack, log movement history (MRN_IN_MU) for each line.
 */
async function logMrnReceiveAtMuLocation(plainMrn) {
  const lineItems = Array.isArray(plainMrn.line_items) ? plainMrn.line_items : [];
  const toZone = plainMrn.mu_receive_zone || null;
  const toRack = plainMrn.mu_receive_rack || null;
  if (!toZone && !toRack) return;
  for (const line of lineItems) {
    const qty = Number(line.quantity) || 0;
    if (qty <= 0) continue;
    let whRow = null;
    if (line.raw_material_id != null) {
      whRow = await WarehouseInventory.findOne({
        where: { item_type: 'RM', raw_material_id: line.raw_material_id },
      });
    } else if (line.pack_material_id != null) {
      whRow = await WarehouseInventory.findOne({
        where: { item_type: 'PM', pack_material_id: line.pack_material_id },
      });
    }
    if (!whRow) continue;
    const plain = whRow.get ? whRow.get({ plain: true }) : whRow;
    await logLocationMovement({
      warehouseInventoryId: plain.id,
      itemType: plain.item_type,
      rawMaterialId: plain.raw_material_id ?? line.raw_material_id,
      packMaterialId: plain.pack_material_id ?? line.pack_material_id,
      productId: plain.product_id ?? line.product_id,
      fromZone: null,
      fromRack: null,
      toZone,
      toRack,
      qtyDelta: qty,
      actionType: 'MRN_IN_MU',
      sourceMrnId: plainMrn.id,
    });
  }
}

async function remove(req, res) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const n = await MaterialRequestNote.destroy({ where: { id } });
    if (n === 0) return res.status(404).json({ error: 'MRN not found' });
    res.status(204).send();
  } catch (err) {
    console.error('[mrn] remove error:', err);
    res.status(500).json({ error: err.message || 'Failed to delete MRN' });
  }
}

/**
 * POST /api/v1/mrn/:id/generate-labels
 * Body: noOfBoxes, unitsPerBox, locationPrefix (MU location), grnBatchMfg, expiry, mfgBatch, productName, itemCode.
 * Generates QR labels for MU put-away (same shape as GRN labels).
 */
async function generateLabels(req, res) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await MaterialRequestNote.findByPk(id);
    if (!row) return res.status(404).json({ error: 'MRN not found' });
    const body = req.body || {};
    const d = row.get ? row.get({ plain: true }) : row;
    const noOfBoxes = body.noOfBoxes ?? body.no_of_boxes ?? d.no_of_boxes ?? 1;
    const unitsPerBox = body.unitsPerBox ?? body.units_per_box ?? d.units_per_box ?? 0;
    const locationPrefix = body.locationPrefix ?? body.location_prefix ?? d.location_prefix ?? '';
    const grnBatchMfg = body.grnBatchMfg ?? body.grn_batch_mfg ?? d.grn_batch_mfg ?? '';
    const expiry = body.expiry ?? d.expiry ?? '';
    const mfgBatch = body.mfgBatch ?? body.mfg_batch ?? d.mfg_batch ?? '';
    const productName = body.productName ?? '';
    const itemCode = body.itemCode ?? '';

    const updates = {};
    if (body.noOfBoxes !== undefined) updates.no_of_boxes = body.noOfBoxes;
    if (body.unitsPerBox !== undefined) updates.units_per_box = body.unitsPerBox;
    if (body.locationPrefix !== undefined) updates.location_prefix = body.locationPrefix;
    if (body.grnBatchMfg !== undefined) updates.grn_batch_mfg = body.grnBatchMfg;
    if (body.expiry !== undefined) updates.expiry = body.expiry;
    if (body.mfgBatch !== undefined) updates.mfg_batch = body.mfgBatch;
    if (Object.keys(updates).length) await row.update(updates);

    const QRCode = require('qrcode');
    const n = Math.max(1, parseInt(noOfBoxes, 10) || 1);
    const labels = [];
    for (let boxIndex = 1; boxIndex <= n; boxIndex++) {
      const payload = {
        mrn_id: id,
        mrn_no: d.mrn_no,
        product_name: productName || null,
        item_code: itemCode || null,
        units_per_box: unitsPerBox,
        location_prefix: locationPrefix,
        grn_batch_mfg: grnBatchMfg,
        expiry: expiry || null,
        mfg_batch: mfgBatch,
        box_index: boxIndex,
      };
      const qrPayload = JSON.stringify(payload);
      const qrImageDataUrl = await QRCode.toDataURL(qrPayload, { type: 'image/png', margin: 2 });
      labels.push({ boxIndex, qrPayload, qrImageDataUrl });
    }

    await row.update({ generated_labels: labels });
    res.json({ labels });
  } catch (err) {
    console.error('[mrn] generateLabels error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate labels' });
  }
}

/**
 * GET /api/v1/mrn/:id/location-history
 * Returns movement history entries linked to this MRN (source_mrn_id), e.g. MRN_IN_MU put-away at MU.
 */
async function getLocationHistory(req, res) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const rows = await WarehouseInventoryLocationHistory.findAll({
      where: { source_mrn_id: id },
      order: [['moved_at', 'DESC']],
    });
    const history = rows.map((r) => {
      const h = r.get ? r.get({ plain: true }) : r;
      return {
        id: h.id,
        warehouseInventoryId: h.warehouse_inventory_id,
        itemType: h.item_type,
        rawMaterialId: h.raw_material_id,
        packMaterialId: h.pack_material_id,
        productId: h.product_id,
        fromZone: h.from_zone,
        fromRack: h.from_rack,
        toZone: h.to_zone,
        toRack: h.to_rack,
        qtyDelta: h.qty_delta != null ? Number(h.qty_delta) : null,
        actionType: h.action_type ?? null,
        movedAt: h.moved_at,
      };
    });
    res.json({ history });
  } catch (err) {
    const msg = err && err.message ? String(err.message) : '';
    if (/warehouse_inventory_location_history/i.test(msg)) {
      return res.json({ history: [] });
    }
    console.error('[mrn] getLocationHistory error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch location history' });
  }
}

module.exports = { list, getById, create, update, remove, assignablePickers, generateLabels, getLocationHistory };

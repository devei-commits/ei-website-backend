const { Op } = require('sequelize');
const MaterialRequestNote = require('./models');
const {
  PHASE,
  lineItemId,
  getLineItemIds,
  normalizeLineTransferMap,
  recomputeOutboundMtrAggregateStatus,
  assertSubset,
} = require('./lineTransferStatus');
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

function normalizeMrnStatus(status) {
  if (status == null) return status;
  const s = String(status).trim();
  if (s.toLowerCase() === 'succeeded') return 'Completed';
  return s;
}

/**
 * Outbound MTR (Production transfer orders): allowed status moves. Returns error message or null.
 */
function outboundMtrStatusTransitionError(previousStatus, newStatus) {
  const p = normalizeMrnStatus(previousStatus) || 'Pending';
  const n = normalizeMrnStatus(newStatus) || newStatus;
  const pStr = String(p || '').trim();
  const nStr = String(n || '').trim();

  if (pStr === nStr) return null;

  if (pStr === 'Completed') {
    return 'This transfer is already completed; the status cannot be changed.';
  }

  const allowedPairs = [
    ['Pending', 'Picked'],
    ['Pending', 'In Transit'],
    ['Pending', 'In Transfer'],
    ['Picked', 'In Transit'],
    ['Picked', 'In Transfer'],
    ['In Transfer', 'In Transit'],
    ['In Transit', 'Received at MU'],
    ['Received at MU', 'Completed'],
  ];

  const ok = allowedPairs.some(([a, b]) => a === pStr && b === nStr);
  if (ok) return null;

  const hintByStatus = {
    Pending:
      'First save pick in Warehouse (optional) or in Transfer orders tap Release from warehouse so status becomes In Transit.',
    Picked:
      'Next tap Release from warehouse in Transfer orders to set In Transit (or use Warehouse Initiate transfer, then Release to align to In Transit).',
    'In Transfer':
      'Tap Release from warehouse in Transfer orders to set In Transit, then when goods arrive at MU use Verify / Received at MU.',
    'In Transit':
      'When goods arrive at MU, tap Verify / Received at MU in Transfer orders before completing.',
    'Received at MU':
      'Enter MU zone and MU rack, then tap Mark Succeeded to complete.',
  };

  const hint = hintByStatus[pStr]
    || 'Follow Production → Transfer orders: Release from warehouse → In transit → Received at MU → Mark Succeeded.';
  return `This step cannot be done yet (cannot move from "${pStr}" to "${nStr}"). ${hint}`;
}

function isClosedOutboundMtrStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  return s === 'completed' || s === 'succeeded';
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
  return lineItems.map((line, idx) => {
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
      id: line.id || lineItemId(line, idx),
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
  const isOutboundMtr = d.source === 'MTR' && !d.is_inbound_from_mu;
  const status = isOutboundMtr && String(d.status || '').trim() === 'Completed' ? 'Succeeded' : (d.status || 'Pending');
  const lineTransferStatus = isOutboundMtr
    ? normalizeLineTransferMap(lineItems, d.line_transfer_status, d.status)
    : undefined;
  return {
    id: String(d.id),
    mrnNo: d.mrn_no,
    requestedBy: d.requested_by || '',
    status,
    assignedPicker: d.assigned_picker || '',
    transferTeam: d.transfer_team || '',
    lineItems,
    lineTransferStatus,
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
    logisticsTrackingNo: d.logistics_tracking_no ?? null,
    logisticsTransporter: d.logistics_transporter ?? null,
    logisticsDispatchDate: d.logistics_dispatch_date ?? null,
    logisticsEtaDate: d.logistics_eta_date ?? null,
    logisticsVehicleNo: d.logistics_vehicle_no ?? null,
    createdAt: d.created_at || null,
  };
}

function normalizeLogisticsFields(body = {}) {
  return {
    logistics_tracking_no:
      body.logisticsTrackingNo !== undefined ? body.logisticsTrackingNo : body.logistics_tracking_no,
    logistics_transporter:
      body.logisticsTransporter !== undefined ? body.logisticsTransporter : body.logistics_transporter,
    logistics_dispatch_date:
      body.logisticsDispatchDate !== undefined ? body.logisticsDispatchDate : body.logistics_dispatch_date,
    logistics_eta_date:
      body.logisticsEtaDate !== undefined ? body.logisticsEtaDate : body.logistics_eta_date,
    logistics_vehicle_no:
      body.logisticsVehicleNo !== undefined ? body.logisticsVehicleNo : body.logistics_vehicle_no,
  };
}

function validateRequiredOutboundLogistics(fields) {
  if (!String(fields.logistics_tracking_no || '').trim()) return 'Tracking / LR number is required before initiating transfer.';
  if (!String(fields.logistics_transporter || '').trim()) return 'Transporter / courier is required before initiating transfer.';
  if (!String(fields.logistics_dispatch_date || '').trim()) return 'Dispatch date is required before initiating transfer.';
  if (!String(fields.logistics_eta_date || '').trim()) return 'ETA is required before initiating transfer.';
  if (!String(fields.logistics_vehicle_no || '').trim()) return 'Vehicle number is required before initiating transfer.';
  return null;
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
          attributes: ['line_items', 'status'],
        });
        for (const ex of existing) {
          const exPlain = ex.get ? ex.get({ plain: true }) : ex;
          // Allow a new outbound MTR after the previous one is Succeeded/Completed (split transfers).
          if (isClosedOutboundMtrStatus(exPlain.status)) continue;
          const elis = exPlain.line_items;
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
      status: normalizeMrnStatus(body.status || 'Pending'),
      assigned_picker: body.assignedPicker ?? body.assigned_picker,
      transfer_team: body.transferTeam ?? body.transfer_team,
      line_items: lineItems,
      notes: body.notes ?? body.notes,
      bmr_no: body.bmrNo ?? body.bmr_no ?? null,
      source: body.source ?? null,
      is_inbound_from_mu: body.isInboundFromMu ?? body.is_inbound_from_mu ?? false,
    };
    if (sourceForMtr === 'MTR' && bmrNoForMtr && !inboundMu && lineItems.length > 0) {
      const o = {};
      lineItems.forEach((li, idx) => {
        o[lineItemId(li, idx)] = PHASE.NOT_INITIATED;
      });
      payload.line_transfer_status = o;
    }
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
    if (body.status !== undefined) updates.status = normalizeMrnStatus(body.status);
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
    const logisticsFields = normalizeLogisticsFields(body);
    if (logisticsFields.logistics_tracking_no !== undefined) updates.logistics_tracking_no = logisticsFields.logistics_tracking_no;
    if (logisticsFields.logistics_transporter !== undefined) updates.logistics_transporter = logisticsFields.logistics_transporter;
    if (logisticsFields.logistics_dispatch_date !== undefined) updates.logistics_dispatch_date = logisticsFields.logistics_dispatch_date;
    if (logisticsFields.logistics_eta_date !== undefined) updates.logistics_eta_date = logisticsFields.logistics_eta_date;
    if (logisticsFields.logistics_vehicle_no !== undefined) updates.logistics_vehicle_no = logisticsFields.logistics_vehicle_no;

    const plainBefore = row.get ? row.get({ plain: true }) : row;

    const existingPicker = String(plainBefore.assigned_picker || '').trim();
    if (existingPicker && updates.assigned_picker !== undefined) {
      const incoming = String(updates.assigned_picker || '').trim();
      if (incoming !== existingPicker) {
        return res.status(400).json({ error: 'Picker is already assigned and cannot be changed.' });
      }
      delete updates.assigned_picker;
    }
    const previousStatus = normalizeMrnStatus(plainBefore.status || '');
    const isOutboundMtr =
      plainBefore.source === 'MTR' &&
      !plainBefore.is_inbound_from_mu;

    // Keep assigned_picker / transfer_team for outbound MTR — warehouse assigns picker before split sends; must survive refresh.

    const lineItemsMerged = updates.line_items !== undefined ? updates.line_items : plainBefore.line_items;

    let outboundCompleteLines = null;

    if (isOutboundMtr && Array.isArray(lineItemsMerged) && lineItemsMerged.length > 0) {
      const b = req.body || {};
      const initiateIds = Array.isArray(b.initiateTransferLineIds)
        ? b.initiateTransferLineIds.map(String)
        : Array.isArray(b.initiate_transfer_line_ids)
          ? b.initiate_transfer_line_ids.map(String)
          : null;
      const receiveIds = Array.isArray(b.receiveAtMuLineIds)
        ? b.receiveAtMuLineIds.map(String)
        : Array.isArray(b.receive_at_mu_line_ids)
          ? b.receive_at_mu_line_ids.map(String)
          : null;
      const completeIdsRaw = Array.isArray(b.completeTransferLineIds)
        ? b.completeTransferLineIds.map(String)
        : Array.isArray(b.complete_transfer_line_ids)
          ? b.complete_transfer_line_ids.map(String)
          : null;

      let map = normalizeLineTransferMap(
        lineItemsMerged,
        plainBefore.line_transfer_status,
        plainBefore.status
      );
      const idSet = new Set(getLineItemIds(lineItemsMerged));
      let touched = false;

      if (initiateIds && initiateIds.length > 0) {
        const mergedLogistics = {
          logistics_tracking_no:
            updates.logistics_tracking_no !== undefined ? updates.logistics_tracking_no : plainBefore.logistics_tracking_no,
          logistics_transporter:
            updates.logistics_transporter !== undefined ? updates.logistics_transporter : plainBefore.logistics_transporter,
          logistics_dispatch_date:
            updates.logistics_dispatch_date !== undefined ? updates.logistics_dispatch_date : plainBefore.logistics_dispatch_date,
          logistics_eta_date:
            updates.logistics_eta_date !== undefined ? updates.logistics_eta_date : plainBefore.logistics_eta_date,
          logistics_vehicle_no:
            updates.logistics_vehicle_no !== undefined ? updates.logistics_vehicle_no : plainBefore.logistics_vehicle_no,
        };
        const logisticsErr = validateRequiredOutboundLogistics(mergedLogistics);
        if (logisticsErr) return res.status(400).json({ error: logisticsErr });
        const err = assertSubset(initiateIds, idSet);
        if (err) return res.status(400).json({ error: err });
        for (const sid of initiateIds) {
          if (map[sid] !== PHASE.NOT_INITIATED) {
            return res.status(400).json({
              error: `Line ${sid} cannot initiate transfer (current: ${map[sid]}).`,
            });
          }
          map[sid] = PHASE.IN_TRANSIT;
          touched = true;
        }
      }

      const reqStEarly = updates.status !== undefined ? normalizeMrnStatus(updates.status) : null;
      if (!touched && reqStEarly === 'In Transit' && (!initiateIds || initiateIds.length === 0)) {
        for (const lid of getLineItemIds(lineItemsMerged)) {
          if (map[lid] === PHASE.NOT_INITIATED) {
            map[lid] = PHASE.IN_TRANSIT;
            touched = true;
          }
        }
      }

      if (receiveIds && receiveIds.length > 0) {
        const err = assertSubset(receiveIds, idSet);
        if (err) return res.status(400).json({ error: err });
        for (const sid of receiveIds) {
          if (map[sid] !== PHASE.IN_TRANSIT) {
            return res.status(400).json({
              error: `Line ${sid} cannot mark received at MU (current: ${map[sid]}).`,
            });
          }
          map[sid] = PHASE.RECEIVED_AT_MU;
          touched = true;
        }
      }

      if (reqStEarly === 'Received at MU' && (!receiveIds || receiveIds.length === 0)) {
        for (const lid of getLineItemIds(lineItemsMerged)) {
          if (map[lid] === PHASE.IN_TRANSIT) {
            map[lid] = PHASE.RECEIVED_AT_MU;
            touched = true;
          }
        }
      }

      const wantsComplete = updates.status !== undefined && normalizeMrnStatus(updates.status) === 'Completed';

      if (wantsComplete) {
        const muZ =
          updates.mu_receive_zone !== undefined ? updates.mu_receive_zone : plainBefore.mu_receive_zone;
        const muR =
          updates.mu_receive_rack !== undefined ? updates.mu_receive_rack : plainBefore.mu_receive_rack;
        if (!String(muZ || '').trim() || !String(muR || '').trim()) {
          return res.status(400).json({
            error: 'MU zone and MU rack are required before completing this transfer.',
          });
        }

        const mapC = { ...map };
        const toComplete =
          completeIdsRaw && completeIdsRaw.length > 0
            ? completeIdsRaw
            : getLineItemIds(lineItemsMerged).filter((lid) => mapC[lid] === PHASE.RECEIVED_AT_MU);

        if (toComplete.length === 0) {
          return res.status(400).json({
            error:
              'No lines are in received_at_mu state to complete. Mark lines as received at MU first.',
          });
        }
        const err = assertSubset(toComplete, idSet);
        if (err) return res.status(400).json({ error: err });
        for (const sid of toComplete) {
          if (mapC[sid] !== PHASE.RECEIVED_AT_MU) {
            return res.status(400).json({
              error: `Line ${sid} must be received at MU before complete (current: ${mapC[sid]}).`,
            });
          }
          mapC[sid] = PHASE.COMPLETED;
        }
        updates.line_transfer_status = mapC;
        updates.status = recomputeOutboundMtrAggregateStatus(lineItemsMerged, mapC, plainBefore.status);

        outboundCompleteLines = lineItemsMerged.filter((li, idx) =>
          toComplete.includes(lineItemId(li, idx))
        );
      } else if (touched) {
        updates.line_transfer_status = map;
        updates.status = recomputeOutboundMtrAggregateStatus(lineItemsMerged, map, plainBefore.status);
      }
    }

    const newStatus = normalizeMrnStatus(updates.status !== undefined ? updates.status : previousStatus);
    const mergedZone =
      updates.mu_receive_zone !== undefined ? updates.mu_receive_zone : plainBefore.mu_receive_zone;
    const mergedRack =
      updates.mu_receive_rack !== undefined ? updates.mu_receive_rack : plainBefore.mu_receive_rack;

    if (isOutboundMtr && updates.status !== undefined && outboundCompleteLines == null) {
      const terr = outboundMtrStatusTransitionError(previousStatus, newStatus);
      if (terr) {
        return res.status(400).json({ error: terr });
      }
    }

    if (newStatus === 'Completed' && previousStatus !== 'Completed' && isOutboundMtr && outboundCompleteLines == null) {
      if (previousStatus !== 'Received at MU') {
        return res.status(400).json({
          error: 'Status must be Received at MU before completing this transfer.',
        });
      }
      const z = String(mergedZone || '').trim();
      const r = String(mergedRack || '').trim();
      if (!z || !r) {
        return res.status(400).json({
          error: 'MU zone and MU rack are required before completing this transfer.',
        });
      }
    }

    if (
      newStatus === 'Completed' &&
      previousStatus !== 'Completed' &&
      plainBefore.source === 'MTR' &&
      !(plainBefore.is_inbound_from_mu === true || plainBefore.is_inbound_from_mu === 1)
    ) {
      const z = String(mergedZone || '').trim();
      const r = String(mergedRack || '').trim();
      if (!z || !r) {
        return res.status(400).json({
          error: 'MU zone and MU rack are required before completing this transfer.',
        });
      }
    }

    await row.update(updates);
    const refreshed = await MaterialRequestNote.findByPk(id);
    const d = refreshed.get ? refreshed.get({ plain: true }) : refreshed;

    if (Array.isArray(outboundCompleteLines) && outboundCompleteLines.length > 0) {
      const invPlain = {
        ...d,
        line_items: outboundCompleteLines,
      };
      await applyMrnCompletionToInventory(invPlain);
      if (d.mu_receive_zone || d.mu_receive_rack) {
        await logMrnReceiveAtMuLocation(invPlain);
      }
      await applyMtrCompletionToProductionBatch(d);
    } else if (newStatus === 'Completed' && previousStatus !== 'Completed' && d.source === 'MTR' && d.bmr_no) {
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
function mtrRowHasIncompleteLineForKind(plain, kind) {
  const lis = plain.line_items || [];
  if (kind === 'rm' && !lineItemsIndicateRm(lis)) return false;
  if (kind === 'pm' && !lineItemsIndicatePm(lis)) return false;
  // Header Completed = whole MTR done; do not let stale per-line maps block Production rm_connected.
  if (isClosedOutboundMtrStatus(plain.status)) return false;
  const map = normalizeLineTransferMap(lis, plain.line_transfer_status, plain.status);
  for (let i = 0; i < lis.length; i++) {
    const li = lis[i];
    const isKind = kind === 'rm' ? lineItemsIndicateRm([li]) : lineItemsIndicatePm([li]);
    if (!isKind) continue;
    if (map[lineItemId(li, i)] !== PHASE.COMPLETED) return true;
  }
  return false;
}

async function hasPendingMtrOfKind(bmrNo, kind) {
  const rows = await MaterialRequestNote.findAll({
    where: {
      bmr_no: bmrNo,
      source: 'MTR',
      [Op.or]: [{ is_inbound_from_mu: false }, { is_inbound_from_mu: null }],
    },
    attributes: ['line_items', 'status', 'line_transfer_status'],
  });
  return rows.some((row) => {
    const plain = row.get ? row.get({ plain: true }) : row;
    return mtrRowHasIncompleteLineForKind(plain, kind);
  });
}

function normalizeItemCodeKey(value) {
  return String(value || '').trim().toUpperCase();
}

function aggregateRequiredByCode(lines) {
  const map = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    const key = normalizeItemCodeKey(line?.code);
    if (!key) continue;
    const qty = Number(line?.required) || 0;
    if (qty <= 0) continue;
    map.set(key, (map.get(key) || 0) + qty);
  }
  return map;
}

function aggregateMovedByCodeFromMrnPlain(plain, kind) {
  const map = new Map();
  const lineItems = Array.isArray(plain?.line_items) ? plain.line_items : [];
  const lineMap = normalizeLineTransferMap(lineItems, plain.line_transfer_status, plain.status);
  const headerCompleted = isClosedOutboundMtrStatus(plain?.status);
  for (let i = 0; i < lineItems.length; i++) {
    const li = lineItems[i];
    const isKind = kind === 'rm' ? lineItemsIndicateRm([li]) : lineItemsIndicatePm([li]);
    if (!isKind) continue;
    const id = lineItemId(li, i);
    if (!headerCompleted && lineMap[id] !== PHASE.COMPLETED) continue;
    const key =
      normalizeItemCodeKey(li?.itemCode) ||
      normalizeItemCodeKey(li?.code) ||
      normalizeItemCodeKey(li?.item);
    if (!key) continue;
    const qty = Number(li?.quantity) || 0;
    if (qty <= 0) continue;
    map.set(key, (map.get(key) || 0) + qty);
  }
  return map;
}

function aggregateMovedByCodeFromMrnRows(rows, kind) {
  const map = new Map();
  for (const row of rows) {
    const plain = row.get ? row.get({ plain: true }) : row;
    const part = aggregateMovedByCodeFromMrnPlain(plain, kind);
    for (const [k, v] of part.entries()) {
      map.set(k, (map.get(k) || 0) + v);
    }
  }
  return map;
}

function isRequirementSatisfied(requiredMap, movedMap) {
  if (requiredMap.size === 0) return true;
  for (const [key, required] of requiredMap.entries()) {
    const moved = Number(movedMap.get(key) || 0);
    if (moved + 1e-6 < Number(required)) return false;
  }
  return true;
}

/**
 * After outbound MTR MRN is marked Completed and WH→MU stock is applied, allow Production to enter RM/PM dispensing:
 * set rm_connected / pm_connected and advance BMR/BPR status to `dispensing` / `pm_dispensing`
 * only when no other pending MTR of that kind remains.
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

  // Aggregate moved qty from all closed outbound MTRs so split dispatches do not mark
  // RM/PM connected until cumulative moved qty meets required batch quantities.
  const mtrRows = await MaterialRequestNote.findAll({
    where: {
      bmr_no: plainMrn.bmr_no,
      source: 'MTR',
      [Op.or]: [{ is_inbound_from_mu: false }, { is_inbound_from_mu: null }],
    },
    attributes: ['line_items', 'status', 'line_transfer_status'],
  });

  const requiredRm = aggregateRequiredByCode(Array.isArray(plain.dispensing_rm) ? plain.dispensing_rm : []);
  const requiredPm = aggregateRequiredByCode(Array.isArray(plain.dispensing_pm) ? plain.dispensing_pm : []);
  const movedRm = aggregateMovedByCodeFromMrnRows(mtrRows, 'rm');
  const movedPm = aggregateMovedByCodeFromMrnRows(mtrRows, 'pm');

  if (hasRm) {
    const pendingRm = await hasPendingMtrOfKind(plainMrn.bmr_no, 'rm');
    const rmSatisfied = isRequirementSatisfied(requiredRm, movedRm);
    if (!pendingRm && rmSatisfied) {
      updates.rm_connected = true;
      /**
       * CRITICAL PRODUCTION STATE TRANSITION
       * Do not change this mapping (or move it elsewhere) without explicit programmer consent.
       *
       * Contract:
       * - Outbound MTR (WH -> MU) completes for the RM lines of this production batch.
       * - When there are NO other pending RM MTRs for this BMR AND required RM qty is satisfied
       *   (based on cumulative moved qty vs dispensing_rm requirements),
       *   we must advance BMR into the dispensing stage.
       *
       * UI + downstream workflow assume:
       *   rm_connected -> dispensing (this is the "unlock" moment)
       */
      if (['rm_reserved', 'scheduled', 'rm_connected'].includes(plain.bmr_status)) {
        updates.bmr_status = 'dispensing';
      }
    }
  }
  if (hasPm) {
    const pendingPm = await hasPendingMtrOfKind(plainMrn.bmr_no, 'pm');
    const pmSatisfied = isRequirementSatisfied(requiredPm, movedPm);
    if (!pendingPm && pmSatisfied) {
      updates.pm_connected = true;
      /**
       * CRITICAL PRODUCTION STATE TRANSITION
       * Do not change this mapping (or move it elsewhere) without explicit programmer consent.
       *
       * Contract:
       * - Outbound MTR (WH -> MU) completes for the PM lines of this production batch.
       * - When there are NO other pending PM MTRs for this BMR AND required PM qty is satisfied
       *   (based on cumulative moved qty vs dispensing_pm requirements),
       *   we must advance BPR into the PM dispensing stage.
       */
      if (['pm_reserved', 'pm_connected'].includes(plain.bpr_status)) {
        updates.bpr_status = 'pm_dispensing';
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

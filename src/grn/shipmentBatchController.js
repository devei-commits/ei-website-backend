/**
 * Shipment Batch + GRN-stage endpoints (Procurement spec §4A/§4B/§7).
 *  - initiateTransit       §4A per-line  → 1 SB + 1 GRN
 *  - consolidatedShipment  §4B multi-item → 1 SB + N GRNs (same truck)
 *  - getShipmentBatch                     → SB detail + sibling GRNs
 *  - advanceGrnStage                      → move a GRN through the 6 stages
 */
const db = require('../../db');
const GoodsReceivedNote = require('./models');
const ShipmentBatch = require('./shipmentBatch.model');
const PurchaseOrder = require('../purchaseOrders/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');

const STAGE_ORDER = ['in_transit', 'landed', 'verified', 'quarantined', 'qc_tested', 'grn_completed'];

function normCode(c) { return String(c ?? '').trim().toLowerCase(); }

/** Load the linked PO's line items (source of authoritative RM/PM FKs) once per shipment. */
async function loadPoItems(poId, transaction) {
  if (poId == null || poId === '') return [];
  try {
    const po = await PurchaseOrder.findByPk(poId, { attributes: ['items'], transaction });
    const items = po && po.get ? po.get('items') : null;
    return Array.isArray(items) ? items : [];
  } catch (err) {
    return [];
  }
}

/** Copy the RM/PM FK + unit from the matching PO line (by code, then name). */
function findPoLineMaterial(poItems, item) {
  const items = Array.isArray(poItems) ? poItems : [];
  const code = normCode(item && item.code);
  const name = String((item && item.name) || '').trim().toLowerCase();
  let m = null;
  if (code) m = items.find((l) => normCode(l.code) === code);
  if (!m && name) m = items.find((l) => String(l.name || '').trim().toLowerCase() === name);
  if (!m) return null;
  const rm = m.raw_material_id != null ? Number(m.raw_material_id) : null;
  const pm = m.pack_material_id != null ? Number(m.pack_material_id) : null;
  if (rm == null && pm == null) return null;
  return { raw_material_id: rm, pack_material_id: pm, unit: m.unit ?? m.uom ?? m.UOM ?? null };
}

/** Ordered quantity from the matching PO line (by code, then name) — the true "PO Qty". */
function findPoLineOrderedQty(poItems, item) {
  const items = Array.isArray(poItems) ? poItems : [];
  const code = normCode(item && item.code);
  const name = String((item && item.name) || '').trim().toLowerCase();
  let m = null;
  if (code) m = items.find((l) => normCode(l.code) === code);
  if (!m && name) m = items.find((l) => String(l.name || '').trim().toLowerCase() === name);
  if (!m) return null;
  const q = Number(m.quantity ?? m.qty ?? m.reqQty);
  return Number.isFinite(q) && q > 0 ? q : null;
}

/** Fallback: resolve the FK from the RM/PM master by code when the PO line carries none. */
async function findMasterMaterial(item, transaction) {
  const code = String((item && item.code) || '').trim();
  if (!code) return null;
  const type = String((item && item.type) || '').trim().toUpperCase();
  try {
    if (type !== 'PM') {
      const rm = await RawMaterial.findOne({ where: { code }, attributes: ['id', 'uom'], transaction });
      if (rm) return { raw_material_id: Number(rm.get('id')), pack_material_id: null, unit: rm.get('uom') || null };
    }
    if (type !== 'RM') {
      const pm = await PackMaterial.findOne({ where: { code }, attributes: ['id', 'unit'], transaction });
      if (pm) return { raw_material_id: null, pack_material_id: Number(pm.get('id')), unit: pm.get('unit') || null };
    }
  } catch (err) { /* degrade — line stays unlinked */ }
  return null;
}

/**
 * Resolve the RM/PM FK for a shipment line so the in-transit GRN is counted by Planning's
 * Items Involved stage-flow (getGrnInTransitQtyByKey keys strictly by raw_material_id/pack_material_id).
 * Without this, a freshly-shipped GRN contributes 0 to In-Transit until a later enrichment runs.
 */
async function resolveShipmentLineMaterial(poItems, item, transaction) {
  return (
    findPoLineMaterial(poItems, item) ||
    (await findMasterMaterial(item, transaction)) ||
    { raw_material_id: null, pack_material_id: null, unit: null }
  );
}

function stageToStatus(stage) {
  if (stage === 'grn_completed') return 'GRN Complete';
  if (stage === 'in_transit') return 'In Transit';
  return 'Under GRN';
}
function pad4(n) { return String(n).padStart(4, '0'); }
function yearNow() { return new Date().getFullYear(); }

function formatSb(sb) {
  const d = sb.get ? sb.get({ plain: true }) : sb;
  return {
    id: d.id, code: d.code, purchaseOrderId: d.purchase_order_id, poNo: d.po_no, vendor: d.vendor,
    vehicleNo: d.vehicle_no, driverName: d.driver_name, driverPhone: d.driver_phone, transporter: d.transporter,
    shippedDate: d.shipped_date, vendorInvoiceNo: d.vendor_invoice_no, expectedArrival: d.expected_arrival,
    totalQty: d.total_qty != null ? Number(d.total_qty) : null, lineCount: d.line_count,
  };
}
function formatGrnLite(g) {
  const d = g.get ? g.get({ plain: true }) : g;
  return {
    id: d.id, grnNo: d.grn_no, poNo: d.po_no, vendor: d.vendor, type: d.type,
    shipmentBatchId: d.shipment_batch_id, stage: d.stage, status: d.status,
    shippedQty: d.shipped_qty != null ? Number(d.shipped_qty) : null,
    expectedDate: d.expected_date, lineItems: d.line_items || [],
    workflowSteps: d.workflow_steps || [],
  };
}

async function createGrnRow({ sb, poId, poNo, vendor, item, shippedQty, expectedArrival, poItems, transaction }) {
  const qty = shippedQty != null ? Number(shippedQty) : null;
  // Stamp the RM/PM FK at creation so this in-transit GRN is counted by Planning immediately.
  const mat = await resolveShipmentLineMaterial(poItems, item, transaction);
  // poQty = the true ordered quantity from the PO line; shippedQty = what left on this truck.
  // Falls back to the shipped qty only when the PO line can't be matched (unlinked shipment).
  const orderedQty = findPoLineOrderedQty(poItems, item);
  const lineItem = {
    item: item ? (item.name || '') : '',
    itemCode: item ? (item.code || '') : '',
    poQty: orderedQty != null ? orderedQty : (qty || 0),
    shippedQty: qty || 0,
    rcvdQty: 0,
    invoiceQty: 0,
  };
  if (mat.raw_material_id != null) lineItem.raw_material_id = mat.raw_material_id;
  if (mat.pack_material_id != null) lineItem.pack_material_id = mat.pack_material_id;
  if (mat.unit) lineItem.unit = mat.unit;
  const grn = await GoodsReceivedNote.create({
    grn_no: 'GRN-PENDING',
    purchase_order_id: poId || null,
    po_no: poNo || null,
    vendor: vendor || null,
    type: item && item.type ? item.type : null,
    items: 1,
    shipment_batch_id: sb.id,
    stage: 'in_transit',
    status: 'In Transit',
    shipped_qty: qty,
    expected_date: expectedArrival || null,
    line_items: [lineItem],
    workflow_steps: [{ stage: 'in_transit', at: new Date().toISOString() }],
  }, { transaction });
  grn.grn_no = `GRN-${yearNow()}-${pad4(grn.id)}`;
  await grn.save({ transaction });
  return grn;
}

async function createShipmentBatch({ body, totalQty, lineCount, transaction }) {
  const v = body.vehicle || {};
  const sb = await ShipmentBatch.create({
    code: 'SB-PENDING',
    purchase_order_id: body.poId || null,
    po_no: body.poNo || null,
    vendor: body.vendor || null,
    vehicle_no: v.vehicleNo || null,
    driver_name: v.driverName || null,
    driver_phone: v.driverPhone || null,
    transporter: v.transporter || null,
    shipped_date: v.shippedDate || null,
    vendor_invoice_no: v.vendorInvoiceNo || null,
    expected_arrival: v.expectedArrival || null,
    total_qty: totalQty,
    line_count: lineCount,
  }, { transaction });
  sb.code = `SB-${yearNow()}-${pad4(sb.id)}`;
  await sb.save({ transaction });
  return sb;
}

function poLineQty(l) {
  const q = Number(l && (l.quantity ?? l.qty ?? l.reqQty ?? l.quantity_requested));
  return Number.isFinite(q) && q > 0 ? q : 0;
}

/** Match the frontend normItemKeyForLead: lowercase, trim, collapse internal whitespace. */
function normConnKey(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Build a norm-keyed { code|name -> YYYY-MM-DD } map from a PO's form_data.connectingDateByItem. */
function connectingMapFromFormData(formData) {
  const fd = formData && typeof formData === 'object' && !Array.isArray(formData) ? formData : {};
  const raw = fd.connectingDateByItem;
  const map = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v.trim()) map[normConnKey(k)] = v.trim();
    }
  }
  return map;
}

/**
 * Connecting date == expected date. When a PO's per-item connecting dates are edited
 * (form_data.connectingDateByItem), push each date onto the matching active GRN's
 * expected_date so the Warehouse GRN tracker stays in sync. Matches a GRN to its line by
 * item code, then name. No-op for lines with no override / no GRN yet.
 * @returns {Promise<{updated:number}>}
 */
async function syncGrnExpectedDatesForPo(poId, formData) {
  const id = Number(poId);
  if (!Number.isFinite(id) || id <= 0) return { updated: 0 };
  const map = connectingMapFromFormData(formData);
  if (!Object.keys(map).length) return { updated: 0 };

  const grns = await GoodsReceivedNote.findAll({
    where: { purchase_order_id: id, lifecycle_status: 'active' },
  });
  let updated = 0;
  for (const grn of grns) {
    const li = Array.isArray(grn.get('line_items')) ? grn.get('line_items') : [];
    // A GRN's expected_date = the LATEST connecting date across its matched lines
    // (it isn't fully connected until every item on it lands).
    let date = null;
    for (const l of li) {
      const d = map[normConnKey(l && l.itemCode)] ?? map[normConnKey(l && l.item)];
      if (d && (!date || d > date)) date = d; // YYYY-MM-DD compares lexicographically
    }
    if (!date) continue;
    if (String(grn.get('expected_date') || '') === date) continue;
    grn.set('expected_date', date);
    await grn.save();
    updated += 1;
  }
  return { updated };
}

/**
 * Auto-materialize In-Transit GRN rows for a PO whose shipment was just initiated
 * (Procurement "Mark Shipped"). This is what makes the PO surface in Warehouse Inbound →
 * "GRN by PO"; from there the warehouse owns the 6-stage GRN lifecycle.
 *
 * Idempotent by design: no-op when the PO already has ANY active GRN (e.g. the warehouse
 * already ran Initiate Transit / a consolidated shipment), so it never double-creates.
 * Creates one shipment batch + one GRN per PO line, keyed by the PO's RM/PM FKs so Planning
 * counts them as In-Transit immediately.
 *
 * @returns {Promise<{created:number, skipped?:string, sbId?:number}>}
 */
async function autoCreateInTransitGrnForShippedPo(poId) {
  const id = Number(poId);
  if (!Number.isFinite(id) || id <= 0) return { created: 0, skipped: 'bad_id' };

  const existing = await GoodsReceivedNote.findOne({
    where: { purchase_order_id: id, lifecycle_status: 'active' },
    attributes: ['id'],
  });
  if (existing) return { created: 0, skipped: 'grn_exists' };

  const po = await PurchaseOrder.findByPk(id, {
    attributes: ['id', 'order_id', 'vendor_name', 'expected_shipment_date', 'items', 'form_data'],
  });
  if (!po) return { created: 0, skipped: 'no_po' };

  const items = Array.isArray(po.get('items')) ? po.get('items') : [];
  const lines = items.filter(
    (l) => l && (String(l.code || '').trim() || String(l.name || '').trim()),
  );
  if (!lines.length) return { created: 0, skipped: 'no_items' };

  const poNo = po.get('order_id') || null;
  const vendor = po.get('vendor_name') || null;
  const poExpected = po.get('expected_shipment_date') || null;
  // Connecting date == expected date: each GRN's expected_date is the line's connecting-date
  // override when set, else the PO's expected shipment date.
  const connMap = connectingMapFromFormData(po.get('form_data'));
  const lineExpected = (l) =>
    connMap[normConnKey(l.code)] ?? connMap[normConnKey(l.name)] ?? poExpected;

  return db.transaction(async (t) => {
    const totalQty = lines.reduce((s, l) => s + poLineQty(l), 0);
    const sb = await createShipmentBatch({
      body: { poId: id, poNo, vendor, vehicle: { expectedArrival: poExpected } },
      totalQty,
      lineCount: lines.length,
      transaction: t,
    });
    for (const l of lines) {
      await createGrnRow({
        sb,
        poId: id,
        poNo,
        vendor,
        item: { code: l.code, name: l.name, type: l.type },
        shippedQty: poLineQty(l),
        expectedArrival: lineExpected(l),
        poItems: lines,
        transaction: t,
      });
    }
    return { created: lines.length, sbId: sb.id };
  });
}

/** POST /api/v1/grn/initiate-transit — §4A per-line (1 SB + 1 GRN). */
async function initiateTransit(req, res) {
  const t = await db.transaction();
  try {
    const b = req.body || {};
    const item = b.item || {};
    const qty = b.shippedQty != null ? Number(b.shippedQty) : null;
    const poItems = await loadPoItems(b.poId, t);
    const sb = await createShipmentBatch({ body: b, totalQty: qty, lineCount: 1, transaction: t });
    const grn = await createGrnRow({
      sb, poId: b.poId, poNo: b.poNo, vendor: b.vendor, item, shippedQty: qty,
      expectedArrival: (b.vehicle || {}).expectedArrival, poItems, transaction: t,
    });
    await t.commit();
    res.status(201).json({ shipmentBatch: formatSb(sb), grns: [formatGrnLite(grn)] });
  } catch (err) {
    await t.rollback();
    console.error('initiateTransit error', err);
    res.status(500).json({ error: 'Failed to initiate transit' });
  }
}

/** POST /api/v1/grn/consolidated-shipment — §4B multi-item (1 SB + N GRNs). */
async function consolidatedShipment(req, res) {
  const t = await db.transaction();
  try {
    const b = req.body || {};
    const lines = Array.isArray(b.lines) ? b.lines : [];
    if (!lines.length) { await t.rollback(); return res.status(400).json({ error: 'No lines selected for this shipment' }); }
    const totalQty = lines.reduce((s, l) => s + (Number(l.shippedQty) || 0), 0);
    const poItems = await loadPoItems(b.poId, t);
    const sb = await createShipmentBatch({ body: b, totalQty, lineCount: lines.length, transaction: t });
    const grns = [];
    for (const l of lines) {
      grns.push(await createGrnRow({
        sb, poId: b.poId, poNo: b.poNo, vendor: b.vendor,
        item: { code: l.code, name: l.name, type: l.type }, shippedQty: l.shippedQty,
        expectedArrival: (b.vehicle || {}).expectedArrival, poItems, transaction: t,
      }));
    }
    await t.commit();
    res.status(201).json({ shipmentBatch: formatSb(sb), grns: grns.map(formatGrnLite) });
  } catch (err) {
    await t.rollback();
    console.error('consolidatedShipment error', err);
    res.status(500).json({ error: 'Failed to create consolidated shipment' });
  }
}

/** GET /api/v1/grn/shipment-batches/:sbId — SB detail + sibling GRNs. */
async function getShipmentBatch(req, res) {
  try {
    const id = parseInt(req.params.sbId, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const sb = await ShipmentBatch.findByPk(id, { include: [{ model: GoodsReceivedNote, as: 'grns' }] });
    if (!sb) return res.status(404).json({ error: 'Shipment batch not found' });
    const d = sb.get({ plain: true });
    res.json({ ...formatSb(sb), grns: (d.grns || []).map((g) => formatGrnLite(g)) });
  } catch (err) {
    console.error('getShipmentBatch error', err);
    res.status(500).json({ error: 'Failed to fetch shipment batch' });
  }
}

/** PUT /api/v1/grn/:id/stage — advance a GRN through the 6-stage workflow. */
async function advanceGrnStage(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const stage = String((req.body || {}).stage || '');
    if (!STAGE_ORDER.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });
    const grn = await GoodsReceivedNote.findByPk(id);
    if (!grn) return res.status(404).json({ error: 'GRN not found' });

    const plain = grn.get ? grn.get({ plain: true }) : grn;
    const prevStatus = String(plain.status || '').trim();

    // C3: forward-only — a stage can advance or repeat, never regress below the current one.
    const curStageIdx = STAGE_ORDER.indexOf(String(plain.stage || statusToStage(prevStatus)));
    const nextStageIdx = STAGE_ORDER.indexOf(stage);
    if (curStageIdx >= 0 && nextStageIdx < curStageIdx) {
      return res.status(400).json({
        error: `Cannot move GRN back from '${STAGE_ORDER[curStageIdx]}' to '${stage}'.`,
      });
    }

    const actor = String((req.body || {}).actor || '').trim();
    const steps = [
      ...(Array.isArray(grn.workflow_steps) ? grn.workflow_steps : []),
      { stage, at: new Date().toISOString(), ...(actor ? { actor } : {}) },
    ];

    const completing = stage === 'grn_completed' && prevStatus !== 'GRN Complete';
    if (completing) {
      // C3: this endpoint previously marked a GRN Complete WITHOUT booking inventory and
      // WITHOUT the completion gates. Now it enforces the same gates as PUT /grn/:id and
      // books stock through the one canonical inventory path (in a transaction).
      const {
        grnCompletionBlockers,
        applyGrnCompletionToInventory,
        stampPoTrackingForGrn,
      } = require('./controller');
      const blockers = grnCompletionBlockers(plain);
      if (blockers.length > 0) {
        return res.status(400).json({ error: `Cannot mark GRN Complete: ${blockers.join('; ')}.` });
      }
      await db.transaction(async (transaction) => {
        grn.stage = stage;
        grn.status = stageToStatus(stage);
        grn.workflow_steps = steps;
        if (!grn.received_date) grn.received_date = new Date().toISOString().slice(0, 10);
        await grn.save({ transaction });
        const refreshed = await GoodsReceivedNote.findByPk(id, { transaction });
        await applyGrnCompletionToInventory(refreshed, { transaction });
      });
      await stampPoTrackingForGrn(await GoodsReceivedNote.findByPk(id));
      try {
        const { syncWarehouseInTransitAll } = require('../warehouseInventory/inTransitSync');
        await syncWarehouseInTransitAll();
      } catch (e) {
        console.warn('[grn] syncWarehouseInTransitAll after stage-complete failed:', e && e.message ? e.message : e);
      }
    } else {
      grn.stage = stage;
      grn.status = stageToStatus(stage);
      grn.workflow_steps = steps;
      if (stage === 'grn_completed' && !grn.received_date) {
        grn.received_date = new Date().toISOString().slice(0, 10);
      }
      await grn.save();
      // C8: a non-completing stage may move the GRN to 'Under GRN' — stamp po_tracking.
      const { stampPoTrackingForGrn } = require('./controller');
      await stampPoTrackingForGrn(grn);
    }

    const fresh = await GoodsReceivedNote.findByPk(id);
    res.json(formatGrnLite(fresh));
  } catch (err) {
    console.error('advanceGrnStage error', err);
    res.status(500).json({ error: 'Failed to advance GRN stage' });
  }
}

/** Reverse-map a legacy GRN status (no stage yet) → a 6-stage value. */
function statusToStage(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('complete')) return 'grn_completed';
  if (s.includes('hold') || s.includes('quarant')) return 'quarantined';
  if (s.includes('under') || s.includes('qc') || s.includes('test')) return 'qc_tested';
  if (s.includes('transit')) return 'in_transit';
  if (s.includes('land') || s.includes('arriv')) return 'landed';
  return 'in_transit';
}

function formatTrackerRow(g) {
  const d = g.get ? g.get({ plain: true }) : g;
  const sb = d.shipmentBatch || {};
  const li = Array.isArray(d.line_items) && d.line_items[0] ? d.line_items[0] : {};
  return {
    id: d.id,
    grnNo: d.grn_no,
    sbId: d.shipment_batch_id || null,
    sbCode: sb.code || null,
    poNo: d.po_no || null,
    vendor: d.vendor || null,
    type: d.type || null,
    item: { code: li.itemCode || '', name: li.item || '' },
    poQty: Number(li.poQty) || 0,
    shippedQty: d.shipped_qty != null ? Number(d.shipped_qty) : (Number(li.poQty) || 0),
    shippedDate: sb.shipped_date || null,
    expectedDate: d.expected_date || null,
    stage: d.stage || statusToStage(d.status),
    status: d.status || null,
    vehicleNo: sb.vehicle_no || null,
    workflowSteps: d.workflow_steps || [],
  };
}

/** GET /api/v1/grn/tracker?stage=&vendor=&sb= — GRN tracker rows joined to SB (spec View 5). */
async function listGrnTracker(req, res) {
  try {
    const { stage, vendor, sb } = req.query;
    const where = { lifecycle_status: 'active' };
    if (stage) where.stage = String(stage);
    if (vendor) where.vendor = String(vendor);
    const grns = await GoodsReceivedNote.findAll({
      where,
      order: [['created_at', 'DESC']],
      include: [{ model: ShipmentBatch, as: 'shipmentBatch', required: false }],
    });
    let rows = grns.map(formatTrackerRow);
    if (sb) rows = rows.filter((r) => r.sbCode === String(sb));
    res.json(rows);
  } catch (err) {
    console.error('listGrnTracker error', err);
    res.status(500).json({ error: 'Failed to fetch GRN tracker' });
  }
}

module.exports = { initiateTransit, consolidatedShipment, getShipmentBatch, advanceGrnStage, listGrnTracker, autoCreateInTransitGrnForShippedPo, syncGrnExpectedDatesForPo, STAGE_ORDER };

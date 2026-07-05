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

const STAGE_ORDER = ['in_transit', 'landed', 'verified', 'quarantined', 'qc_tested', 'grn_completed'];

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

async function createGrnRow({ sb, poId, poNo, vendor, item, shippedQty, expectedArrival, transaction }) {
  const qty = shippedQty != null ? Number(shippedQty) : null;
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
    line_items: [{
      item: item ? (item.name || '') : '',
      itemCode: item ? (item.code || '') : '',
      poQty: qty || 0,
      rcvdQty: 0,
      invoiceQty: 0,
    }],
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

/** POST /api/v1/grn/initiate-transit — §4A per-line (1 SB + 1 GRN). */
async function initiateTransit(req, res) {
  const t = await db.transaction();
  try {
    const b = req.body || {};
    const item = b.item || {};
    const qty = b.shippedQty != null ? Number(b.shippedQty) : null;
    const sb = await createShipmentBatch({ body: b, totalQty: qty, lineCount: 1, transaction: t });
    const grn = await createGrnRow({
      sb, poId: b.poId, poNo: b.poNo, vendor: b.vendor, item, shippedQty: qty,
      expectedArrival: (b.vehicle || {}).expectedArrival, transaction: t,
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
    const sb = await createShipmentBatch({ body: b, totalQty, lineCount: lines.length, transaction: t });
    const grns = [];
    for (const l of lines) {
      grns.push(await createGrnRow({
        sb, poId: b.poId, poNo: b.poNo, vendor: b.vendor,
        item: { code: l.code, name: l.name, type: l.type }, shippedQty: l.shippedQty,
        expectedArrival: (b.vehicle || {}).expectedArrival, transaction: t,
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
    const existingSteps = Array.isArray(grn.workflow_steps) ? grn.workflow_steps : [];
    const actor = String((req.body || {}).actor || '').trim();
    const steps = [...existingSteps, {
      stage,
      at: new Date().toISOString(),
      ...(actor ? { actor } : {}),
    }];
    grn.stage = stage;
    grn.status = stageToStatus(stage);
    grn.workflow_steps = steps;
    if (stage === 'grn_completed' && !grn.received_date) {
      grn.received_date = new Date().toISOString().slice(0, 10);
    }
    await grn.save();
    res.json(formatGrnLite(grn));
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

module.exports = { initiateTransit, consolidatedShipment, getShipmentBatch, advanceGrnStage, listGrnTracker, STAGE_ORDER };

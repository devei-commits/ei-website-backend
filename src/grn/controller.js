const GoodsReceivedNote = require('./models');
const { User } = require('../users/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { Product } = require('../products/models');

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
    const poQty = Number(line.poQty) || 0;
    const rcvdQty = Number(line.rcvdQty) || 0;
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
    status: d.status || 'Pending',
    lineItems,
    workflowSteps: d.workflow_steps || [],
    invoiceNo: d.invoice_no || null,
    invoiceAmount: d.invoice_amount != null ? Number(d.invoice_amount) : null,
    grnDate: d.grn_date || null,
    noOfBoxes: d.no_of_boxes != null ? Number(d.no_of_boxes) : null,
    unitsPerBox: d.units_per_box != null ? Number(d.units_per_box) : null,
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
    const row = await GoodsReceivedNote.create(payload);
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
    if (body.locationPrefix !== undefined) updates.location_prefix = body.locationPrefix;
    if (body.location_prefix !== undefined) updates.location_prefix = body.location_prefix;
    if (body.grnBatchMfg !== undefined) updates.grn_batch_mfg = body.grnBatchMfg;
    if (body.grn_batch_mfg !== undefined) updates.grn_batch_mfg = body.grn_batch_mfg;
    if (body.expiry !== undefined) updates.expiry = body.expiry;
    if (body.mfgBatch !== undefined) updates.mfg_batch = body.mfgBatch;
    if (body.mfg_batch !== undefined) updates.mfg_batch = body.mfg_batch;
    await row.update(updates);
    const refreshed = await GoodsReceivedNote.findByPk(id);
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
    res.status(204).send();
  } catch (err) {
    console.error('[grn] delete error:', err);
    res.status(500).json({ error: err.message || 'Failed to delete GRN' });
  }
}

/**
 * POST /api/v1/grn/:id/generate-labels
 * Body (optional): noOfBoxes, unitsPerBox, locationPrefix, grnBatchMfg, expiry, mfgBatch.
 * Uses GRN-stored values if not in body. Generates noOfBoxes QR codes (payload: grn_id, units_per_box, location_prefix, grn_batch_mfg, expiry, mfg_batch, box_index).
 * Returns { labels: [{ boxIndex, qrPayload, qrImageDataUrl }] } and stores generated_labels on GRN.
 */
async function generateLabels(req, res) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await GoodsReceivedNote.findByPk(id);
    if (!row) return res.status(404).json({ error: 'GRN not found' });
    const body = req.body || {};
    const d = row.get ? row.get({ plain: true }) : row;
    const noOfBoxes = body.noOfBoxes ?? body.no_of_boxes ?? d.no_of_boxes ?? 1;
    const unitsPerBox = body.unitsPerBox ?? body.units_per_box ?? d.units_per_box ?? 0;
    const locationPrefix = body.locationPrefix ?? body.location_prefix ?? d.location_prefix ?? '';
    const grnBatchMfg = body.grnBatchMfg ?? body.grn_batch_mfg ?? d.grn_batch_mfg ?? '';
    const expiry = body.expiry ?? d.expiry ?? '';
    const mfgBatch = body.mfgBatch ?? body.mfg_batch ?? d.mfg_batch ?? '';

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
        grn_id: id,
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
    console.error('[grn] generateLabels error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate labels' });
  }
}

module.exports = { list, getById, create, update, remove, assignableUsers, generateLabels };

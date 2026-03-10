const { Op } = require('sequelize');
const MaterialRequestNote = require('./models');
const { User } = require('../users/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { Product } = require('../products/models');
const WarehouseInventory = require('../warehouseInventory/models');

/** Usertypes that can be assigned as Picker / Transfer Team (same as GRN). */
const ASSIGNABLE_USERTYPES = ['super_admin', 'admin', 'bd_manager'];

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

    const plainBefore = row.get ? row.get({ plain: true }) : row;
    const previousStatus = plainBefore.status || '';

    await row.update(updates);
    const refreshed = await MaterialRequestNote.findByPk(id);
    const d = refreshed.get ? refreshed.get({ plain: true }) : refreshed;

    const newStatus = updates.status !== undefined ? updates.status : previousStatus;
    if (newStatus === 'Completed' && previousStatus !== 'Completed' && d.source === 'MTR' && d.bmr_no) {
      await applyMrnCompletionToInventory(d);
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
 * When an MRN from MTR is marked Completed, reduce warehouse SIH (consumption).
 * For each line item: find warehouse_inventory by raw_material_id or pack_material_id and decrement wh_stock.
 */
async function applyMrnCompletionToInventory(plainMrn) {
  if (plainMrn.source !== 'MTR' || !plainMrn.bmr_no) return;
  const lineItems = Array.isArray(plainMrn.line_items) ? plainMrn.line_items : [];
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
    const whStock = Number(plain.wh_stock) || 0;
    const ml1 = Number(plain.ml1_stock) || 0;
    const ml2 = Number(plain.ml2_stock) || 0;
    const newWhStock = Math.max(0, whStock - qty);
    const newSih = newWhStock + ml1 + ml2;
    await whRow.update({
      wh_stock: newWhStock,
      stock_in_hand: newSih,
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

module.exports = { list, getById, create, update, remove, assignablePickers };

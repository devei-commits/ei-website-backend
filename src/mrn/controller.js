const MaterialRequestNote = require('./models');
const { User } = require('../users/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { Product } = require('../products/models');

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
  };
}

async function list(req, res) {
  try {
    const rows = await MaterialRequestNote.findAll({
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
    const payload = {
      mrn_no: body.mrnNo || body.mrn_no,
      requested_by: body.requestedBy ?? body.requested_by,
      status: body.status || 'Pending',
      assigned_picker: body.assignedPicker ?? body.assigned_picker,
      transfer_team: body.transferTeam ?? body.transfer_team,
      line_items: body.lineItems ?? body.line_items ?? [],
      notes: body.notes ?? body.notes,
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
    await row.update(updates);
    const refreshed = await MaterialRequestNote.findByPk(id);
    const { rmMap, pmMap, productMap } = await getMastersForLineItems([refreshed]);
    const d = refreshed.get ? refreshed.get({ plain: true }) : refreshed;
    const enriched = enrichMrnLineItems(d.line_items || [], rmMap, pmMap, productMap);
    res.json(formatRow(refreshed, enriched));
  } catch (err) {
    console.error('[mrn] update error:', err);
    res.status(500).json({ error: err.message || 'Failed to update MRN' });
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

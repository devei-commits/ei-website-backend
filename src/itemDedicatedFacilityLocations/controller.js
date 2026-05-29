const { softDeleteInstance, activeRowWhere } = require('../lib/softDelete');
const ItemDedicatedFacilityLocation = require('./models');
const {
  buildItemKey,
  parseItemKey,
  loadZoneRackCodes,
  resolveDedicatedProductionCodes,
  resolveDedicatedWarehouseCodes,
} = require('./service');
const { WarehouseLocation, WarehouseRack } = require('../warehouseLocations/models');

async function assertLocationType(locationId, expectedType) {
  if (!locationId) return null;
  const loc = await WarehouseLocation.findByPk(locationId);
  if (!loc) return 'Invalid zone id';
  const plain = loc.get ? loc.get({ plain: true }) : loc;
  const t = String(plain.location_type || 'warehouse').toLowerCase();
  if (t !== expectedType) {
    return expectedType === 'warehouse'
      ? 'Warehouse default zone must be a warehouse-type location'
      : 'Production default zone must be a production-type location';
  }
  return null;
}

async function assertRackBelongsToZone(rackId, zoneId) {
  if (!rackId) return null;
  const rack = await WarehouseRack.findByPk(rackId);
  if (!rack) return 'Invalid rack id';
  const plain = rack.get ? rack.get({ plain: true }) : rack;
  if (Number(plain.location_id) !== Number(zoneId)) {
    return 'Rack does not belong to the selected zone';
  }
  return null;
}

async function formatRow(row) {
  const d = row.get ? row.get({ plain: true }) : row;
  const wh = await loadZoneRackCodes(d.wh_location_id, d.wh_rack_id);
  const pr = await loadZoneRackCodes(d.prod_location_id, d.prod_rack_id);
  return {
    id: d.id,
    itemKey: d.item_key,
    rawMaterialId: d.raw_material_id,
    packMaterialId: d.pack_material_id,
    productId: d.product_id,
    whLocationId: d.wh_location_id,
    whRackId: d.wh_rack_id,
    prodLocationId: d.prod_location_id,
    prodRackId: d.prod_rack_id,
    whZoneCode: wh.zoneCode,
    whRackCode: wh.rackCode,
    prodZoneCode: pr.zoneCode,
    prodRackCode: pr.rackCode,
  };
}

async function listAll(req, res) {
  try {
    const rows = await ItemDedicatedFacilityLocation.findAll({ order: [['item_key', 'ASC']] });
    const out = [];
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      out.push(await formatRow(row));
    }
    res.json(out);
  } catch (err) {
    console.error('[itemDedicatedFacilityLocations] listAll', err);
    res.status(500).json({ error: err.message || 'Failed to list item locations' });
  }
}

async function upsert(req, res) {
  try {
    const body = req.body || {};
    const itemType = String(body.itemType || body.item_type || '').toLowerCase();
    const itemId = parseInt(String(body.itemId ?? body.item_id ?? ''), 10);
    const whLocationId = body.whLocationId ?? body.wh_location_id;
    const whRackId = body.whRackId ?? body.wh_rack_id;
    const prodLocationId = body.prodLocationId ?? body.prod_location_id;
    const prodRackId = body.prodRackId ?? body.prod_rack_id;

    if (!Number.isFinite(itemId)) {
      return res.status(400).json({ error: 'itemId is required' });
    }
    let keyType = '';
    if (itemType === 'rm' || itemType === 'raw_material') keyType = 'rm';
    else if (itemType === 'pm' || itemType === 'pack_material') keyType = 'pm';
    else if (itemType === 'product' || itemType === 'prod') keyType = 'prod';
    else {
      return res.status(400).json({ error: 'itemType must be rm, pm, or product' });
    }
    const item_key = buildItemKey(keyType, itemId);
    if (!item_key) return res.status(400).json({ error: 'Invalid item' });

    const whLid = whLocationId != null ? parseInt(String(whLocationId), 10) : null;
    const whRid = whRackId != null ? parseInt(String(whRackId), 10) : null;
    const prLid = prodLocationId != null ? parseInt(String(prodLocationId), 10) : null;
    const prRid = prodRackId != null ? parseInt(String(prodRackId), 10) : null;

    if (Number.isFinite(whRid) && !Number.isFinite(whLid)) {
      return res.status(400).json({ error: 'Warehouse zone is required when a warehouse rack is selected' });
    }
    if (Number.isFinite(prRid) && !Number.isFinite(prLid)) {
      return res.status(400).json({ error: 'Production zone is required when a production rack is selected' });
    }

    let err = await assertLocationType(whLid, 'warehouse');
    if (err) return res.status(400).json({ error: err });
    err = await assertRackBelongsToZone(whRid, whLid);
    if (err) return res.status(400).json({ error: err });

    err = await assertLocationType(prLid, 'production');
    if (err) return res.status(400).json({ error: err });
    err = await assertRackBelongsToZone(prRid, prLid);
    if (err) return res.status(400).json({ error: err });

    const payload = {
      item_key,
      raw_material_id: keyType === 'rm' ? itemId : null,
      pack_material_id: keyType === 'pm' ? itemId : null,
      product_id: keyType === 'prod' ? itemId : null,
      wh_location_id: Number.isFinite(whLid) ? whLid : null,
      wh_rack_id: Number.isFinite(whRid) ? whRid : null,
      prod_location_id: Number.isFinite(prLid) ? prLid : null,
      prod_rack_id: Number.isFinite(prRid) ? prRid : null,
    };

    const [row, created] = await ItemDedicatedFacilityLocation.findOrCreate({
      where: { item_key },
      defaults: payload,
    });
    if (!created) {
      await row.update(payload);
    }
    const fresh = await ItemDedicatedFacilityLocation.findByPk(row.id);
    res.status(201).json(await formatRow(fresh));
  } catch (e) {
    console.error('[itemDedicatedFacilityLocations] upsert', e);
    res.status(500).json({ error: e.message || 'Failed to save' });
  }
}

async function remove(req, res) {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await ItemDedicatedFacilityLocation.findByPk(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    await softDeleteInstance(row);
    res.json({ ok: true });
  } catch (e) {
    console.error('[itemDedicatedFacilityLocations] remove', e);
    res.status(500).json({ error: e.message || 'Failed to delete' });
  }
}

async function resolve(req, res) {
  try {
    const lineItems = req.body?.lineItems ?? req.body?.line_items ?? [];
    if (!Array.isArray(lineItems)) {
      return res.status(400).json({ error: 'lineItems array required' });
    }
    const [prod, wh] = await Promise.all([
      resolveDedicatedProductionCodes(lineItems),
      resolveDedicatedWarehouseCodes(lineItems),
    ]);
    res.json({
      prodZoneCode: prod.prodZoneCode,
      prodRackCode: prod.prodRackCode,
      prodOk: prod.ok,
      whZoneCode: wh.whZoneCode,
      whRackCode: wh.whRackCode,
      whOk: wh.ok,
    });
  } catch (e) {
    console.error('[itemDedicatedFacilityLocations] resolve', e);
    res.status(500).json({ error: e.message || 'Failed to resolve' });
  }
}

module.exports = { listAll, upsert, remove, resolve, formatRow, parseItemKey };

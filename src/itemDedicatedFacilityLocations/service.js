const { Op } = require('sequelize');
const ItemDedicatedFacilityLocation = require('./models');
const { WarehouseLocation, WarehouseRack } = require('../warehouseLocations/models');

function buildItemKey(type, id) {
  const t = String(type || '').toLowerCase();
  const n = parseInt(String(id), 10);
  if (!Number.isFinite(n)) return null;
  if (t === 'rm' || t === 'raw_material') return `rm:${n}`;
  if (t === 'pm' || t === 'pack_material') return `pm:${n}`;
  if (t === 'product' || t === 'prod') return `prod:${n}`;
  return null;
}

function parseItemKey(key) {
  const s = String(key || '');
  const m = /^(rm|pm|prod):(\d+)$/.exec(s);
  if (!m) return null;
  const kind = m[1];
  const id = parseInt(m[2], 10);
  if (kind === 'rm') return { raw_material_id: id, pack_material_id: null, product_id: null };
  if (kind === 'pm') return { raw_material_id: null, pack_material_id: id, product_id: null };
  return { raw_material_id: null, pack_material_id: null, product_id: id };
}

async function loadZoneRackCodes(locationId, rackId) {
  if (!locationId) return { zoneCode: null, rackCode: null };
  const zone = await WarehouseLocation.findByPk(locationId);
  if (!zone) return { zoneCode: null, rackCode: null };
  const zPlain = zone.get ? zone.get({ plain: true }) : zone;
  let rackCode = null;
  if (rackId) {
    const rack = await WarehouseRack.findByPk(rackId);
    if (rack) {
      const rPlain = rack.get ? rack.get({ plain: true }) : rack;
      if (rPlain.location_id === zPlain.id) {
        rackCode = rPlain.code || null;
      }
    }
  }
  return { zoneCode: zPlain.code || null, rackCode: rackCode };
}

/**
 * Build maps id -> dedicated row for RM, PM, Product.
 */
async function loadDedicatedMapsForLineItems(lineItems) {
  const rmIds = new Set();
  const pmIds = new Set();
  const prodIds = new Set();
  for (const li of lineItems || []) {
    if (li.raw_material_id != null) rmIds.add(Number(li.raw_material_id));
    if (li.pack_material_id != null) pmIds.add(Number(li.pack_material_id));
    if (li.product_id != null) prodIds.add(Number(li.product_id));
  }
  const or = [];
  if (rmIds.size) or.push({ raw_material_id: [...rmIds] });
  if (pmIds.size) or.push({ pack_material_id: [...pmIds] });
  if (prodIds.size) or.push({ product_id: [...prodIds] });
  if (or.length === 0) {
    return { rm: new Map(), pm: new Map(), prod: new Map() };
  }
  const rows = await ItemDedicatedFacilityLocation.findAll({ where: { [Op.or]: or } });
  const rm = new Map();
  const pm = new Map();
  const prod = new Map();
  for (const row of rows) {
    const d = row.get ? row.get({ plain: true }) : row;
    if (d.raw_material_id != null) rm.set(Number(d.raw_material_id), row);
    if (d.pack_material_id != null) pm.set(Number(d.pack_material_id), row);
    if (d.product_id != null) prod.set(Number(d.product_id), row);
  }
  return { rm, pm, prod };
}

function dedicatedRowForLine(li, maps) {
  if (li.raw_material_id != null) return maps.rm.get(Number(li.raw_material_id)) || null;
  if (li.pack_material_id != null) return maps.pm.get(Number(li.pack_material_id)) || null;
  if (li.product_id != null) return maps.prod.get(Number(li.product_id)) || null;
  return null;
}

/**
 * Strict: every line with an item id must have a dedicated row; all rows must agree on prod zone (and rack when any row has prod_rack_id).
 */
async function resolveDedicatedProductionCodes(lineItems) {
  const items = lineItems || [];
  const maps = await loadDedicatedMapsForLineItems(items);
  const rows = [];
  for (const li of items) {
    if (li.raw_material_id == null && li.pack_material_id == null && li.product_id == null) continue;
    const row = dedicatedRowForLine(li, maps);
    if (!row || !row.prod_location_id) continue;
    rows.push(row);
  }
  if (rows.length === 0) return { prodZoneCode: null, prodRackCode: null, ok: false };

  const prodZones = [];
  const prodRackCodes = [];
  let allHaveRack = true;
  for (const row of rows) {
    const d = row.get ? row.get({ plain: true }) : row;
    // eslint-disable-next-line no-await-in-loop
    const { zoneCode, rackCode } = await loadZoneRackCodes(d.prod_location_id, d.prod_rack_id);
    prodZones.push(zoneCode);
    if (d.prod_rack_id) prodRackCodes.push(rackCode);
    else allHaveRack = false;
  }
  const z0 = prodZones[0];
  if (!z0 || prodZones.some((z) => z !== z0)) {
    return { prodZoneCode: null, prodRackCode: null, ok: false };
  }
  let r0 = null;
  if (allHaveRack && prodRackCodes.length === rows.length) {
    r0 = prodRackCodes[0];
    if (prodRackCodes.some((r) => r !== r0)) {
      return { prodZoneCode: z0, prodRackCode: null, ok: true };
    }
  }
  return { prodZoneCode: z0, prodRackCode: r0, ok: true };
}

/** Same strict rules for warehouse zone/rack codes. */
async function resolveDedicatedWarehouseCodes(lineItems) {
  const items = lineItems || [];
  const maps = await loadDedicatedMapsForLineItems(items);
  const rows = [];
  for (const li of items) {
    if (li.raw_material_id == null && li.pack_material_id == null && li.product_id == null) continue;
    const row = dedicatedRowForLine(li, maps);
    if (!row || !row.wh_location_id) continue;
    rows.push(row);
  }
  if (rows.length === 0) return { whZoneCode: null, whRackCode: null, ok: false };

  const whZones = [];
  const whRackCodes = [];
  let allHaveRack = true;
  for (const row of rows) {
    const d = row.get ? row.get({ plain: true }) : row;
    // eslint-disable-next-line no-await-in-loop
    const { zoneCode, rackCode } = await loadZoneRackCodes(d.wh_location_id, d.wh_rack_id);
    whZones.push(zoneCode);
    if (d.wh_rack_id) whRackCodes.push(rackCode);
    else allHaveRack = false;
  }
  const z0 = whZones[0];
  if (!z0 || whZones.some((z) => z !== z0)) {
    return { whZoneCode: null, whRackCode: null, ok: false };
  }
  let r0 = null;
  if (allHaveRack && whRackCodes.length === rows.length) {
    r0 = whRackCodes[0];
    if (whRackCodes.some((r) => r !== r0)) {
      return { whZoneCode: z0, whRackCode: null, ok: true };
    }
  }
  return { whZoneCode: z0, whRackCode: r0, ok: true };
}

/**
 * When MU receive rack is empty: fill from dedicated prod rack if zone matches current MRN zone (or no zone yet).
 */
async function resolveProductionRackForMrn(lineItems, currentMuZone) {
  const { prodZoneCode, prodRackCode, ok } = await resolveDedicatedProductionCodes(lineItems);
  if (!ok || !prodRackCode) return null;
  const z = String(currentMuZone || '').trim();
  if (z && prodZoneCode && z !== prodZoneCode) return null;
  return prodRackCode;
}

/** Fill production zone/rack on MRN when caller did not set them (MTR outbound). */
async function applyDedicatedDefaultsToNewMrn(lineItems, existingZone, existingRack) {
  const { prodZoneCode, prodRackCode, ok } = await resolveDedicatedProductionCodes(lineItems);
  if (!ok) return {};
  const ez = String(existingZone || '').trim();
  const er = String(existingRack || '').trim();
  const out = {};
  if (!ez && prodZoneCode) out.mu_receive_zone = prodZoneCode;
  if (!er && prodRackCode) {
    const zoneForRack = String(out.mu_receive_zone || ez || '').trim();
    if (!zoneForRack || !prodZoneCode || zoneForRack === prodZoneCode) {
      out.mu_receive_rack = prodRackCode;
    }
  }
  if (out.mu_receive_rack && !out.mu_receive_zone && !ez && prodZoneCode) {
    out.mu_receive_zone = prodZoneCode;
  }
  return out;
}

module.exports = {
  buildItemKey,
  parseItemKey,
  loadZoneRackCodes,
  loadDedicatedMapsForLineItems,
  dedicatedRowForLine,
  resolveDedicatedProductionCodes,
  resolveDedicatedWarehouseCodes,
  resolveProductionRackForMrn,
  applyDedicatedDefaultsToNewMrn,
};

#!/usr/bin/env node
/**
 * Idempotent facility layout:
 *   - 1 Main Warehouse (AREA-WH) → zones LOC-RM, LOC-PM, LOC-FG
 *   - 2 Manufacturing units (AREA-MU-01, AREA-MU-02) → zones LOC-ML1, LOC-ML2
 *
 * Safe to re-run on an existing DB (creates missing rows; updates area links for ML zones).
 *
 * Usage:
 *   node scripts/seed-facility-structure.js
 *   docker compose exec -T app node scripts/seed-facility-structure.js
 */
require('dotenv').config();

const db = require('../db');
const { ensureSchemaPatches } = require('../src/db/ensureSchemaPatches');
const FacilityArea = require('../src/facilityAreas/models');
const { WarehouseLocation, WarehouseRack } = require('../src/warehouseLocations/models');
const { setDefaultLocation, ensureDefaultRackForLocation } = require('../src/facilityAreas/defaultLocationService');
const { ensureFacilityDefaultLocations } = require('../src/facilityAreas/ensureSingleDefaultLocationPerType');
const { removeLegacyParentManufacturingArea } = require('../src/facilityAreas/removeLegacyParentMuArea');

const now = new Date();

const AREAS = [
  {
    code: 'AREA-WH',
    name: 'Main Warehouse',
    area_type: 'warehouse',
    icon: '🏭',
    description: 'Single main warehouse — RM, PM, and FG in separate zones',
  },
  {
    code: 'AREA-MU-01',
    name: 'Manufacturing Unit 1',
    area_type: 'production',
    icon: '⚙️',
    description: 'Manufacturing unit 1 (ML1)',
  },
  {
    code: 'AREA-MU-02',
    name: 'Manufacturing Unit 2',
    area_type: 'production',
    icon: '⚙️',
    description: 'Manufacturing unit 2 (ML2)',
  },
];

const ZONES = [
  {
    code: 'LOC-RM',
    areaCode: 'AREA-WH',
    name: 'RM Store',
    location_type: 'warehouse',
    zone_label: 'RM',
    description: 'Raw materials zone (main warehouse)',
    area_sqm: 380,
    defaultForType: 'warehouse',
  },
  {
    code: 'LOC-PM',
    areaCode: 'AREA-WH',
    name: 'PM Store',
    location_type: 'warehouse',
    zone_label: 'PM',
    description: 'Packaging materials zone (main warehouse)',
    area_sqm: 280,
  },
  {
    code: 'LOC-FG',
    areaCode: 'AREA-WH',
    name: 'Finished Goods Store',
    location_type: 'warehouse',
    zone_label: 'FG',
    description: 'Finished goods / PR zone (main warehouse)',
    area_sqm: 200,
  },
  {
    code: 'LOC-ML1',
    areaCode: 'AREA-MU-01',
    name: 'ML1 — Line 1',
    location_type: 'production',
    zone_label: 'ML1',
    description: 'Manufacturing Unit 1 — ML1',
    area_sqm: 120,
    defaultForType: 'production',
  },
  {
    code: 'LOC-ML2',
    areaCode: 'AREA-MU-02',
    name: 'ML2 — Line 2',
    location_type: 'production',
    zone_label: 'ML2',
    description: 'Manufacturing Unit 2 — ML2',
    area_sqm: 120,
  },
];

const RACKS = [
  { zoneCode: 'LOC-RM', code: 'A1', name: 'RM Rack A1', levels: 4, slots_total: 16 },
  { zoneCode: 'LOC-PM', code: 'PM-R1', name: 'PM Rack 1', levels: 4, slots_total: 16 },
  { zoneCode: 'LOC-FG', code: 'FG-R1', name: 'FG Rack 1', levels: 4, slots_total: 16 },
  { zoneCode: 'LOC-ML1', code: 'ML1-R1', name: 'ML1 rack 1', levels: 2, slots_total: 8 },
  { zoneCode: 'LOC-ML2', code: 'ML2-R1', name: 'ML2 rack 1', levels: 2, slots_total: 8 },
];

async function findOrCreateArea(def) {
  const [row] = await FacilityArea.findOrCreate({
    where: { code: def.code },
    defaults: { ...def, created_at: now, updated_at: now },
  });
  if (row.name !== def.name || row.area_type !== def.area_type) {
    await row.update({ name: def.name, area_type: def.area_type, description: def.description, icon: def.icon, updated_at: now });
  }
  return row;
}

async function findOrCreateZone(def, areaId) {
  let row = await WarehouseLocation.findOne({ where: { code: def.code } });
  if (!row) {
    row = await WarehouseLocation.create({
      code: def.code,
      name: def.name,
      area_id: areaId,
      location_type: def.location_type,
      zone_label: def.zone_label,
      description: def.description,
      area_sqm: def.area_sqm ?? null,
      utilisation_pct: 0,
      is_default: false,
      created_at: now,
      updated_at: now,
    });
  } else if (row.area_id !== areaId) {
    await row.update({
      area_id: areaId,
      name: def.name,
      location_type: def.location_type,
      zone_label: def.zone_label,
      description: def.description,
      updated_at: now,
    });
  }
  return row;
}

async function findOrCreateRack(zoneId, def) {
  const [row] = await WarehouseRack.findOrCreate({
    where: { location_id: zoneId, code: def.code },
    defaults: {
      name: def.name,
      description: def.description || '',
      levels: def.levels,
      slots_total: def.slots_total,
      created_at: now,
      updated_at: now,
    },
  });
  return row;
}

async function main() {
  await ensureSchemaPatches();

  const areaByCode = new Map();
  for (const a of AREAS) {
    const row = await findOrCreateArea(a);
    areaByCode.set(a.code, row.id);
    console.log(`[facility] area ${a.code} (id=${row.id})`);
  }

  const zoneByCode = new Map();
  for (const z of ZONES) {
    const areaId = areaByCode.get(z.areaCode);
    if (!areaId) {
      console.warn(`[facility] skip zone ${z.code}: missing area ${z.areaCode}`);
      continue;
    }
    const row = await findOrCreateZone(z, areaId);
    zoneByCode.set(z.code, row.id);
    console.log(`[facility] zone ${z.code} → area ${z.areaCode}`);
    if (z.defaultForType) {
      await setDefaultLocation(row.id);
      console.log(`[facility] default ${z.defaultForType} zone = ${z.code}`);
    }
    await ensureDefaultRackForLocation(row.id);
  }

  for (const r of RACKS) {
    const zoneId = zoneByCode.get(r.zoneCode);
    if (!zoneId) continue;
    await findOrCreateRack(zoneId, r);
    console.log(`[facility] rack ${r.code} in ${r.zoneCode}`);
  }

  await removeLegacyParentManufacturingArea(areaByCode);

  const defs = await ensureFacilityDefaultLocations();
  if (defs.warehouse) console.log(`[facility] warehouse default = ${defs.warehouse.code}`);
  if (defs.production) console.log(`[facility] production default = ${defs.production.code}`);

  console.log('[facility] Done.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[facility] Fatal:', err?.message || err);
    process.exit(1);
  });

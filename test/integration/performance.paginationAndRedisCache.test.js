/**
 * Integration: server-side pagination + Redis cache-aside (read cache) + invalidation (write).
 *
 * Focus:
 * - Candidate master lists: raw-materials, warehouse-inventory, warehouse-locations, planning-extracted, planning-extracted/items-involved
 * - Redis caching:
 *   - cache hit/miss correctness for raw-materials list pages
 *   - invalidation after PUT /raw-materials/:id
 *   - sync-on-read exclusion: GET /planning-extracted is never cached
 *   - cross-domain invalidation example: GRN Complete invalidates warehouse-inventory reads
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const net = require('net');
const { URL } = require('url');
const { Op } = require('sequelize');

const db = require('../../db');
const app = require('../../app');
const { isDbAvailable } = require('../helpers/dbAvailability');
const { useStaticJwtSecretsForTests } = require('../helpers/jwtTestEnv');

const { User } = require('../../src/users/models');
const RawMaterial = require('../../src/rawMaterials/models');
const PackMaterial = require('../../src/packMaterials/models');
const WarehouseInventory = require('../../src/warehouseInventory/models');
const { WarehouseLocation } = require('../../src/warehouseLocations/models');
const GoodsReceivedNote = require('../../src/grn/models');
const { Product } = require('../../src/products/models');
const SalesOrder = require('../../src/salesOrders/models');
const PlanningExtracted = require('../../src/planningExtracted/models');
const PlanningBatch = require('../../src/planningExtracted/planningBatchModel');
const { ProductionBatch } = require('../../src/production/models');
const { FulfillmentOrder, FulfillmentOrderItem } = require('../../src/fulfillment/models');

const cacheRedis = require('../../src/cache/redis');

describe('Performance pagination + Redis cache-aside', () => {
  let dbAvailable = false;
  let token = null;
  let redisAvailable = false;
  const originalRedisUrl = process.env.REDIS_URL;
  let fulfillmentOrderId = null;

  beforeAll(async () => {
    dbAvailable = await isDbAvailable(db);
    if (!dbAvailable) return;

    useStaticJwtSecretsForTests();

    // Determine if Redis is reachable before we start toggling REDIS_URL.
    redisAvailable = Boolean(originalRedisUrl);
    if (redisAvailable) {
      try {
        const u = new URL(originalRedisUrl);
        const host = u.hostname;
        const port = u.port ? parseInt(u.port, 10) : 6379;
        await new Promise((resolve) => {
          const socket = net.createConnection({ host, port });
          socket.setTimeout(1500);
          socket.on('connect', () => {
            socket.end();
            resolve(true);
          });
          socket.on('error', () => resolve(false));
          socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
          });
        }).then((ok) => {
          redisAvailable = Boolean(ok);
        });
      } catch {
        redisAvailable = false;
      }
    }

    await db.sync({ force: true });

    // Admin user is required for order-management guarded endpoints.
    const user = await User.create({
      fname: 'Test',
      lname: 'User',
      email: 'perf-cache-admin@example.com',
      password: 'hash',
      usertype: 'admin',
    });

    token = jwt.sign(
      {
        email: user.email,
        role: user.usertype || 'admin',
        sub: user.userid,
        id: user.userid,
      },
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: '7d' }
    );

    // Seed raw materials (codes chosen for deterministic sorting).
    // Mix statuses so we can test status+search+pagination interaction.
    const rmCodes = Array.from({ length: 20 }, (_, i) => `EI-RM-PAG-${String(i + 1).padStart(3, '0')}`);
    const rmRecords = [];
    for (let i = 0; i < rmCodes.length; i++) {
      const code = rmCodes[i];
      const status = (i % 2 === 0) ? 'active' : 'inactive';
      rmRecords.push(
        await RawMaterial.create({
          code,
          name: `OldName-${code}`,
          inci: `INC-${code}`,
          category: 'TestCat',
          rm_type: 'RM',
          uom: 'KG',
          price_per_kg: 10,
          gst: 18,
          shelf: '12',
          status,
          products: [],
        })
      );
    }
    // Seed warehouse inventory rows for each RM so warehouse-inventory and planning items-involved work.
    for (const rm of rmRecords) {
      await WarehouseInventory.create({
        item_type: 'RM',
        raw_material_id: rm.id,
        pack_material_id: null,
        product_id: null,
        zone: 'Z1',
        rack: 'R1',
        wh_stock: 10,
        ml1_stock: 0,
        ml2_stock: 0,
        stock_in_hand: 10,
        reserved: 0,
        in_transit: 0,
        reorder_pt: 0,
        avg_mo: 0,
        qc_status: 'In Stock',
        batch_number: null,
        expiry_date: null,
      });
    }

    // Seed pack materials (for pagination/search + cache invalidation tests).
    const pmCodes = Array.from({ length: 20 }, (_, i) => `EI-PM-PAG-${String(i + 1).padStart(3, '0')}`);
    for (const code of pmCodes) {
      await PackMaterial.create({
        code,
        description: `OldDesc-${code}`,
        type: 'Tube',
        level: 'Primary',
        group: 'G1',
        material: 'TestMaterial',
        size_spec: '100',
        price_per_pc: 1.5,
        moq: 1,
        lead_time_days: 1,
        print_status: 'printed',
        products: [],
        zoho_id: null,
        sku: `SKU-${code}`,
        hsn_code: null,
        unit: 'PCS',
        tax_pref: null,
        pkg_returnable: null,
        pkg_associate_items: null,
        sales_purchase_account: null,
        form_data: null,
      });
    }

    // Seed warehouse locations for pagination.
    for (let i = 1; i <= 10; i++) {
      await WarehouseLocation.create({
        code: `LOC-${String(i).padStart(3, '0')}`,
        name: `Location ${i}`,
        location_type: 'warehouse',
      });
    }

    // Seed planning data for planning-extracted pagination + items-involved.
    const product = await Product.create({
      product_code: 'EI-PRD-001',
      product_sku: 'SKU-001',
      product_name: 'Test Product',
      batch_size_kg: 100,
      status: 'Active',
      availability: 'available',
      category: 'FG',
    });

    // Create a few planning_extracted rows directly (sync-on-read won't add more because SalesOrder items will be empty).
    for (let idx = 0; idx < 6; idx++) {
      const so = await SalesOrder.create({
        order_id: `SO-${idx + 1}`,
        customer_name: `Customer-${idx + 1}`,
        order_date: `2026-03-${String(idx + 1).padStart(2, '0')}`,
        expected_shipment_date: `2026-04-${String(idx + 1).padStart(2, '0')}`,
        status: 'open',
        items: [],
      });

      await PlanningExtracted.create({
        sales_order_id: so.id,
        product_id: product.product_id,
        order_qty_display: `${10 + idx} units`,
        total_kg_display: `${1000 + idx * 100} KG`,
        order_date: so.order_date,
        due_date: so.expected_shipment_date,
        batch_size_display: '100 KG',
        batches_required: 1,
        batch_count: 0,
        batch_size_kg: 100,
        bom_status: 'Pending',
        bom_confirmed_at: null,
        approved_by: null,
        raw_materials: [],
        packaging_materials: [],
        custom_batches: [],
        sent_batch_indices: null,
        planned_start_date: null,
        production_line: null,
        color: null,
      });
    }

    // Items-involved pagination: build sent batch(s) for a single planning row.
    // Create 3 additional RMs with distinct codes so out[] sorting is deterministic.
    const rmInvA = await RawMaterial.create({
      code: 'EI-RM-INV-A',
      name: 'RM A',
      inci: 'INC-A',
      category: 'TestCat',
      rm_type: 'RM',
      uom: 'KG',
      price_per_kg: 10,
      gst: 18,
      shelf: '12',
      status: 'active',
      products: [],
    });
    const rmInvB = await RawMaterial.create({
      code: 'EI-RM-INV-B',
      name: 'RM B',
      inci: 'INC-B',
      category: 'TestCat',
      rm_type: 'RM',
      uom: 'KG',
      price_per_kg: 10,
      gst: 18,
      shelf: '12',
      status: 'active',
      products: [],
    });
    const rmInvC = await RawMaterial.create({
      code: 'EI-RM-INV-C',
      name: 'RM C',
      inci: 'INC-C',
      category: 'TestCat',
      rm_type: 'RM',
      uom: 'KG',
      price_per_kg: 10,
      gst: 18,
      shelf: '12',
      status: 'active',
      products: [],
    });

    const rmInvD = await RawMaterial.create({
      code: 'EI-RM-INV-D',
      name: 'RM D',
      inci: 'INC-D',
      category: 'TestCat',
      rm_type: 'RM',
      uom: 'KG',
      price_per_kg: 10,
      gst: 18,
      shelf: '12',
      status: 'active',
      products: [],
    });

    const rmInvE = await RawMaterial.create({
      code: 'EI-RM-INV-E',
      name: 'RM E',
      inci: 'INC-E',
      category: 'TestCat',
      rm_type: 'RM',
      uom: 'KG',
      price_per_kg: 10,
      gst: 18,
      shelf: '12',
      status: 'active',
      products: [],
    });

    for (const rm of [rmInvA, rmInvB, rmInvC, rmInvD, rmInvE]) {
      await WarehouseInventory.create({
        item_type: 'RM',
        raw_material_id: rm.id,
        pack_material_id: null,
        product_id: null,
        zone: 'Z1',
        rack: 'R1',
        wh_stock: 50,
        ml1_stock: 0,
        ml2_stock: 0,
        stock_in_hand: 50,
        reserved: 0,
        in_transit: 0,
        reorder_pt: 0,
        avg_mo: 0,
        qc_status: 'In Stock',
        batch_number: null,
        expiry_date: null,
      });
    }

    // Add one planning batch for items-involved; PI must be BOM-confirmed with full-order RM totals
    // greater than the batch so `totalRequired` (remaining) is non-zero for pagination tests.
    const planningRow = await PlanningExtracted.findOne({ order: [['id', 'ASC']] });
    await planningRow.update({
      bom_confirmed_at: new Date(),
      sent_batch_indices: [0],
      order_qty_display: '10 units',
      total_kg_display: '500 KG',
      raw_materials: [
        { raw_material_id: rmInvA.id, code: rmInvA.code, name: rmInvA.name, quantity: 60, unit: 'KG' },
        { raw_material_id: rmInvB.id, code: rmInvB.code, name: rmInvB.name, quantity: 40, unit: 'KG' },
        { raw_material_id: rmInvC.id, code: rmInvC.code, name: rmInvC.name, quantity: 20, unit: 'KG' },
        { raw_material_id: rmInvD.id, code: rmInvD.code, name: rmInvD.name, quantity: 50, unit: 'KG' },
        { raw_material_id: rmInvE.id, code: rmInvE.code, name: rmInvE.name, quantity: 30, unit: 'KG' },
      ],
      packaging_materials: [],
    });

    await PlanningBatch.create({
      planning_extracted_id: planningRow.id,
      sequence: 1,
      batch_code: `PE-${planningRow.id}-B1`,
      size_kg: 100,
      rm_lines: [
        { raw_material_id: rmInvA.id, pct_w_w: 30, uom: 'KG', inci_name: 'INC-A', rm_code: rmInvA.code, code: rmInvA.code, name: rmInvA.name },
        { raw_material_id: rmInvB.id, pct_w_w: 20, uom: 'KG', inci_name: 'INC-B', rm_code: rmInvB.code, code: rmInvB.code, name: rmInvB.name },
        { raw_material_id: rmInvC.id, pct_w_w: 10, uom: 'KG', inci_name: 'INC-C', rm_code: rmInvC.code, code: rmInvC.code, name: rmInvC.name },
        { raw_material_id: rmInvD.id, pct_w_w: 25, uom: 'KG', inci_name: 'INC-D', rm_code: rmInvD.code, code: rmInvD.code, name: rmInvD.name },
        { raw_material_id: rmInvE.id, pct_w_w: 15, uom: 'KG', inci_name: 'INC-E', rm_code: rmInvE.code, code: rmInvE.code, name: rmInvE.name },
      ],
      pm_lines: [],
    });

    // Seed fulfillment sync-on-read fixtures (GET /fulfillment/:id should reflect production changes).
    const soNoForFulfillment = 'EI-SO-2026-FTL-001';
    const prodBatch = await ProductionBatch.create({
      bmr_no: 'BMR-2026-FTL-001',
      bpr_no: 'BPR-2026-FTL-001',
      product_name: 'Fulfillment Prod 1',
      sku: 'SKU-FULL-1',
      so_no: soNoForFulfillment,
      order_qty: 100,
      batch_size: 10,
      batch_no: null,
      batch_index: 0,
      total_batches: 10,
      planning_batch_id: null,
      bmr_status: 'cleared',
      bpr_status: 'fg_ready',
      color: null,
      process_type: null,
      homogenizer: false,
      main_vessel: null,
      supporting_tanks: null,
      filling_line: null,
      filling_type: null,
      packaging_line: null,
      monocarton: null,
      shrink: null,
      team_bmr: null,
      team_bpr: null,
      qc_officer_bmr: null,
      qc_officer_bpr: null,
      mfg_date: null,
      fill_date: null,
      pack_date: null,
      fg_date: null,
      rm_connect_date: null,
      pm_connect_date: null,
      rm_reserved: false,
      pm_reserved: false,
      rm_connected: false,
      pm_connected: false,
      dispensing_rm: null,
      dispensing_pm: null,
      mu_dispensing_bundle_id: null,
      mu_dispensing_bundles: null,
      bulk_yield: null,
      fill_yield: null,
      fg_yield: null,
      bulk_batch_accepted: null,
      fill_batch_accepted: null,
      fg_batch_accepted: null,
      qc_specs: null,
      remarks: null,
      due_date: null,
      compatible_vessels: null,
      compatible_fill_lines: null,
      compatible_pack_lines: null,
      required_volume_liters: null,
    });

    const fulfillmentOrder = await FulfillmentOrder.create({
      so_no: soNoForFulfillment,
      sales_order_id: null,
      customer_name: 'Fulfillment Customer',
      customer_city: null,
      order_date: null,
      due_date: null,
      priority: 'normal',
      so_status: 'planned',
      so_value: 0,
      ship_address: null,
      payment_terms: null,
      notes: null,
      invoice_no: null,
      invoice_date: null,
      awb_no: null,
      dispatch_date: null,
      courier: null,
    });

    fulfillmentOrderId = fulfillmentOrder.id;

    await FulfillmentOrderItem.create({
      fulfillment_order_id: fulfillmentOrder.id,
      item_no: '001',
      sku: 'SKU-FULL-1',
      product_name: 'Fulfillment Prod 1',
      pack: null,
      ordered_qty: 100,
      rate: 0,
      unit_price: 0,
    });
  });

  afterAll(async () => {
    if (dbAvailable) await db.close();
  });

  test('pagination validation: raw-materials negative limit returns 400', async () => {
    if (!dbAvailable) return;

    process.env.REDIS_URL = '';
    const res = await request(app)
      .get('/api/v1/raw-materials?limit=-1&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  test('pagination validation: raw-materials NaN limit returns 400', async () => {
    if (!dbAvailable) return;

    process.env.REDIS_URL = '';
    const res = await request(app)
      .get('/api/v1/raw-materials?limit=NaN&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  test('pagination validation: raw-materials NaN offset returns 400', async () => {
    if (!dbAvailable) return;

    process.env.REDIS_URL = '';
    const res = await request(app)
      .get('/api/v1/raw-materials?limit=1&offset=NaN')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  test('redis disabled fallback: cached pages are NOT served stale', async () => {
    if (!dbAvailable) return;

    process.env.REDIS_URL = '';

    // Prime would-be cache (no-op when Redis disabled).
    const first = await request(app)
      .get('/api/v1/raw-materials?limit=1&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    const targetCode = first.body.rows[0].code;
    expect(typeof targetCode).toBe('string');

    // Update DB directly; if caching is off, subsequent GET should reflect fresh data.
    const rm1 = await RawMaterial.findOne({ where: { code: targetCode } });
    expect(rm1).toBeTruthy();
    const updatedName = `Updated-${targetCode}`;
    await rm1.update({ name: updatedName });

    const second = await request(app)
      .get('/api/v1/raw-materials?limit=1&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(200);
    expect(second.body.rows[0].code).toBe(targetCode);
    expect(second.body.rows[0].name).toBe(updatedName);
  });

  test('raw-materials pagination + cache hit/miss (when Redis available)', async () => {
    if (!dbAvailable) return;
    if (!redisAvailable) return;

    process.env.REDIS_URL = originalRedisUrl;

    if (originalRedisUrl) {
      try {
        await cacheRedis.delByPattern('raw-materials:');
      } catch {
        // ignore
      }
    }

    const page0 = await request(app)
      .get('/api/v1/raw-materials?limit=1&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(page0.status).toBe(200);
    const code0 = page0.body.rows[0].code;
    expect(typeof code0).toBe('string');

    // Cache is primed for page0. Update RM-001 directly; cached page0 should remain stale.
    const rm0 = await RawMaterial.findOne({ where: { code: code0 } });
    expect(rm0).toBeTruthy();

    const offset1Row = await RawMaterial.findAll({
      attributes: ['code'],
      order: [['code', 'ASC']],
      offset: 1,
      limit: 1,
      raw: true,
    });
    const code1 = offset1Row[0]?.code;
    expect(typeof code1).toBe('string');

    const rm1 = await RawMaterial.findOne({ where: { code: code1 } });
    expect(rm1).toBeTruthy();

    const staleUpdateName = `StaleCheck-Updated-${code0}`;
    const freshUpdateName = `FreshCheck-Updated-${code1}`;
    await rm0.update({ name: staleUpdateName });
    await rm1.update({ name: freshUpdateName });

    const page0Again = await request(app)
      .get('/api/v1/raw-materials?limit=1&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(page0Again.status).toBe(200);
    expect(page0Again.body.rows[0].code).toBe(code0);
    expect(page0Again.body.rows[0].name).not.toBe(staleUpdateName);

    // Different query params (offset=1) must bypass page0 cache entry and reflect fresh DB.
    const page1 = await request(app)
      .get('/api/v1/raw-materials?limit=1&offset=1')
      .set('Authorization', `Bearer ${token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.rows[0].code).toBe(code1);
    expect(page1.body.rows[0].name).toBe(freshUpdateName);
  });

  test('raw-materials invalidation: PUT /raw-materials/:id clears cached pages', async () => {
    if (!dbAvailable) return;
    if (!redisAvailable) return;

    process.env.REDIS_URL = originalRedisUrl;
    if (originalRedisUrl) {
      try {
        await cacheRedis.delByPattern('raw-materials:');
      } catch {
        // ignore
      }
    }

    // Ensure deterministic DB value for the priming assertion (first row by code ASC).
    const firstRow = await RawMaterial.findAll({
      attributes: ['code'],
      order: [['code', 'ASC']],
      limit: 1,
      offset: 0,
      raw: true,
    });
    const code0 = firstRow?.[0]?.code;
    expect(typeof code0).toBe('string');

    const rmReset = await RawMaterial.findOne({ where: { code: code0 } });
    expect(rmReset).toBeTruthy();
    await rmReset.update({ name: `OldName-${code0}` });

    // Prime cache.
    const cachedBefore = await request(app)
      .get('/api/v1/raw-materials?limit=1&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(cachedBefore.status).toBe(200);
    expect(cachedBefore.body.rows[0].code).toBe(code0);
    expect(cachedBefore.body.rows[0].name).toMatch(/^OldName/);

    const rm1 = await RawMaterial.findOne({ where: { code: code0 } });
    expect(rm1).toBeTruthy();
    const apiUpdatedName = `API-Updated-${code0}`;

    // Update via API (triggers invalidation middleware).
    const res = await request(app)
      .put(`/api/v1/raw-materials/${rm1.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: code0,
        name: apiUpdatedName,
        inci: rm1.inci || `INC-${code0}`,
        category: 'TestCat',
        rm_type: 'RM',
        uom: 'KG',
        price_per_kg: 10,
        gst: 18,
        shelf: '12',
        status: 'active',
      });
    expect(res.status).toBe(200);

    // Small grace period: invalidation runs asynchronously on response finish.
    await new Promise((r) => setTimeout(r, 50));

    const cachedAfter = await request(app)
      .get('/api/v1/raw-materials?limit=1&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(cachedAfter.status).toBe(200);
    expect(cachedAfter.body.rows[0].code).toBe(code0);
    expect(cachedAfter.body.rows[0].name).toBe(apiUpdatedName);
  });

  test('sync-on-read exclusion: GET /planning-extracted is not cached', async () => {
    if (!dbAvailable) return;

    // Even with Redis enabled, caching middleware is not wired for GET /planning-extracted.
    process.env.REDIS_URL = redisAvailable ? originalRedisUrl : '';

    const first = await request(app)
      .get('/api/v1/planning-extracted?limit=2&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    const firstDue0 = first.body.rows[0].dueDate;

    // Insert an earlier due date row; sync-on-read endpoint must reflect it (no stale cache).
    const product = await Product.findOne({ order: [['product_id', 'ASC']] });
    const soEarly = await SalesOrder.create({
      order_id: 'SO-EARLY',
      customer_name: 'Customer-Early',
      order_date: '2026-03-01',
      expected_shipment_date: '2026-01-01',
      status: 'open',
      items: [],
    });

    const earlyPlan = await PlanningExtracted.create({
      sales_order_id: soEarly.id,
      product_id: product.product_id,
      order_qty_display: '10 units',
      total_kg_display: '500 KG',
      order_date: '2026-03-01',
      due_date: '2026-01-01',
      batch_size_display: '100 KG',
      batches_required: 1,
      batch_count: 0,
      batch_size_kg: 100,
      bom_status: 'Pending',
      bom_confirmed_at: null,
      approved_by: null,
      raw_materials: [],
      packaging_materials: [],
      custom_batches: [],
      sent_batch_indices: null,
      planned_start_date: null,
      production_line: null,
      color: null,
    });

    const second = await request(app)
      .get('/api/v1/planning-extracted?limit=2&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(200);
    expect(second.body.rows[0].dueDate).not.toBe(firstDue0);
    expect(second.body.rows.some((r) => r.salesOrderId === soEarly.id)).toBe(true);

    // Avoid lint warnings about unused variable; also ensure row creation worked.
    expect(earlyPlan.id).toBeTruthy();
  });

  test('pagination correctness: warehouse-inventory limit/offset', async () => {
    if (!dbAvailable) return;

    process.env.REDIS_URL = '';

    const page1 = await request(app)
      .get('/api/v1/warehouse-inventory?limit=2&offset=1')
      .set('Authorization', `Bearer ${token}`);
    expect(page1.status).toBe(200);
    expect(page1.body).toHaveProperty('rows');
    expect(page1.body).toHaveProperty('total');
    expect(page1.body.limit).toBe(2);
    expect(page1.body.offset).toBe(1);
    expect(page1.body.rows.length).toBe(2);
  });

  test('pagination correctness: warehouse-locations limit/offset', async () => {
    if (!dbAvailable) return;

    process.env.REDIS_URL = '';

    const page = await request(app)
      .get('/api/v1/warehouse-locations?limit=3&offset=2')
      .set('Authorization', `Bearer ${token}`);
    expect(page.status).toBe(200);
    expect(page.body.limit).toBe(3);
    expect(page.body.offset).toBe(2);
    expect(page.body.rows.length).toBe(3);
    expect(page.body.total).toBe(10);
  });

  test('pagination correctness: planning-extracted limit/offset payload shape', async () => {
    if (!dbAvailable) return;

    process.env.REDIS_URL = '';

    const page = await request(app)
      .get('/api/v1/planning-extracted?limit=2&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(page.status).toBe(200);
    expect(page.body).toHaveProperty('rows');
    expect(page.body).toHaveProperty('total');
    expect(page.body.limit).toBe(2);
    expect(page.body.offset).toBe(0);
  });

  test('pagination correctness: planning-extracted/items-involved limit/offset', async () => {
    if (!dbAvailable) return;

    process.env.REDIS_URL = '';

    const page0 = await request(app)
      .get('/api/v1/planning-extracted/items-involved?limit=2&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(page0.status).toBe(200);
    expect(page0.body.total).toBeGreaterThanOrEqual(2);
    expect(page0.body.limit).toBe(2);
    expect(page0.body.offset).toBe(0);
    expect(Array.isArray(page0.body.rows)).toBe(true);
    expect(page0.body.rows.length).toBe(2);

    const page1 = await request(app)
      .get('/api/v1/planning-extracted/items-involved?limit=2&offset=2')
      .set('Authorization', `Bearer ${token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.limit).toBe(2);
    expect(page1.body.offset).toBe(2);
  });

  test('cross-domain invalidation: GRN Complete invalidates cached warehouse-inventory reads', async () => {
    if (!dbAvailable) return;
    if (!redisAvailable) return;

    process.env.REDIS_URL = originalRedisUrl;

    if (originalRedisUrl) {
      try {
        await cacheRedis.delByPattern('warehouse-inventory:');
      } catch {
        // ignore
      }
    }

    const targetCode = 'EI-RM-PAG-001';

    // Prime cache for warehouse-inventory list (large limit so target row is included).
    const before = await request(app)
      .get('/api/v1/warehouse-inventory?limit=100&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);
    const beforeRow = (before.body.rows || []).find((r) => r.code === targetCode);
    expect(beforeRow).toBeTruthy();
    const beforeWh = Number(beforeRow.stockInHand || beforeRow.whStock);

    // Create a GRN that transitions to GRN Complete and adds stock to the first RM bucket.
    const rm = await RawMaterial.findOne({ where: { code: 'EI-RM-PAG-001' } });
    const grn = await GoodsReceivedNote.create({
      grn_no: 'GRN-PERF-001',
      type: 'RM',
      status: 'Pending',
      qc_status: 'Under test',
      qc_by: 'QC-Old',
      assigned_to: 'user',
      workflow_steps: ['Qty Check', 'Label Generation'],
      line_items: [
        {
          raw_material_id: rm.id,
          itemCode: rm.code,
          rcvdQty: 5,
          poQty: 5,
        },
      ],
    });

    const patch = await request(app)
      .put(`/api/v1/grn/${grn.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        status: 'GRN Complete',
        qcStatus: 'Passed',
        qcBy: 'Inspector',
        assignedTo: 'Inspector',
        workflowSteps: ['Label Generation'],
      });
    expect(patch.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    // Cached warehouse-inventory must now reflect updated SIH.
    const after = await request(app)
      .get('/api/v1/warehouse-inventory?limit=100&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(200);
    const afterRow = (after.body.rows || []).find((r) => r.code === targetCode);
    expect(afterRow).toBeTruthy();
    const afterWh = Number(afterRow.stockInHand || afterRow.whStock);

    expect(afterWh).toBeGreaterThan(beforeWh);
  });

  test('A: pagination total + deterministic ordering (raw-materials)', async () => {
    if (!dbAvailable) return;

    const totalFromDb = await RawMaterial.count();

    const expectedPage0 = await RawMaterial.findAll({
      attributes: ['code'],
      order: [['code', 'ASC']],
      limit: 3,
      offset: 0,
      raw: true,
    });
    const expectedPage1 = await RawMaterial.findAll({
      attributes: ['code'],
      order: [['code', 'ASC']],
      limit: 3,
      offset: 3,
      raw: true,
    });

    const page0 = await request(app)
      .get('/api/v1/raw-materials?limit=3&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(page0.status).toBe(200);
    expect(page0.body.total).toBe(totalFromDb);
    expect(page0.body.limit).toBe(3);
    expect(page0.body.offset).toBe(0);
    expect(page0.body.rows.map((r) => r.code)).toEqual(expectedPage0.map((r) => r.code));

    const page1 = await request(app)
      .get('/api/v1/raw-materials?limit=3&offset=3')
      .set('Authorization', `Bearer ${token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(totalFromDb);
    expect(page1.body.rows.map((r) => r.code)).toEqual(expectedPage1.map((r) => r.code));
  });

  test('A: search + pagination interaction (raw-materials)', async () => {
    if (!dbAvailable) return;

    // Matches EI-RM-PAG-001..009 (9 items).
    const search = 'EI-RM-PAG-00';
    const page0 = await request(app)
      .get(`/api/v1/raw-materials?search=${encodeURIComponent(search)}&limit=2&offset=0`)
      .set('Authorization', `Bearer ${token}`);
    expect(page0.status).toBe(200);
    expect(page0.body.total).toBe(9);
    expect(page0.body.rows.map((r) => r.code)).toEqual(['EI-RM-PAG-001', 'EI-RM-PAG-002']);

    const page1 = await request(app)
      .get(`/api/v1/raw-materials?search=${encodeURIComponent(search)}&limit=2&offset=2`)
      .set('Authorization', `Bearer ${token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(9);
    expect(page1.body.rows.map((r) => r.code)).toEqual(['EI-RM-PAG-003', 'EI-RM-PAG-004']);
  });

  test('A: status + search + pagination interaction (raw-materials)', async () => {
    if (!dbAvailable) return;

    const search = 'EI-RM-PAG-00';
    const status = 'inactive';

    const expectedTotal = await RawMaterial.count({
      where: {
        status,
        code: { [Op.iLike]: `%${search}%` },
      },
    });

    const expectedPage0 = await RawMaterial.findAll({
      where: {
        status,
        code: { [Op.iLike]: `%${search}%` },
      },
      attributes: ['code'],
      order: [['code', 'ASC']],
      limit: 2,
      offset: 0,
      raw: true,
    });

    const expectedPage1 = await RawMaterial.findAll({
      where: {
        status,
        code: { [Op.iLike]: `%${search}%` },
      },
      attributes: ['code'],
      order: [['code', 'ASC']],
      limit: 2,
      offset: 2,
      raw: true,
    });

    const page0 = await request(app)
      .get(`/api/v1/raw-materials?status=${status}&search=${encodeURIComponent(search)}&limit=2&offset=0`)
      .set('Authorization', `Bearer ${token}`);
    expect(page0.status).toBe(200);
    expect(page0.body.total).toBe(expectedTotal);
    expect(page0.body.rows.map((r) => r.code)).toEqual(expectedPage0.map((r) => r.code));

    const page1 = await request(app)
      .get(`/api/v1/raw-materials?status=${status}&search=${encodeURIComponent(search)}&limit=2&offset=2`)
      .set('Authorization', `Bearer ${token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(expectedTotal);
    expect(page1.body.rows.map((r) => r.code)).toEqual(expectedPage1.map((r) => r.code));
  });

  test('A: search + pagination interaction (pack-materials)', async () => {
    if (!dbAvailable) return;

    const search = 'EI-PM-PAG-00';
    const page0 = await request(app)
      .get(`/api/v1/pack-materials?search=${encodeURIComponent(search)}&limit=2&offset=0`)
      .set('Authorization', `Bearer ${token}`);
    expect(page0.status).toBe(200);
    expect(page0.body.total).toBe(9);
    expect(page0.body.rows.map((r) => r.code)).toEqual(['EI-PM-PAG-001', 'EI-PM-PAG-002']);

    const page1 = await request(app)
      .get(`/api/v1/pack-materials?search=${encodeURIComponent(search)}&limit=2&offset=2`)
      .set('Authorization', `Bearer ${token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(9);
    expect(page1.body.rows.map((r) => r.code)).toEqual(['EI-PM-PAG-003', 'EI-PM-PAG-004']);
  });

  test('A: pagination total + deterministic ordering (warehouse-inventory)', async () => {
    if (!dbAvailable) return;

    const totalFromDb = await WarehouseInventory.count();

    const rawIdsPage0 = await WarehouseInventory.findAll({
      attributes: ['raw_material_id'],
      where: { item_type: 'RM' },
      order: [['raw_material_id', 'ASC']],
      limit: 4,
      offset: 0,
      raw: true,
    });

    const ids = rawIdsPage0.map((r) => r.raw_material_id).filter(Boolean);
    const rms = ids.length ? await RawMaterial.findAll({ where: { id: ids }, attributes: ['id', 'code'] }) : [];
    const codeById = new Map(rms.map((r) => [r.id, r.code]));
    const expectedCodes = ids.map((id) => codeById.get(id)).filter(Boolean);

    const page0 = await request(app)
      .get('/api/v1/warehouse-inventory?limit=4&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(page0.status).toBe(200);
    expect(page0.body.total).toBe(totalFromDb);
    expect(page0.body.rows.map((r) => r.code)).toEqual(expectedCodes);

    const page1 = await request(app)
      .get('/api/v1/warehouse-inventory?limit=4&offset=4')
      .set('Authorization', `Bearer ${token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(totalFromDb);
    expect(page1.body.rows.length).toBe(4);
    expect(new Set([...page0.body.rows.map((r) => r.id), ...page1.body.rows.map((r) => r.id)])).toHaveLength(8);
  });

  test('A: pagination total + deterministic ordering (planning-extracted)', async () => {
    if (!dbAvailable) return;

    const totalFromDb = await PlanningExtracted.count();
    expect(totalFromDb).toBe(6);

    const expected = await PlanningExtracted.findAll({
      attributes: ['due_date', 'id'],
      order: [['due_date', 'ASC'], ['id', 'ASC']],
      raw: true,
    });

    const page0 = await request(app)
      .get('/api/v1/planning-extracted?limit=3&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(page0.status).toBe(200);
    expect(page0.body.total).toBe(totalFromDb);
    expect(page0.body.rows.map((r) => r.dueDate)).toEqual(expected.slice(0, 3).map((r) => r.due_date));

    const page1 = await request(app)
      .get('/api/v1/planning-extracted?limit=3&offset=3')
      .set('Authorization', `Bearer ${token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(totalFromDb);
    expect(page1.body.rows.map((r) => r.dueDate)).toEqual(expected.slice(3, 6).map((r) => r.due_date));
  });

  test('A: pagination total + deterministic ordering (planning-extracted/items-involved)', async () => {
    if (!dbAvailable) return;

    const page0 = await request(app)
      .get('/api/v1/planning-extracted/items-involved?limit=2&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(page0.status).toBe(200);
    expect(page0.body.limit).toBe(2);
    expect(page0.body.offset).toBe(0);
    expect(page0.body.total).toBe(5);
    expect(page0.body.rows.map((r) => r.code)).toEqual(['EI-RM-INV-A', 'EI-RM-INV-B']);

    const page1 = await request(app)
      .get('/api/v1/planning-extracted/items-involved?limit=2&offset=2')
      .set('Authorization', `Bearer ${token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(5);
    expect(page1.body.rows.map((r) => r.code)).toEqual(['EI-RM-INV-C', 'EI-RM-INV-D']);
  });

  test('B.2: cache response correctness (raw-materials list)', async () => {
    if (!dbAvailable) return;
    if (!redisAvailable) return;

    // Clear existing cache keys for deterministic behavior.
    process.env.REDIS_URL = originalRedisUrl;
    await cacheRedis.delByPattern('raw-materials:');

    // Prime cache.
    const cachedPrime = await request(app)
      .get('/api/v1/raw-materials?limit=1&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(cachedPrime.status).toBe(200);

    // Disable caching and compute fresh response; it must equal cached payload.
    process.env.REDIS_URL = '';
    const fresh = await request(app)
      .get('/api/v1/raw-materials?limit=1&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(fresh.status).toBe(200);
    expect(fresh.body.rows[0].code).toBe(cachedPrime.body.rows[0].code);
    expect(fresh.body.rows[0].name).toBe(cachedPrime.body.rows[0].name);

    // Restore for later tests.
    process.env.REDIS_URL = originalRedisUrl;
  });

  test('B.3: cache key correctness (raw-materials search params)', async () => {
    if (!dbAvailable) return;
    if (!redisAvailable) return;

    await cacheRedis.delByPattern('raw-materials:');
    process.env.REDIS_URL = originalRedisUrl;

    const search1 = 'EI-RM-PAG-00'; // 001..009
    const search2 = 'EI-RM-PAG-01'; // 010..019

    const prime1 = await request(app)
      .get(`/api/v1/raw-materials?search=${encodeURIComponent(search1)}&limit=1&offset=0`)
      .set('Authorization', `Bearer ${token}`);
    expect(prime1.status).toBe(200);
    expect(prime1.body.rows[0].code).toBe('EI-RM-PAG-001');
    const prime1Name = prime1.body.rows[0].name;

    // Update a record that only belongs to search2.
    const rm010 = await RawMaterial.findOne({ where: { code: 'EI-RM-PAG-010' } });
    expect(rm010).toBeTruthy();
    await rm010.update({ name: 'CacheKeyUpdated-010' });

    const prime2 = await request(app)
      .get(`/api/v1/raw-materials?search=${encodeURIComponent(search2)}&limit=1&offset=0`)
      .set('Authorization', `Bearer ${token}`);
    expect(prime2.status).toBe(200);
    expect(prime2.body.rows[0].code).toBe('EI-RM-PAG-010');
    expect(prime2.body.rows[0].name).toBe('CacheKeyUpdated-010');

    // Re-run search1: must return cached/stale data from the prime.
    const prime1Again = await request(app)
      .get(`/api/v1/raw-materials?search=${encodeURIComponent(search1)}&limit=1&offset=0`)
      .set('Authorization', `Bearer ${token}`);
    expect(prime1Again.status).toBe(200);
    expect(prime1Again.body.rows[0].code).toBe('EI-RM-PAG-001');
    expect(prime1Again.body.rows[0].name).toBe(prime1Name);
  });

  test('B.4: invalidation on writes (PUT pack-materials clears cached pages)', async () => {
    if (!dbAvailable) return;
    if (!redisAvailable) return;

    await cacheRedis.delByPattern('pack-materials:');
    process.env.REDIS_URL = originalRedisUrl;

    // Prime cache.
    const before = await request(app)
      .get('/api/v1/pack-materials?limit=1&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);
    expect(before.body.rows[0].code).toBe('EI-PM-PAG-001');

    const pm = await PackMaterial.findOne({ where: { code: 'EI-PM-PAG-001' } });
    expect(pm).toBeTruthy();

    const res = await request(app)
      .put(`/api/v1/pack-materials/${pm.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: 'EI-PM-PAG-001',
        description: 'API-PackUpdated-001',
        type: 'Tube',
        level: 'Primary',
        material: 'TestMaterial',
        size_spec: '100',
        print_status: 'printed',
        unit: 'PCS',
        products: [],
      });
    expect(res.status).toBe(200);

    // invalidation runs asynchronously on response finish
    await new Promise((r) => setTimeout(r, 75));

    const after = await request(app)
      .get('/api/v1/pack-materials?limit=1&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(200);
    expect(after.body.rows[0].code).toBe('EI-PM-PAG-001');
    expect(after.body.rows[0].description).toBe('API-PackUpdated-001');
  });

  test('B.5: invalidation on writes (POST raw-materials clears cached pages)', async () => {
    if (!dbAvailable) return;
    if (!redisAvailable) return;

    const newCode = 'EI-RM-PAG-000';
    const newName = 'API-Create-000';

    await cacheRedis.delByPattern('raw-materials:');
    process.env.REDIS_URL = originalRedisUrl;

    const before = await request(app)
      .get('/api/v1/raw-materials?limit=1&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);
    const beforeCode = before.body.rows[0].code;
    expect(beforeCode).not.toBe(newCode);

    const created = await request(app)
      .post('/api/v1/raw-materials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: newCode,
        name: newName,
        inci: `INC-${newCode}`,
        category: 'TestCat',
        rm_type: 'RM',
        uom: 'KG',
        price_per_kg: 10,
        gst: 18,
        shelf: '12',
        status: 'active',
        products: [],
      });
    expect(created.status).toBe(201);

    // Cache invalidation runs asynchronously on response finish.
    await new Promise((r) => setTimeout(r, 75));

    const after = await request(app)
      .get('/api/v1/raw-materials?limit=1&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(200);
    expect(after.body.rows[0].code).toBe(newCode);
    expect(after.body.rows[0].name).toBe(newName);
  });

  test('B.6: invalidation on writes (DELETE raw-materials clears cached pages)', async () => {
    if (!dbAvailable) return;
    if (!redisAvailable) return;

    const deletedCode = 'EI-RM-PAG-000';
    const rmToDelete = await RawMaterial.findOne({ where: { code: deletedCode } });
    if (!rmToDelete) return;

    await cacheRedis.delByPattern('raw-materials:');
    process.env.REDIS_URL = originalRedisUrl;

    const before = await request(app)
      .get('/api/v1/raw-materials?limit=1&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);
    expect(before.body.rows[0].code).toBe(deletedCode);

    const del = await request(app)
      .delete(`/api/v1/raw-materials/${rmToDelete.id}`)
      .set('Authorization', `Bearer ${token}`);
    // raw-materials DELETE returns 204
    expect(del.status).toBe(204);

    await new Promise((r) => setTimeout(r, 75));

    const after = await request(app)
      .get('/api/v1/raw-materials?limit=1&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(200);
    expect(after.body.rows[0].code).not.toBe(deletedCode);

    const expectedFirst = await RawMaterial.findAll({
      attributes: ['code'],
      order: [['code', 'ASC']],
      limit: 1,
      offset: 0,
      raw: true,
    });
    expect(after.body.rows[0].code).toBe(expectedFirst[0].code);
  });

  test('B.7: invalidation on writes (PATCH warehouse-inventory clears cached pages)', async () => {
    if (!dbAvailable) return;
    if (!redisAvailable) return;

    const targetCode = 'EI-RM-PAG-001';
    const rm = await RawMaterial.findOne({ where: { code: targetCode } });
    if (!rm) return;

    const whRow = await WarehouseInventory.findOne({ where: { item_type: 'RM', raw_material_id: rm.id } });
    if (!whRow) return;

    await cacheRedis.delByPattern('warehouse-inventory:');
    process.env.REDIS_URL = originalRedisUrl;

    const before = await request(app)
      .get('/api/v1/warehouse-inventory?limit=100&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);

    const beforeRow = (before.body.rows || []).find((r) => r.code === targetCode);
    expect(beforeRow).toBeTruthy();
    const beforeStock = Number(beforeRow.stockInHand ?? beforeRow.whStock);

    const patchStock = beforeStock + 7;
    const patch = await request(app)
      .patch(`/api/v1/warehouse-inventory/${whRow.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ wh_stock: patchStock });
    expect(patch.status).toBe(200);

    await new Promise((r) => setTimeout(r, 75));

    const after = await request(app)
      .get('/api/v1/warehouse-inventory?limit=100&offset=0')
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(200);

    const afterRow = (after.body.rows || []).find((r) => r.code === targetCode);
    expect(afterRow).toBeTruthy();
    const afterStock = Number(afterRow.stockInHand ?? afterRow.whStock);
    expect(afterStock).toBeGreaterThan(beforeStock);

    const updatedDbRow = await WarehouseInventory.findByPk(whRow.id);
    const expectedDbStock = Number(updatedDbRow.stock_in_hand ?? updatedDbRow.wh_stock ?? afterStock);
    expect(afterStock).toBe(expectedDbStock);
  });

  test('B.8: sync-on-read exclusion: GET /fulfillment/:id reflects production changes', async () => {
    if (!dbAvailable) return;
    if (!fulfillmentOrderId) return;

    // Fulfillment endpoints are never cached by middleware, so they must reflect sync changes.
    process.env.REDIS_URL = originalRedisUrl;

    const first = await request(app)
      .get(`/api/v1/fulfillment/${fulfillmentOrderId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);

    const firstSplit = first.body.items?.[0]?.batchSplits?.[0];
    expect(firstSplit).toBeTruthy();
    expect(firstSplit.ffStatus).toBe('fg_ready');
    expect(firstSplit.fgQty).toBeGreaterThan(0);

    // Flip production batch bpr_status; syncOrderSplitsFromProduction on next GET should recalc split.
    await ProductionBatch.update({ bpr_status: 'draft' }, { where: { so_no: 'EI-SO-2026-FTL-001' } });

    const second = await request(app)
      .get(`/api/v1/fulfillment/${fulfillmentOrderId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(200);

    const secondSplit = second.body.items?.[0]?.batchSplits?.[0];
    expect(secondSplit).toBeTruthy();
    expect(secondSplit.ffStatus).toBe('fg_pending');
    expect(secondSplit.fgQty).toBe(0);
  });
});


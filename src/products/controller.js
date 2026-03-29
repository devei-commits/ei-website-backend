const db = require('../../db');
const { Product } = require('./models');
const { productSchema, productUpdateSchema, categorySchema, categoryUpdateSchema } = require('./schemas');
const { Op } = require('sequelize');
const BOM = require('../bom/models');
const PackMaterial = require('../packMaterials/models');
const RawMaterial = require('../rawMaterials/models');
const SalesOrder = require('../salesOrders/models');
const WarehouseInventory = require('../warehouseInventory/models');
const WarehouseInventoryLocationHistory = require('../warehouseInventory/locationHistoryModel');
const PlanningExtracted = require('../planningExtracted/models');
const redisCache = require('../cache/redis');
const { syncZohoItemForNewProduct } = require('./zohoItemSync');
const zohoEnv = require('../services/zohoEnv');

/** At least one non-empty formula line (INCI / RM code / positive %). */
function countMeaningfulRmLines(lines) {
  if (!Array.isArray(lines)) return 0;
  return lines.filter((line) => {
    const inci = String(line?.inci_name ?? line?.inciName ?? '').trim();
    const code = String(line?.rm_code ?? line?.rmCode ?? '').trim();
    const pctRaw = line?.pct_w_w ?? line?.pctWw ?? line?.pct;
    const pct =
      pctRaw != null && pctRaw !== ''
        ? parseFloat(String(pctRaw).replace(/[^\d.-]/g, ''))
        : NaN;
    const hasPct = !Number.isNaN(pct) && pct > 0;
    return Boolean(inci || code || hasPct);
  }).length;
}

/** At least one non-empty pack line (description / PM code). */
function countMeaningfulPmLines(lines) {
  if (!Array.isArray(lines)) return 0;
  return lines.filter((line) => {
    const desc = String(
      line?.description ?? line?.pm_description ?? line?.pmDescription ?? ''
    ).trim();
    const code = String(line?.pm_code ?? line?.pmCode ?? '').trim();
    return Boolean(desc || code);
  }).length;
}

function appendProductCodeToList(products, productCode) {
  const code = String(productCode || '').trim();
  if (!code) return Array.isArray(products) ? products : [];
  const list = Array.isArray(products) ? products.map(String) : [];
  if (list.includes(code)) return list;
  return [...list, code];
}

const saveProduct = async (req, res) => {
  try {
    const { product_name } = req.body;

    if (!product_name) {
      return res.status(400).json({ error: "product_name is required" });
    }

    // check existing
    const existing = await Product.findOne({
      where: { product_name },
    });

    if (existing) {
      return res.status(409).json({ error: "Product already exists!" });
    }

    // create product
    const product = await Product.create({
      ...req.body,
      created_at: new Date(),
    });

    const zoho = await syncZohoItemForNewProduct(product, req.body);
    const payload = product.get ? product.get({ plain: true }) : { ...product };
    if (zoho.synced && zoho.itemId) {
      await product.update({ zoho_item_id: zoho.itemId });
      payload.zoho_item_id = zoho.itemId;
    } else if (
      zohoEnv.booksEnabled &&
      zohoEnv.syncItems &&
      zoho.error &&
      zoho.error !== 'zoho_disabled' &&
      zoho.error !== 'item_sync_disabled' &&
      zoho.error !== 'already_has_zoho_item_id'
    ) {
      payload.zoho_sync = { synced: false, error: zoho.error };
    }

    return res.status(201).json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * POST /products/pr-registration — PR Master wizard: create `products` row + linked `boms` row.
 * Expects product_name, product_code (or name, bomCode); optional rm_lines, pm_lines, process_steps.
 */
const createPRRegistration = async (req, res) => {
  try {
    const b = req.body || {};
    const product_name = String(b.product_name ?? b.name ?? '').trim();
    const product_code = String(b.product_code ?? b.bomCode ?? '').trim();
    if (!product_name) return res.status(400).json({ error: 'product_name is required' });
    if (!product_code) return res.status(400).json({ error: 'product_code is required' });

    const existsCode = await Product.findOne({ where: { product_code } });
    if (existsCode) {
      return res.status(409).json({
        error: `Product code "${product_code}" is already registered. Regenerate the PR code or edit that product.`,
        code: 'PRODUCT_CODE_EXISTS',
      });
    }
    const existsName = await Product.findOne({ where: { product_name } });
    if (existsName) {
      return res.status(409).json({
        error: `Product name "${product_name}" is already in use. Use a different name or edit the existing PR.`,
        code: 'PRODUCT_NAME_EXISTS',
      });
    }

    const now = new Date();
    const bomSku = String(b.product_sku ?? b.bomSku ?? product_code).trim();
    const rm_lines = Array.isArray(b.rm_lines) ? b.rm_lines : (Array.isArray(b.rmLines) ? b.rmLines : []);
    const pm_lines = Array.isArray(b.pm_lines) ? b.pm_lines : (Array.isArray(b.pmLines) ? b.pmLines : []);
    const process_steps = Array.isArray(b.process_steps) ? b.process_steps : (Array.isArray(b.processSteps) ? b.processSteps : []);

    if (countMeaningfulRmLines(rm_lines) < 1) {
      return res.status(400).json({
        error:
          'At least one formula (RM) line is required. Add ingredients in Formula BOM before registering.',
        code: 'PR_MISSING_RM_LINES',
      });
    }
    if (countMeaningfulPmLines(pm_lines) < 1) {
      return res.status(400).json({
        error:
          'At least one packaging (PM) line is required. Add pack components in Pack BOM before registering.',
        code: 'PR_MISSING_PM_LINES',
      });
    }

    const mrpRaw = b.mrp_price ?? b.mrp;
    let mrp_price = null;
    if (mrpRaw != null && mrpRaw !== '') {
      const n = parseFloat(String(mrpRaw).replace(/[^\d.]/g, ''));
      if (!Number.isNaN(n)) mrp_price = n;
    }

    const productRow = {
      product_name,
      product_code,
      product_sku: bomSku,
      generic_name: b.generic_name ?? b.category ?? null,
      brand_name: b.brand_name ?? b.client ?? null,
      category: b.category ?? null,
      status: b.status ?? 'Draft',
      lifecycle_status: b.lifecycle_status ?? b.status ?? 'Draft',
      form: b.form ?? b.type ?? null,
      fill_size: b.fill_size ?? b.packSize ?? null,
      product_description: b.product_description ?? b.description ?? null,
      storage_conditions: b.storage_conditions ?? null,
      mrp_price,
      ph_range: b.ph_range ?? null,
      viscosity_range: b.viscosity_range ?? null,
      appearance: b.appearance ?? null,
      odour: b.odour ?? null,
      fill_weight_spec: b.fill_weight_spec ?? null,
      stability_summary: b.stability_summary ?? null,
      approved_claims: b.approved_claims ?? null,
      created_at: now,
      updated_at: now,
    };

    const notesParts = [];
    if (b.pr_qc_group) notesParts.push(`QC Group: ${b.pr_qc_group}`);
    if (b.pr_sub_category) notesParts.push(`PR Sub-category: ${b.pr_sub_category}`);
    const bomNotes = notesParts.length ? notesParts.join(' | ') : null;

    const t = await db.transaction();
    try {
      const product = await Product.create(productRow, { transaction: t });
      const bomRow = {
        bom_code: product_code,
        bom_sku: bomSku,
        zoho_id: b.zoho_id ?? b.zohoId ?? null,
        bom_tax_preference: b.bom_tax_preference ?? b.bomTaxPreference ?? null,
        bom_returnable: b.bom_returnable ?? b.bomReturnable ?? false,
        bom_associate_items: b.bom_associate_items ?? b.bomAssociateItems ?? null,
        type: b.type ?? productRow.form ?? null,
        status: 'Draft',
        client: b.client ?? null,
        name: product_name,
        pack_size: productRow.fill_size,
        site: b.site ?? null,
        category: productRow.category,
        ph_range: productRow.ph_range,
        regulatory: b.regulatory ?? b.applicable_regulation ?? null,
        description: b.desc ?? null,
        notes: bomNotes,
        stability_summary: productRow.stability_summary,
        rm_lines,
        pm_lines,
        process_steps,
        product_id: product.product_id,
        created_at: now,
        updated_at: now,
      };

      const existingBom = await BOM.findOne({
        where: { bom_code: product_code },
        transaction: t,
      });

      let bom;
      if (existingBom) {
        if (existingBom.product_id != null) {
          await t.rollback();
          return res.status(409).json({
            error: `BOM code "${product_code}" is already linked to another product. Regenerate the PR code.`,
            code: 'BOM_CODE_LINKED',
          });
        }
        const { created_at: _c, ...bomUpdate } = bomRow;
        await existingBom.update(
          { ...bomUpdate, updated_at: now },
          { transaction: t }
        );
        bom = existingBom;
      } else {
        bom = await BOM.create(bomRow, { transaction: t });
      }

      // Link selected RM/PM master items to this product code for downstream usage/pricing.
      // We only link rows where the line carries an explicit master id (raw_material_id / pack_material_id).
      const productCodeForLink = product_code;
      const rawMaterialIds = Array.from(
        new Set(
          (Array.isArray(rm_lines) ? rm_lines : [])
            .map((l) => l?.raw_material_id ?? l?.rawMaterialId)
            .map((v) => (v != null ? parseInt(String(v), 10) : NaN))
            .filter((n) => !Number.isNaN(n))
        )
      );
      const packMaterialIds = Array.from(
        new Set(
          (Array.isArray(pm_lines) ? pm_lines : [])
            .map((l) => l?.pack_material_id ?? l?.packMaterialId ?? l?.pm_id ?? l?.pmId)
            .map((v) => (v != null ? parseInt(String(v), 10) : NaN))
            .filter((n) => !Number.isNaN(n))
        )
      );

      if (rawMaterialIds.length > 0) {
        const rms = await RawMaterial.findAll({ where: { id: { [Op.in]: rawMaterialIds } }, transaction: t });
        for (const rm of rms) {
          const next = appendProductCodeToList(rm.products, productCodeForLink);
          await rm.update({ products: next, updated_at: now }, { transaction: t });
        }
      }
      if (packMaterialIds.length > 0) {
        const pms = await PackMaterial.findAll({ where: { id: { [Op.in]: packMaterialIds } }, transaction: t });
        for (const pm of pms) {
          const next = appendProductCodeToList(pm.products, productCodeForLink);
          await pm.update({ products: next, updated_at: now }, { transaction: t });
        }
      }

      await t.commit();

      // Create a zero-stock warehouse inventory row so the PR appears in the warehouse immediately.
      await WarehouseInventory.findOrCreate({
        where: { item_type: 'PR', product_id: product.product_id },
        defaults: {
          item_type: 'PR',
          product_id: product.product_id,
          wh_stock: 0,
          wh_unit: 'PCS',
          ml1_stock: 0,
          ml2_stock: 0,
          stock_in_hand: 0,
          reserved: 0,
          in_transit: 0,
          reorder_pt: 0,
          avg_mo: 0,
          qc_status: 'Out of Stock',
        },
      });

      res.status(201).json({
        product: product.get({ plain: true }),
        bom: {
          id: String(bom.id),
          bom_code: bom.bom_code,
          product_id: bom.product_id,
        },
      });
    } catch (inner) {
      await t.rollback();
      throw inner;
    }
  } catch (err) {
    console.error('createPRRegistration error', err);
    if (err.name === 'SequelizeUniqueConstraintError') {
      const paths = (err.errors || []).map((e) => e.path).filter(Boolean);
      const hint = paths.some((p) => String(p).includes('bom_code'))
        ? 'This PR/BOM code is already used. Use “Generate Code Now” again or pick another code.'
        : 'A unique constraint failed (code or name may already exist).';
      return res.status(409).json({ error: hint, code: 'UNIQUE_VIOLATION', fields: paths });
    }
    res.status(500).json({ error: err.message || 'Failed to register PR product' });
  }
};

/** Format product for list: add rm_ingredients_count, pack_items_count, open_sos_count */
function formatProductForList(p) {
  const d = p.get ? p.get({ plain: true }) : p;
  return {
    ...d,
    rm_ingredients_count: p.rm_ingredients_count ?? null,
    pack_items_count: p.pack_items_count ?? null,
    open_sos_count: p.open_sos_count ?? null,
  };
}

const getAllProducts = async (req, res) => {
  try {
    const limitQ = req.query.limit;
    const offsetQ = req.query.offset;
    const wantsPagination = limitQ != null || offsetQ != null;

    const normalizeInt = (v) => {
      const n = parseInt(String(v), 10);
      return Number.isNaN(n) ? null : n;
    };

    let products;
    let total = null;
    let limit = null;
    let offset = null;

    if (wantsPagination) {
      limit = limitQ != null ? normalizeInt(limitQ) : 20;
      offset = offsetQ != null ? normalizeInt(offsetQ) : 0;
      if (limit == null || offset == null || limit <= 0 || offset < 0) {
        return res.status(400).json({ error: 'Invalid pagination params (limit must be > 0, offset must be >= 0)' });
      }

      const result = await Product.findAndCountAll({
        order: [['product_code', 'ASC']],
        limit,
        offset,
      });
      products = result.rows;
      total = result.count;
    } else {
      products = await Product.findAll({ order: [['product_code', 'ASC']] });
    }

    const productCodes = products.map((p) => p.product_code).filter(Boolean);
    const productIds = products.map((p) => p.product_id);
    const productCodesSet = new Set(productCodes);

    const openStatuses = ['Draft', 'Submitted', 'Confirmed', 'Processing', 'Pending', 'In Progress'];
    const bomsPromise = productIds.length > 0
      ? BOM.findAll({ where: { product_id: { [Op.in]: productIds } } })
      : Promise.resolve([]);
    const packPromise = PackMaterial.findAll();
    const salesOrdersPromise = SalesOrder.findAll({
      where: { status: { [Op.in]: openStatuses } },
      attributes: ['id', 'order_id', 'customer_name', 'status', 'items'],
    }).catch(() => []);

    const [boms, allPack, salesOrders] = await Promise.all([bomsPromise, packPromise, salesOrdersPromise]);

    const bomsByProductId = {};
    boms.forEach((b) => {
      bomsByProductId[b.product_id] = b;
    });

    const packMaterialsByCode = {};
    allPack.forEach((pm) => {
      const prods = Array.isArray(pm.products) ? pm.products : [];
      prods.forEach((code) => {
        if (!productCodesSet.has(code)) return;
        if (!packMaterialsByCode[code]) packMaterialsByCode[code] = [];
        packMaterialsByCode[code].push(pm);
      });
    });

    let openSoCountByCode = {};
    salesOrders.forEach((so) => {
      const items = Array.isArray(so.items) ? so.items : [];
      items.forEach((line) => {
        const code = line.product_code || line.productCode;
        if (code && productCodesSet.has(code)) {
          openSoCountByCode[code] = (openSoCountByCode[code] || 0) + 1;
        }
      });
    });

    const list = products.map((p) => {
    const plain = p.get ? p.get({ plain: true }) : p;
    const bom = bomsByProductId[p.product_id];
    const rmCount = bom && Array.isArray(bom.rm_lines) ? bom.rm_lines.length : 0;
    const packList = packMaterialsByCode[p.product_code] || [];
    const openSos = openSoCountByCode[p.product_code] || 0;
    return {
      ...plain,
      rm_ingredients_count: rmCount,
      pack_items_count: packList.length,
      open_sos_count: openSos,
    };
    });

    if (wantsPagination) {
      return res.json({ rows: list, total, limit, offset });
    }

    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getProductById = async (req, res) => {
  try {
    const product = await Product.findByPk(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** Full product detail for PR panel: overview, formula BOM, pack BOM, process steps, specs, open SOs */
const getProductDetail = async (req, res) => {
  try {
    const id = req.params.id;
    const product = await Product.findByPk(id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const plain = product.get ? product.get({ plain: true }) : product;

    const openStatuses = ['Draft', 'Submitted', 'Confirmed', 'Processing', 'Pending', 'In Progress'];
    const [bom, allPackForProduct, allOpenSo] = await Promise.all([
      BOM.findOne({ where: { product_id: id } }),
      PackMaterial.findAll(),
      SalesOrder.findAll({
        where: { status: { [Op.in]: openStatuses } },
        order: [['order_date', 'DESC']],
      }),
    ]);
    const rmLines = (bom && bom.rm_lines) ? bom.rm_lines : [];
    const pmLines = (bom && bom.pm_lines) ? bom.pm_lines : [];
    const processSteps = (bom && bom.process_steps) ? bom.process_steps : [];

    const phases = {};
    rmLines.forEach((line) => {
      const phase = line.phase || 'Other';
      if (!phases[phase]) phases[phase] = [];
      phases[phase].push({
        inci_name: line.inci_name || line.inciName || line.name,
        rm_code: line.rm_code || line.rmCode,
        raw_material_id: line.raw_material_id ?? line.rawMaterialId ?? null,
        pct_w_w: line.pct_w_w != null ? line.pct_w_w : (line.pctWw != null ? line.pctWw : line.pct),
        uom: line.uom || 'kg',
      });
    });
    const formulaBom = Object.entries(phases).map(([phaseName, ingredients]) => ({
      phase: phaseName,
      ingredients,
    }));
    const packMaterials = allPackForProduct.filter((pm) => {
      const prods = Array.isArray(pm.products) ? pm.products : [];
      return prods.includes(plain.product_code);
    });
    const packBomSource = pmLines.length > 0
      ? pmLines.map((row) => ({ ...row, pm_id: null }))
      : packMaterials.map((pm) => ({
          pm_id: pm.id,
          pm_code: pm.code,
          description: pm.description,
          pack_type: pm.level || 'Primary',
          qty_per_unit: 1,
          uom: 'pc/unit',
        }));
    if (pmLines.length > 0 && packMaterials.length > 0) {
      const codeToId = new Map(packMaterials.map((pm) => [pm.code, pm.id]));
      packBomSource.forEach((row) => {
        if (row.pm_id == null && row.pm_code) row.pm_id = codeToId.get(row.pm_code) ?? null;
      });
    }
    const packBom = packBomSource.map((row, idx) => ({
      row_number: idx + 1,
      pm_id: row.pm_id ?? null,
      pack_material_id: row.pack_material_id ?? row.packMaterialId ?? row.pm_id ?? null,
      pm_description: row.pm_description || row.description,
      pm_code: row.pm_code || row.code,
      pack_type: row.pack_type || row.level,
      qty_per_unit: row.qty_per_unit != null ? row.qty_per_unit : (row.qty != null ? row.qty : 1),
      uom: row.uom || 'pc/unit',
    }));

    const salesOrders = allOpenSo.filter((so) => {
      const items = Array.isArray(so.items) ? so.items : [];
      return items.some((l) => (l.product_code || l.productCode) === plain.product_code);
    }).slice(0, 20);
    const openSalesOrders = salesOrders.map((so) => {
      const d = so.get ? so.get({ plain: true }) : so;
      const items = Array.isArray(d.items) ? d.items : [];
      const line = items.find((l) => (l.product_code || l.productCode) === plain.product_code);
      const qty = line ? (line.quantity || line.qty || 0) : 0;
      return {
        order_id: d.order_id,
        customer_name: d.customer_name,
        quantity: qty,
        status: d.status,
      };
    });

    res.json({
      ...plain,
      formulaBom,
      packBom,
      processSteps,
      openSalesOrders,
    });
  } catch (err) {
    console.error('getProductDetail error', err);
    res.status(500).json({ error: err.message });
  }
};

const updateProduct = async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (Number.isNaN(productId)) {
      return res.status(400).json({ error: 'Invalid product id' });
    }

    const product = await Product.findByPk(productId);
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    // if product_name is being changed → check duplicate
    if (req.body.product_name) {
      const existing = await Product.findOne({
        where: {
          product_name: req.body.product_name,
          product_id: { [Op.ne]: productId },
        },
      });
      if (existing) {
        return res
          .status(409)
          .json({ error: "Product name already in use" });
      }
    }

    // Optional: update linked BOM (formula, pack, process, specs); create BOM if missing
    const bomPayload = req.body.bom;
    if (bomPayload && typeof bomPayload === 'object') {
      let bom = await BOM.findOne({ where: { product_id: productId } });
      const rmFromPayload = Array.isArray(bomPayload.rm_lines);
      const pmFromPayload = Array.isArray(bomPayload.pm_lines);

      if (!bom) {
        const nextRm = rmFromPayload ? bomPayload.rm_lines : [];
        const nextPm = pmFromPayload ? bomPayload.pm_lines : [];
        if (countMeaningfulRmLines(nextRm) < 1 || countMeaningfulPmLines(nextPm) < 1) {
          return res.status(400).json({
            error:
              'BOM must include at least one formula (RM) line and one packaging (PM) line.',
            code: 'BOM_MISSING_LINES',
          });
        }
        const productCode = (product && product.product_code) ? product.product_code : `PR-${productId}`;
        bom = await BOM.create({
          bom_code: `BOM-${productCode}`,
          name: product?.product_name || `Product ${productId}`,
          product_id: productId,
          type: 'FG',
          status: 'Draft',
          rm_lines: nextRm,
          pm_lines: nextPm,
          process_steps: Array.isArray(bomPayload.process_steps) ? bomPayload.process_steps : [],
          ph_range: bomPayload.ph_range ?? null,
          yield_pct: bomPayload.yield_pct ?? null,
          stability_summary: bomPayload.stability_summary ?? null,
          created_at: new Date(),
          updated_at: new Date(),
        });
      } else {
        const mergedRm = rmFromPayload ? bomPayload.rm_lines : bom.rm_lines || [];
        const mergedPm = pmFromPayload ? bomPayload.pm_lines : bom.pm_lines || [];
        if (rmFromPayload || pmFromPayload) {
          if (countMeaningfulRmLines(mergedRm) < 1 || countMeaningfulPmLines(mergedPm) < 1) {
            return res.status(400).json({
              error:
                'BOM must keep at least one formula (RM) line and one packaging (PM) line.',
              code: 'BOM_MISSING_LINES',
            });
          }
        }
        const bomUpdate = { updated_at: new Date() };
        if (rmFromPayload) bomUpdate.rm_lines = bomPayload.rm_lines;
        if (pmFromPayload) bomUpdate.pm_lines = bomPayload.pm_lines;
        if (Array.isArray(bomPayload.process_steps)) bomUpdate.process_steps = bomPayload.process_steps;
        if (bomPayload.ph_range !== undefined) bomUpdate.ph_range = bomPayload.ph_range;
        if (bomPayload.yield_pct !== undefined) bomUpdate.yield_pct = bomPayload.yield_pct;
        if (bomPayload.stability_summary !== undefined) bomUpdate.stability_summary = bomPayload.stability_summary;
        await bom.update(bomUpdate);
      }
    }

    const body = { ...req.body };
    delete body.bom;

    await product.update({
      ...body,
      updated_at: new Date(),
    });

    return res.json(product);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const deleteProduct = async (req, res) => {
    try {
        const productId = parseInt(req.params.id, 10);
        if (Number.isNaN(productId)) return res.status(400).json({ error: 'Invalid product id' });

        const product = await Product.findByPk(productId);
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }
        const resolvedProductId = product.product_id;

        // FK blockers:
        // - warehouse_inventory.product_id -> products.product_id (restricts product delete)
        // - planning_extracted.product_id -> products.product_id (restricts product delete)
        // Remove these dependents first.

        // warehouse_inventory may store item_type as 'PR', while UI labels it 'FG/PR'.
        // Don't rely on item_type here; just remove any warehouse_inventory row tied to the product.
        const whInvRows = await WarehouseInventory.findAll({ where: { product_id: resolvedProductId } });
        for (const whInv of whInvRows) {
          await WarehouseInventoryLocationHistory.destroy({ where: { warehouse_inventory_id: whInv.id } });
          await whInv.destroy(); // cascades to rack items via FK onDelete: CASCADE
        }

        await PlanningExtracted.destroy({ where: { product_id: resolvedProductId } }); // cascades to planning_batches/bom_override/reserved rows

        await product.destroy();

        // Invalidate cached product lists/details so the UI refreshes immediately.
        // Cache key pattern is built by createCacheReadMiddleware:
        //   products:v1:/api/v1/products:<stableQuery>:auth:<scope>
        await redisCache.delByPattern('products:v1:/api/v1/products:');

        res.status(204).send();
    } catch (err) {
        console.error('deleteProduct error', {
          productId: req?.params?.id,
          name: err?.name,
          message: err?.message,
          originalCode: err?.original?.code,
          originalDetail: err?.original?.detail,
        });
        const isFk =
          err &&
          (err.name === 'SequelizeForeignKeyConstraintError' ||
            err.name === 'SequelizeDatabaseError' ||
            err.original?.code === '23503');
        if (isFk) {
          return res.status(409).json({
            error:
              'Cannot delete product because it is referenced by other records (e.g. BOM / planning / batches). Remove dependencies first.',
            code: 'PR_DELETE_FK_CONSTRAINT',
          });
        }
        res.status(500).json({
          error: err?.message || 'Failed to delete product',
          name: err?.name,
          code: err?.original?.code,
        });
    }
};

const getCategory = async (req, res) => {
    try {
        const categories = await Category.findAll();
        res.json(categories);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const saveCategory = async (req, res) => {
    try {
        const { error } = categorySchema.validate(req.body, { abortEarly: false });
        if (error) {
            return res.status(400).json({ errors: error.details.map(e => e.message) });
        }
        await Category.findOne({ where: { name: req.body.name } }).then(category => {
            if (category) {
                return res.status(400).json({ error: 'Category already exists!' });
            } else {
                Category.create(req.body).then(category => {
                    res.json(category);
                }).catch(err => {
                    return res.status(500).json({ error: err.message });
                });
            }
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

const getCategoryById = async (req, res) => {
    try {
        const category = await Category.findByPk(req.params.id);
        if (!category) {
            return res.status(404).json({ error: 'Category not found' });
        }
        res.json(category);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const updateCategory = async (req, res) => {
    try {
        const { error } = categoryUpdateSchema.validate(req.body, { abortEarly: false });
        if (error) {
            return res.status(400).json({ errors: error.details.map(e => e.message) });
        }
        const category = await Category.findByPk(req.params.id);
        if (!category) {
            return res.status(404).json({ error: 'Category not found' });
        }
        const existing = await Category.findOne({
            where: { name: req.body.name, id: { [Op.ne]: req.params.id } }
        });
        if (existing) {
            return res.status(400).json({ error: 'Category name already in use' });
        }
        await category.update(req.body);
        res.json(category);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const deleteCategory = async (req, res) => {
    try {
        const category = await Category.findByPk(req.params.id);
        if (!category) {
            return res.status(404).json({ error: 'Category not found' });
        }
        await category.destroy();
        res.json({ message: 'Category deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

module.exports = {
    saveProduct,
    createPRRegistration,
    getAllProducts,
    getProductById,
    getProductDetail,
    updateProduct,
    deleteProduct,
    getCategory,
    saveCategory,
    getCategoryById,
    updateCategory,
    deleteCategory,

};
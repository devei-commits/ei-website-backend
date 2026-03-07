const { Product } = require('./models');
const { productSchema, productUpdateSchema, categorySchema, categoryUpdateSchema } = require('./schemas');
const { Op } = require('sequelize');
const BOM = require('../bom/models');
const PackMaterial = require('../packMaterials/models');
const SalesOrder = require('../salesOrders/models');

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

    return res.status(201).json(product);
  } catch (err) {
    return res.status(500).json({ error: err.message });
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
    const products = await Product.findAll({ order: [['product_code', 'ASC']] });
    const productCodes = products.map((p) => p.product_code).filter(Boolean);
    const productIds = products.map((p) => p.product_id);

    const bomsByProductId = {};
    if (productIds.length > 0) {
      const boms = await BOM.findAll({ where: { product_id: { [Op.in]: productIds } } });
      boms.forEach((b) => {
        bomsByProductId[b.product_id] = b;
      });
    }

    const packMaterialsByCode = {};
    const allPack = await PackMaterial.findAll();
    allPack.forEach((pm) => {
      const prods = Array.isArray(pm.products) ? pm.products : [];
      prods.forEach((code) => {
        if (!packMaterialsByCode[code]) packMaterialsByCode[code] = [];
        packMaterialsByCode[code].push(pm);
      });
    });

    const openStatuses = ['Draft', 'Submitted', 'Confirmed', 'Processing', 'Pending', 'In Progress'];
    let openSoCountByCode = {};
    try {
      const salesOrders = await SalesOrder.findAll({
        where: { status: { [Op.in]: openStatuses } },
        attributes: ['id', 'order_id', 'customer_name', 'status', 'items'],
      });
      salesOrders.forEach((so) => {
        const items = Array.isArray(so.items) ? so.items : [];
        items.forEach((line) => {
          const code = line.product_code || line.productCode;
          if (code) {
            openSoCountByCode[code] = (openSoCountByCode[code] || 0) + 1;
          }
        });
      });
    } catch (_) {
      openSoCountByCode = {};
    }

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

    const bom = await BOM.findOne({ where: { product_id: id } });
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
        pct_w_w: line.pct_w_w != null ? line.pct_w_w : (line.pctWw != null ? line.pctWw : line.pct),
        uom: line.uom || 'kg',
      });
    });
    const formulaBom = Object.entries(phases).map(([phaseName, ingredients]) => ({
      phase: phaseName,
      ingredients,
    }));

    const allPackForProduct = await PackMaterial.findAll();
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
      pm_description: row.pm_description || row.description,
      pm_code: row.pm_code || row.code,
      pack_type: row.pack_type || row.level,
      qty_per_unit: row.qty_per_unit != null ? row.qty_per_unit : (row.qty != null ? row.qty : 1),
      uom: row.uom || 'pc/unit',
    }));

    const openStatuses = ['Draft', 'Submitted', 'Confirmed', 'Processing', 'Pending', 'In Progress'];
    const allOpenSo = await SalesOrder.findAll({
      where: { status: { [Op.in]: openStatuses } },
      order: [['order_date', 'DESC']],
    });
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
      if (!bom) {
        const productCode = (product && product.product_code) ? product.product_code : `PR-${productId}`;
        bom = await BOM.create({
          bom_code: `BOM-${productCode}`,
          name: product?.product_name || `Product ${productId}`,
          product_id: productId,
          type: 'FG',
          status: 'Draft',
          rm_lines: Array.isArray(bomPayload.rm_lines) ? bomPayload.rm_lines : [],
          pm_lines: Array.isArray(bomPayload.pm_lines) ? bomPayload.pm_lines : [],
          process_steps: Array.isArray(bomPayload.process_steps) ? bomPayload.process_steps : [],
          ph_range: bomPayload.ph_range ?? null,
          yield_pct: bomPayload.yield_pct ?? null,
          stability_summary: bomPayload.stability_summary ?? null,
          created_at: new Date(),
          updated_at: new Date(),
        });
      } else {
        const bomUpdate = { updated_at: new Date() };
        if (Array.isArray(bomPayload.rm_lines)) bomUpdate.rm_lines = bomPayload.rm_lines;
        if (Array.isArray(bomPayload.pm_lines)) bomUpdate.pm_lines = bomPayload.pm_lines;
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
        const product = await Product.findByPk(req.params.id);
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }
        await product.destroy();
        res.json({ message: 'Product deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
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
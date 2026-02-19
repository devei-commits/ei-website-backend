const { Product } = require('./models');
const { productSchema, productUpdateSchema, categorySchema, categoryUpdateSchema } = require('./schemas');
const { Op } = require('sequelize');

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

const getAllProducts = async (req, res) => {
    try {
        res.json(await Product.findAll());
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

const updateProduct = async (req, res) => {
  try {
    const productId = req.params.id;

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

    // update with updated_at
    await product.update({
      ...req.body,
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
    updateProduct,
    deleteProduct,
    getCategory,
    saveCategory,
    getCategoryById,
    updateCategory,
    deleteCategory,

};
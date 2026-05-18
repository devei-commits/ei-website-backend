const { Op } = require('sequelize');
const sequelize = require('../../db');
const { User } = require('../models/index');
const { buildInternalStaffWhere } = require('../users/internalStaff');
const Enquiry = require('../enquiries/models');
const Newdevelopment = require('../newdevelopments/models');
const { FulfillmentOrder } = require('../fulfillment/models');
const SalesOrder = require('../salesOrders/models');
const PurchaseOrder = require('../purchaseOrders/models');
const ProcurementRequest = require('../procurementRequests/models');
const GoodsReceivedNote = require('../grn/models');
const MaterialRequestNote = require('../mrn/models');
const VendorClient = require('../vendorClient/models');
const RawMaterial = require('../rawMaterials/models');
const PackMaterial = require('../packMaterials/models');
const { Product } = require('../products/models');
const Role = require('../models/Role');
const Permission = require('../models/Permission');

/** Matches warehouse-inventory listPayload / low-threshold-alerts (SIH = wh + ml1 + ml2). */
const STOCK_IN_HAND_SQL =
  '(COALESCE(wh_stock, 0) + COALESCE(ml1_stock, 0) + COALESCE(ml2_stock, 0))';

const LOW_STOCK_WHERE_SQL = `COALESCE(reorder_pt, 0) > 0 AND ${STOCK_IN_HAND_SQL} <= COALESCE(reorder_pt, 0)`;

/** Procurement lifecycle statuses still needing action (case-insensitive). */
const OPEN_PR_STATUSES_LOWER = ['new', 'quoted', 'pending', 'po draft'];
const TERMINAL_FO_STATUSES = ['closed', 'delivered'];
const OPEN_ENQUIRY_TERMINAL_LOWER = ['resolved', 'closed'];

function statusWhereInLower(columnName, valuesLower) {
  return sequelize.where(
    sequelize.fn('lower', sequelize.fn('trim', sequelize.fn('coalesce', sequelize.col(columnName), ''))),
    { [Op.in]: valuesLower }
  );
}

function timeAgo(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} mins ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} hours ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)} days ago`;
  return d.toLocaleDateString();
}

function formatDueLabel(date) {
  if (!date) return undefined;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return undefined;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(d);
  due.setHours(0, 0, 0, 0);
  const diff = Math.round((due - today) / (24 * 60 * 60 * 1000));
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff < 0) return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function priorityFromEnquiry(priority) {
  const p = String(priority || '').toLowerCase();
  if (p === 'high' || p === 'urgent') return 'high';
  if (p === 'low') return 'low';
  return 'medium';
}

function priorityFromProcurement(priority) {
  const p = String(priority || '').toLowerCase();
  if (p === 'high' || p === 'urgent') return 'high';
  if (p === 'low') return 'low';
  return 'medium';
}

async function safeDashboardStep(label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[dashboard/overview] ${label}:`, err);
    return fallback;
  }
}

/** Same rule as GET /warehouse-inventory/low-threshold-alerts. */
async function countLowStockSkus() {
  const [row] = await sequelize.query(
    `SELECT COUNT(*)::int AS count FROM warehouse_inventory WHERE ${LOW_STOCK_WHERE_SQL}`,
    { type: sequelize.QueryTypes.SELECT }
  );
  return Number(row?.count) || 0;
}

async function fetchLowStockPreviewRows(limit = 3) {
  return sequelize.query(
    `SELECT wi.id, wi.item_type,
            COALESCE(rm.code, pm.code, p.product_code, p.zoho_sku_code, CAST(wi.id AS TEXT)) AS code,
            COALESCE(rm.name, pm.description, p.product_name, 'Item') AS name,
            ${STOCK_IN_HAND_SQL} AS stock_in_hand,
            wi.reorder_pt, wi.updated_at
     FROM warehouse_inventory wi
     LEFT JOIN raw_materials rm ON wi.raw_material_id = rm.id
     LEFT JOIN pack_materials pm ON wi.pack_material_id = pm.id
     LEFT JOIN products p ON wi.product_id = p.product_id
     WHERE ${LOW_STOCK_WHERE_SQL}
     ORDER BY wi.updated_at DESC NULLS LAST
     LIMIT :limit`,
    { replacements: { limit }, type: sequelize.QueryTypes.SELECT }
  );
}

async function getWebsiteRequestCounts() {
  const isCustomerScope = {
    [Op.or]: [{ ticket_scope: 'customer' }, { ticket_scope: null }],
  };
  const normalizedType = sequelize.fn('lower', sequelize.fn('coalesce', sequelize.col('enquiry_type'), ''));
  const normalizedCategory = sequelize.fn('lower', sequelize.fn('coalesce', sequelize.col('category'), ''));
  const normalizedSource = sequelize.fn('lower', sequelize.fn('coalesce', sequelize.col('source'), ''));
  const normalizedSubject = sequelize.fn('lower', sequelize.fn('coalesce', sequelize.col('subject'), ''));
  const normalizedDescription = sequelize.fn('lower', sequelize.fn('coalesce', sequelize.col('description'), ''));

  const contactWhere = {
    [Op.and]: [
      isCustomerScope,
      {
        [Op.or]: [
          sequelize.where(normalizedType, { [Op.in]: ['contact'] }),
          sequelize.where(normalizedCategory, { [Op.in]: ['contact', 'contact-enquiry', 'contact_enquiry'] }),
          sequelize.where(normalizedSource, { [Op.in]: ['website-contact', 'website-contact-form', 'contact-form'] }),
          sequelize.where(normalizedSubject, { [Op.like]: '%contact%' }),
        ],
      },
    ],
  };

  const sampleWhere = {
    [Op.and]: [
      isCustomerScope,
      {
        [Op.or]: [
          sequelize.where(normalizedType, { [Op.in]: ['process', 'product', 'sample', 'product-sample', 'process-sample'] }),
          sequelize.where(normalizedCategory, { [Op.in]: ['process', 'product', 'sample', 'product-sample', 'process-sample'] }),
          sequelize.where(normalizedSubject, { [Op.like]: '%sample%' }),
          sequelize.where(normalizedDescription, { [Op.like]: '%sample%' }),
        ],
      },
    ],
  };

  const technicalDocWhere = {
    [Op.and]: [
      isCustomerScope,
      {
        [Op.or]: [
          sequelize.where(normalizedType, { [Op.in]: ['technical', 'technical-doc', 'tech-doc', 'documentation'] }),
          sequelize.where(normalizedCategory, { [Op.in]: ['technical', 'technical-doc', 'tech-doc', 'documentation'] }),
          sequelize.where(normalizedSubject, { [Op.like]: '%technical%' }),
          sequelize.where(normalizedSubject, { [Op.like]: '%doc%' }),
          sequelize.where(normalizedDescription, { [Op.like]: '%technical%' }),
          sequelize.where(normalizedDescription, { [Op.like]: '%doc%' }),
        ],
      },
    ],
  };

  const openEnquiryWhere = {
    [Op.and]: [
      isCustomerScope,
      sequelize.where(
        sequelize.fn('lower', sequelize.fn('trim', sequelize.fn('coalesce', sequelize.col('status'), ''))),
        { [Op.notIn]: OPEN_ENQUIRY_TERMINAL_LOWER }
      ),
    ],
  };

  const [openEnquiries, contactEnquiries, productSampleRequests, technicalDocRequests, newDevelopmentRequests, resolvedEnquiries] =
    await Promise.all([
      Enquiry.count({ where: openEnquiryWhere }),
      Enquiry.count({ where: contactWhere }),
      Enquiry.count({ where: sampleWhere }),
      Enquiry.count({ where: technicalDocWhere }),
      Newdevelopment.count(),
      Enquiry.count({
        where: {
          [Op.and]: [
            isCustomerScope,
            sequelize.where(
              sequelize.fn('lower', sequelize.fn('trim', sequelize.fn('coalesce', sequelize.col('status'), ''))),
              { [Op.in]: OPEN_ENQUIRY_TERMINAL_LOWER }
            ),
          ],
        },
      }),
    ]);

  return {
    openEnquiries,
    contactEnquiries,
    productSampleRequests,
    technicalDocRequests,
    newDevelopmentRequests,
    resolvedEnquiries,
  };
}

async function buildRecentActivity() {
  const [enquiries, fulfillment, procurement, grns] = await Promise.all([
    Enquiry.findAll({
      where: { [Op.or]: [{ ticket_scope: 'customer' }, { ticket_scope: null }] },
      order: [['updated_at', 'DESC']],
      limit: 5,
      attributes: ['enquiry_id', 'ticket_number', 'subject', 'status', 'updated_at', 'customer', 'current_assignee'],
    }),
    FulfillmentOrder.findAll({
      order: [['updated_at', 'DESC']],
      limit: 5,
      attributes: ['id', 'so_no', 'customer_name', 'so_status', 'updated_at'],
    }),
    ProcurementRequest.findAll({
      order: [['updated_at', 'DESC']],
      limit: 5,
      attributes: ['id', 'status', 'requested_by', 'updated_at', 'priority'],
    }),
    GoodsReceivedNote.findAll({
      order: [['updated_at', 'DESC']],
      limit: 5,
      attributes: ['id', 'grn_no', 'status', 'vendor', 'updated_at'],
    }),
  ]);

  const items = [];

  enquiries.forEach((r) => {
    const d = r.get ? r.get({ plain: true }) : r;
    const customerName =
      d.customer && typeof d.customer === 'object' ? d.customer.name || d.customer.email : null;
    const assigneeName =
      d.current_assignee && typeof d.current_assignee === 'object'
        ? d.current_assignee.staffName || d.current_assignee.staffEmail
        : null;
    items.push({
      id: `enq-${d.enquiry_id}`,
      action: `Enquiry ${d.ticket_number || d.enquiry_id} — ${d.status || 'open'}${d.subject ? `: ${String(d.subject).slice(0, 60)}` : ''}`,
      module: 'Enquiries',
      user: assigneeName || customerName || 'System',
      time: timeAgo(d.updated_at),
      type: 'enquiry',
      sortAt: d.updated_at,
    });
  });

  fulfillment.forEach((r) => {
    const d = r.get ? r.get({ plain: true }) : r;
    items.push({
      id: `fo-${d.id}`,
      action: `Fulfillment ${d.so_no} — ${d.so_status || 'planned'} (${d.customer_name || ''})`,
      module: 'Order Hub',
      user: 'Fulfillment',
      time: timeAgo(d.updated_at),
      type: 'order',
      sortAt: d.updated_at,
    });
  });

  procurement.forEach((r) => {
    const d = r.get ? r.get({ plain: true }) : r;
    items.push({
      id: `pr-${d.id}`,
      action: `Procurement request #${d.id} — ${d.status || 'Pending'}`,
      module: 'Procurement',
      user: d.requested_by || 'Planning',
      time: timeAgo(d.updated_at),
      type: 'task',
      sortAt: d.updated_at,
    });
  });

  grns.forEach((r) => {
    const d = r.get ? r.get({ plain: true }) : r;
    const verb = d.status === 'GRN Complete' ? 'completed' : (d.status || 'updated');
    items.push({
      id: `grn-${d.id}`,
      action: `${d.grn_no || 'GRN'} ${verb}${d.vendor ? ` — ${d.vendor}` : ''}`,
      module: 'Receiving',
      user: 'Warehouse',
      time: timeAgo(d.updated_at),
      type: 'order',
      sortAt: d.updated_at,
    });
  });

  items.sort((a, b) => new Date(b.sortAt || 0) - new Date(a.sortAt || 0));
  return items.slice(0, 10).map(({ id, action, module, user, time, type }) => ({
    id,
    action,
    module,
    user,
    time,
    type,
  }));
}

async function buildPendingItems() {
  const openPrWhere = statusWhereInLower('status', OPEN_PR_STATUSES_LOWER);
  const openEnquiryWhere = {
    [Op.and]: [
      { [Op.or]: [{ ticket_scope: 'customer' }, { ticket_scope: null }] },
      sequelize.where(
        sequelize.fn('lower', sequelize.fn('trim', sequelize.fn('coalesce', sequelize.col('status'), ''))),
        { [Op.notIn]: OPEN_ENQUIRY_TERMINAL_LOWER }
      ),
    ],
  };

  const [openEnquiries, openPrs, openGrns, lowStockRows] = await Promise.all([
    Enquiry.findAll({
      where: openEnquiryWhere,
      order: [['updated_at', 'ASC']],
      limit: 4,
      attributes: ['enquiry_id', 'ticket_number', 'subject', 'status', 'priority', 'sla_deadline', 'updated_at'],
    }),
    ProcurementRequest.findAll({
      where: openPrWhere,
      order: [['required_by_date', 'ASC'], ['updated_at', 'ASC']],
      limit: 4,
      attributes: ['id', 'status', 'priority', 'required_by_date', 'requested_by'],
    }),
    GoodsReceivedNote.findAll({
      where: { status: { [Op.ne]: 'GRN Complete' } },
      order: [['expected_date', 'ASC'], ['id', 'DESC']],
      limit: 3,
      attributes: ['id', 'grn_no', 'status', 'expected_date', 'vendor'],
    }),
    fetchLowStockPreviewRows(3),
  ]);

  const items = [];

  openEnquiries.forEach((r) => {
    const d = r.get ? r.get({ plain: true }) : r;
    items.push({
      id: `pending-enq-${d.enquiry_id}`,
      title: `Review enquiry ${d.ticket_number || d.enquiry_id}${d.subject ? ` — ${String(d.subject).slice(0, 50)}` : ''}`,
      module: 'Enquiries',
      priority: priorityFromEnquiry(d.priority),
      dueDate: formatDueLabel(d.sla_deadline),
    });
  });

  openPrs.forEach((r) => {
    const d = r.get ? r.get({ plain: true }) : r;
    items.push({
      id: `pending-pr-${d.id}`,
      title: `Procurement PR #${d.id} (${d.status || 'Pending'})`,
      module: 'Procurement',
      priority: priorityFromProcurement(d.priority),
      dueDate: formatDueLabel(d.required_by_date),
    });
  });

  openGrns.forEach((r) => {
    const d = r.get ? r.get({ plain: true }) : r;
    items.push({
      id: `pending-grn-${d.id}`,
      title: `Complete GRN ${d.grn_no || d.id}${d.vendor ? ` — ${d.vendor}` : ''}`,
      module: 'Receiving',
      priority: 'high',
      dueDate: formatDueLabel(d.expected_date),
    });
  });

  lowStockRows.forEach((row) => {
    const stock = Number(row.stock_in_hand) || 0;
    const reorder = Number(row.reorder_pt) || 0;
    const critical = reorder > 0 && stock < reorder * 0.5;
    items.push({
      id: `pending-stock-${row.id}`,
      title: `Low stock — ${row.code} (${row.name})`,
      module: 'Inventory',
      priority: critical ? 'high' : 'medium',
      dueDate: 'Today',
    });
  });

  return items.slice(0, 12);
}

async function countCoreKpis() {
  const staffWhere = buildInternalStaffWhere();
  const activeStaffWhere = buildInternalStaffWhere([
    {
      [Op.or]: [{ status: 'active' }, { status: null }, { status: '' }],
    },
  ]);
  const openPrWhere = statusWhereInLower('status', OPEN_PR_STATUSES_LOWER);
  const releasedPoWhere = sequelize.where(
    sequelize.fn('lower', sequelize.fn('trim', sequelize.fn('coalesce', sequelize.col('status'), ''))),
    'released'
  );

  const [
    fulfillmentCount,
    salesOrderCount,
    purchaseOrderCount,
    pendingReview,
    activeUsers,
    totalStaffUsers,
    openProcurement,
    releasedPos,
    fulfillmentInProgress,
    fulfillmentShipped,
    pendingGrn,
    openMrn,
    lowStockItems,
    websiteRequests,
    vendorCount,
    clientCount,
    rawMaterialCount,
    packMaterialCount,
    productCount,
    roleCount,
    permissionCount,
  ] = await Promise.all([
    FulfillmentOrder.count(),
    SalesOrder.count(),
    PurchaseOrder.count(),
    ProcurementRequest.count({ where: openPrWhere }),
    User.count({ where: activeStaffWhere }),
    User.count({ where: staffWhere }),
    ProcurementRequest.count({ where: openPrWhere }),
    PurchaseOrder.count({ where: releasedPoWhere }),
    FulfillmentOrder.count({ where: { so_status: { [Op.notIn]: TERMINAL_FO_STATUSES } } }),
    FulfillmentOrder.count({ where: { so_status: { [Op.in]: ['shipped', 'delivered'] } } }),
    GoodsReceivedNote.count({ where: { status: { [Op.ne]: 'GRN Complete' } } }),
    MaterialRequestNote.count({ where: { status: { [Op.ne]: 'Completed' } } }),
    countLowStockSkus(),
    getWebsiteRequestCounts(),
    VendorClient.count({ where: { type: 'vendor' } }),
    VendorClient.count({ where: { type: 'client' } }),
    RawMaterial.count(),
    PackMaterial.count(),
    Product.count(),
    Role.count(),
    Permission.count(),
  ]);

  const totalOrders = fulfillmentCount + salesOrderCount + purchaseOrderCount;
  const openTasks = openProcurement + pendingGrn + openMrn;

  return {
    stats: {
      totalOrders,
      pendingReview,
      activeUsers,
      openEnquiries: websiteRequests.openEnquiries,
      openTasks,
      lowStockItems,
      issuedPos: releasedPos,
      fulfillmentCount,
      salesOrderCount,
      purchaseOrderCount,
    },
    websiteRequests,
    moduleStats: {
      orderManagement: { total: totalOrders, pending: pendingReview },
      orderHub: { inProgress: fulfillmentInProgress, shipped: fulfillmentShipped },
      userManagement: { active: activeUsers, total: totalStaffUsers },
      roleManagement: { roles: roleCount, permissions: permissionCount },
      taskManagement: { open: openTasks, completedFulfillment: Math.max(0, fulfillmentCount - fulfillmentInProgress) },
      enquiryManagement: {
        open: websiteRequests.openEnquiries,
        resolved: websiteRequests.resolvedEnquiries,
      },
      procurement: { pending: openProcurement, released: releasedPos },
      rawMaterials: { materials: rawMaterialCount, lowStock: lowStockItems },
      vendorClient: { vendors: vendorCount, clients: clientCount },
      catalogue: { products: productCount },
      packaging: { types: packMaterialCount },
    },
  };
}

/**
 * GET /api/v1/dashboard/overview
 * Single aggregated payload for EI-Admin homepage (stats, activity, pending, module counts).
 */
async function getOverview(req, res) {
  try {
    const core = await countCoreKpis();
    const [recentActivity, pendingItems] = await Promise.all([
      safeDashboardStep('recentActivity', buildRecentActivity, []),
      safeDashboardStep('pendingItems', buildPendingItems, []),
    ]);

    res.status(200).json({
      success: true,
      data: {
        ...core,
        recentActivity,
        pendingItems,
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[dashboard/overview] error:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to load dashboard overview' });
  }
}

module.exports = { getOverview, countLowStockSkus, countCoreKpis };

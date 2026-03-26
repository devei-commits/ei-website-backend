const { Order, OrderItem } = require('./models');
const { Product } = require('../products/models');
const { Payment } = require('../payments/models');
const { Op } = require('sequelize');
const Address = require('../models/Addresses');
const { User } = require('../users/models');
const db = require('../../db');
// const { orderSchema, updateOrderSchema } = require('./schemas');


const saveOrder = async (req, res) => {
    const t = await db.transaction();
    try {
        const {
            billing_address_id,
            shipping_address_id,
            order_items,
            shipping_total = 0,
            discount_total = 0,
            payment_terms,
            payment_method,
            cheque_details,
        } = req.body;
        const user_id = req.user.id;

        if (!order_items || !Array.isArray(order_items) || order_items.length === 0) {
            await t.rollback();
            return res.status(400).json({ error: 'order_items is required and must be a non-empty array' });
        }

        const productIds = [...new Set(order_items.map((item) => Number(item.product_id)).filter(Boolean))];
        const existingProducts = await Product.findAll({
            where: { product_id: productIds },
            attributes: ['product_id'],
        });
        const existingIds = new Set(existingProducts.map((p) => Number(p.product_id)));
        const missingIds = productIds.filter((id) => !existingIds.has(id));
        if (missingIds.length > 0) {
            await t.rollback();
            return res.status(400).json({
                error: 'One or more products in your cart are no longer available.',
                invalidProductIds: missingIds,
            });
        }

        const orderDateStr = new Date().toISOString().slice(0, 10);
        const defaultLeadTimeDaysNew = 90;
        const defaultLeadTimeDaysReorder = 45;

        // "Reorder of existing product" rule:
        // mark a product as "reorder" if the user has previously placed a non-cancelled order for it.
        const previousOrderItems = await OrderItem.findAll({
            attributes: ['product_id'],
            where: { product_id: { [Op.in]: productIds } },
            include: [
                {
                    model: Order,
                    required: true,
                    attributes: [],
                    where: { user_id, order_status: { [Op.ne]: 'cancelled' } },
                },
            ],
            transaction: t,
        });
        const reorderProductIds = new Set(
            (previousOrderItems || [])
                .map((r) => Number(r.product_id))
                .filter((x) => Number.isFinite(x) && x > 0)
        );

        const subtotal = order_items.reduce((acc, item) => acc + (item.unit_price * item.quantity), 0);
        const tax_total = order_items.reduce((acc, item) => acc + (item.tax_amount || 0), 0);
        const grand_total = subtotal + tax_total + shipping_total - discount_total;

        // Payment terms are always percentage based.
        // If caller does not send them, fallback to user profile's advance percentage behavior.
        let advancePct = 0;
        let preShipmentPct = 0;
        let postShipmentPct = 0;
        let creditDays = null;
        const user = await User.findByPk(user_id, {
            attributes: ['userid', 'fname', 'lname', 'display_name', 'email', 'mobile', 'advance_payment', 'advance_amount'],
        });

        const clampPct = (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return 0;
            return Math.max(0, Math.min(100, n));
        };
        const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;
        if (payment_terms && typeof payment_terms === 'object') {
            const pt = payment_terms;
            advancePct = clampPct(pt.advance_pct ?? pt.advancePct);
            preShipmentPct = clampPct(pt.pre_shipment_pct ?? pt.preShipmentPct);
            postShipmentPct = clampPct(pt.post_shipment_pct ?? pt.postShipmentPct);
            const cdRaw = pt.credit_days ?? pt.creditDays;
            if (cdRaw != null && Number.isFinite(Number(cdRaw)) && Number(cdRaw) >= 0) {
                creditDays = Math.floor(Number(cdRaw));
            }
        } else if (user && user.advance_payment && user.advance_amount != null) {
            // Backward compatibility: historical `advance_amount` is interpreted as percentage.
            advancePct = clampPct(user.advance_amount);
            preShipmentPct = clampPct(100 - advancePct);
            postShipmentPct = 0;
        } else {
            advancePct = 0;
            preShipmentPct = 100;
            postShipmentPct = 0;
        }

        const totalPct = advancePct + preShipmentPct + postShipmentPct;
        if (totalPct > 100.0001) {
            await t.rollback();
            return res.status(400).json({ error: 'Invalid payment terms: total percentage cannot exceed 100.' });
        }
        const advance_amount_due = round2((grand_total * advancePct) / 100);
        const preShipmentAmountDue = round2((grand_total * preShipmentPct) / 100);
        const postShipmentAmountDue = round2((grand_total * postShipmentPct) / 100);

        // Pre-generate internal SO number (EI-SO-YYYY-XXX) to link Order ↔ Fulfillment ↔ Production.
        const { FulfillmentOrder: FulfillmentOrderModel } = require('../fulfillment/models');
        const latestSoForOrder = await FulfillmentOrderModel.findOne({
            order: [['id', 'DESC']],
            attributes: ['so_no'],
            transaction: t,
        });
        let nextSoNumForOrder = 1;
        if (latestSoForOrder && latestSoForOrder.so_no) {
            const match = String(latestSoForOrder.so_no).match(/(\d+)$/);
            if (match) nextSoNumForOrder = parseInt(match[1], 10) + 1;
        }
        const soYearForOrder = new Date().getFullYear();
        const generatedSoNo = `EI-SO-${soYearForOrder}-${String(nextSoNumForOrder).padStart(3, '0')}`;

        const order = await Order.create({
            user_id,
            billing_address_id,
            shipping_address_id,
            order_status: 'pending',
            payment_status: 'pending',
            so_no: generatedSoNo,
            fulfillment_stage: 'pending',
            subtotal,
            discount_total,
            tax_total,
            shipping_total,
            grand_total,
            advance_amount_due,
        }, { transaction: t });

        const orderItemsToCreate = order_items.map(item => ({
            product_id: Number(item.product_id),
            quantity: Number(item.quantity),
            unit_price: Number(item.unit_price),
            discount_amount: Number(item.discount_amount || 0),
            tax_amount: Number(item.tax_amount || 0),
            order_id: order.order_id,
            line_total: Number(item.unit_price) * Number(item.quantity),
        }));

        await OrderItem.bulkCreate(orderItemsToCreate, { transaction: t });

        // Auto-create a fulfillment entry so Admin can see/track website orders in Fulfillment.
        // Also create production_batches + fulfillment_batch_splits so Fulfillment doesn't show
        // "No production batches linked yet" and can track FG readiness.
        const { FulfillmentOrder, FulfillmentOrderItem, FulfillmentBatchSplit } = require('../fulfillment/models');
        const { ProductionBatch } = require('../production/models');
        const SalesOrder = require('../salesOrders/models');
        const PlanningExtracted = require('../planningExtracted/models');
        const BOM = require('../bom/models');
        const RawMaterial = require('../rawMaterials/models');
        const PackMaterial = require('../packMaterials/models');
        const { ReservedBatchItem } = require('../fulfillment/models');
        const { syncWarehouseReserved } = require('../planningExtracted/controller');
        const shipAddr = shipping_address_id ? await Address.findByPk(shipping_address_id, { transaction: t }) : null;
        const shipAddressText = shipAddr
            ? [
                shipAddr.address_line1,
                shipAddr.address_line2,
                shipAddr.landmark,
                shipAddr.city_text,
                shipAddr.state_text,
                shipAddr.country_text,
                shipAddr.pincode,
              ].filter(Boolean).join(', ')
            : null;

        const customerName = [user?.fname, user?.lname].filter(Boolean).join(' ')
            || user?.display_name
            || user?.email
            || 'Customer';

        // Use the same SO number for Fulfillment/Production as stored on Order
        const soNo = generatedSoNo;
        const ffOrder = await FulfillmentOrder.create(
            {
                so_no: soNo,
                sales_order_id: null,
                customer_name: customerName,
                customer_city: shipAddr?.city_text || null,
                order_date: new Date(),
                due_date: null,
                priority: 'normal',
                so_status: 'planned',
                so_value: grand_total,
                ship_address: shipAddressText,
                payment_terms: null,
                notes: `Auto-created from website order ${order.order_id}`,
            },
            { transaction: t }
        );

        const products = await Product.findAll({
            where: { product_id: productIds },
            attributes: ['product_id', 'product_name', 'product_code', 'product_sku', 'mrp_price'],
            transaction: t,
        });
        const productMap = new Map(products.map((p) => [Number(p.product_id), p.get ? p.get({ plain: true }) : p]));

        const ffItems = orderItemsToCreate.map((it, idx) => {
            const p = productMap.get(Number(it.product_id)) || {};
            return {
                fulfillment_order_id: ffOrder.id,
                item_no: String(idx + 1),
                sku: p.product_sku || p.product_code || null,
                product_name: p.product_name || `Product ${it.product_id}`,
                pack: null,
                ordered_qty: Number(it.quantity) || 0,
                rate: Number(p.mrp_price ?? it.unit_price ?? 0) || 0,
                unit_price: Number(it.unit_price ?? 0) || 0,
            };
        });
        const createdItems = await FulfillmentOrderItem.bulkCreate(ffItems, { transaction: t, returning: true });

        // Create SalesOrder + PlanningExtracted rows so planning-extracted is not empty for website orders.
        const createdByName = req.user ? (req.user.fullName || req.user.email) : null;
        const soRow = await SalesOrder.create({
            order_id: soNo,
            customer_name: customerName,
            order_date: orderDateStr,
            expected_shipment_date: null,
            payment_terms: null,
            status: 'Approved',
            items: orderItemsToCreate.map((it) => {
                const p = productMap.get(Number(it.product_id)) || {};
                return {
                    product_id: Number(it.product_id),
                    sku: p.product_sku || p.product_code || '',
                    productName: p.product_name || `Product ${it.product_id}`,
                    pack: '',
                    quantity: Number(it.quantity) || 0,
                    unitPrice: Number(it.unit_price) || 0,
                };
            }),
            created_by: createdByName,
        }, { transaction: t });

        // If BOM exists for a product, create PlanningExtracted line with computed RM/PM quantities and reserve stock.
        const affectedRmIds = new Set();
        const affectedPmIds = new Set();
        let computedOrderLeadTimeDays = 0;

        for (const it of orderItemsToCreate) {
            const productId = Number(it.product_id);
            if (!productId) continue;
            const bom = await BOM.findOne({ where: { product_id: productId }, transaction: t });
            const rmLines = bom && Array.isArray(bom.rm_lines) ? bom.rm_lines : [];
            const pmLines = bom && Array.isArray(bom.pm_lines) ? bom.pm_lines : [];
            const qtyUnits = Number(it.quantity) || 0;
            const batchSizeKg = (productMap.get(productId)?.batch_size_kg) || 500;
            const batchesRequired = batchSizeKg > 0 ? Math.ceil(qtyUnits / batchSizeKg) : 1;

            const rawMaterials = [];
            for (const line of rmLines) {
                const pct = Number(line.pct_w_w ?? line.pct ?? 0);
                const qtyKgPerBatch = (batchSizeKg * pct) / 100;
                const totalQty = qtyKgPerBatch * batchesRequired;
                if (!(totalQty > 0)) continue;
                let rmId = line.raw_material_id != null ? Number(line.raw_material_id) : null;
                if (!rmId && (line.rm_code || line.code)) {
                    const rm = await RawMaterial.findOne({ where: { code: line.rm_code || line.code }, transaction: t });
                    if (rm) rmId = rm.id;
                }
                rawMaterials.push({
                    raw_material_id: rmId || null,
                    name: line.inci_name ?? line.name ?? line.rm_code ?? '',
                    quantity: Math.round(totalQty * 1000) / 1000,
                    unit: (line.uom || 'KG').toUpperCase(),
                    code: line.rm_code ?? line.code ?? '',
                });
            }

            const packagingMaterials = [];
            for (const line of pmLines) {
                const qtyPerUnit = Number(line.qty_per_unit ?? line.qty ?? 1);
                const totalQty = Math.ceil(qtyUnits * qtyPerUnit);
                if (!(totalQty > 0)) continue;
                let pmId = line.pack_material_id != null ? Number(line.pack_material_id) : null;
                if (!pmId && (line.pm_code || line.code)) {
                    const pmCode = line.pm_code || line.code;
                    const pm = await PackMaterial.findOne({ where: { code: pmCode }, transaction: t });
                    if (pm) pmId = pm.id;
                }

                packagingMaterials.push({
                    pack_material_id: pmId || null,
                    name: line.description ?? line.name ?? line.pm_code ?? '',
                    quantity: totalQty,
                    unit: 'PCS',
                    code: line.pm_code ?? line.code ?? '',
                });
            }

            const leadTimeDaysForProduct = reorderProductIds.has(productId) ? defaultLeadTimeDaysReorder : defaultLeadTimeDaysNew;
            computedOrderLeadTimeDays = Math.max(computedOrderLeadTimeDays, leadTimeDaysForProduct);

            const planRow = await PlanningExtracted.create({
                sales_order_id: soRow.id,
                product_id: productId,
                order_qty_display: `${qtyUnits} units`,
                // Keep website->admin payload complete for planning cards/details.
                // KG conversion logic can be refined later; for now preserve current 1:1 display assumption.
                total_kg_display: `${qtyUnits} KG`,
                order_date: orderDateStr,
                due_date: null,
                batch_size_display: `${batchSizeKg} KG`,
                batches_required: batchesRequired,
                batch_count: 0,
                batch_size_kg: batchSizeKg,
                bom_status: bom ? 'Confirmed' : 'Pending',
                approved_by: createdByName,
                raw_materials: rawMaterials,
                packaging_materials: packagingMaterials,
                bom_confirmed_at: bom ? new Date() : null,
                created_at: new Date(),
                updated_at: new Date(),
            }, { transaction: t });

            // Reserve stock at planning-level when BOM is confirmed (creates reserved_batch_items and syncs warehouse reserved).
            if (bom) {
                for (const rm of rawMaterials) {
                    const rmId = rm.raw_material_id != null ? Number(rm.raw_material_id) : null;
                    if (!rmId) continue;
                    await ReservedBatchItem.create({
                        planning_extracted_id: planRow.id,
                        raw_material_id: rmId,
                        pack_material_id: null,
                        quantity_reserved: Number(rm.quantity) || 0,
                        unit: rm.unit || 'KG',
                        so_no: soNo,
                    }, { transaction: t });
                    affectedRmIds.add(rmId);
                }
                for (const pm of packagingMaterials) {
                    const pmId = pm.pack_material_id != null ? Number(pm.pack_material_id) : null;
                    if (!pmId) continue;
                    await ReservedBatchItem.create({
                        planning_extracted_id: planRow.id,
                        raw_material_id: null,
                        pack_material_id: pmId,
                        quantity_reserved: Number(pm.quantity) || 0,
                        unit: 'PCS',
                        so_no: soNo,
                    }, { transaction: t });
                    affectedPmIds.add(pmId);
                }
            }
        }

        if (affectedRmIds.size || affectedPmIds.size) {
            await syncWarehouseReserved([...affectedRmIds], [...affectedPmIds]);
        }

        const orderLeadTimeDays = computedOrderLeadTimeDays > 0 ? computedOrderLeadTimeDays : defaultLeadTimeDaysNew;
        const addDaysToDateOnly = (dateOnlyStr, days) => {
            const d = new Date(`${dateOnlyStr}T00:00:00Z`);
            d.setUTCDate(d.getUTCDate() + Number(days || 0));
            return d.toISOString().slice(0, 10);
        };
        const expectedShipmentDateStr = addDaysToDateOnly(orderDateStr, orderLeadTimeDays);

        // Populate due dates so "Due Date + Days left" in Planning SO details reflects lead time.
        await soRow.update({ expected_shipment_date: expectedShipmentDateStr }, { transaction: t });
        await ffOrder.update({ due_date: expectedShipmentDateStr }, { transaction: t });
        await PlanningExtracted.update(
            { due_date: expectedShipmentDateStr },
            { where: { sales_order_id: soRow.id }, transaction: t }
        );

        // Create one production batch + split per fulfillment item (simple default: 1 batch per item).
        // BMR/BPR numbers follow the existing format: BMR-YYYY-XXX / BPR-YYYY-XXX
        async function getNextBMRBPR() {
            const year = new Date().getFullYear();
            const prefix = `BMR-${year}-`;
            const rows = await ProductionBatch.findAll({
                where: { bmr_no: { [Op.like]: `${prefix}%` } },
                attributes: ['bmr_no'],
                transaction: t,
            });
            let maxNum = 0;
            for (const r of rows) {
                const d = r.get ? r.get({ plain: true }) : r;
                const num = parseInt(String(d.bmr_no || '').replace(prefix, ''), 10);
                if (!Number.isNaN(num) && num > maxNum) maxNum = num;
            }
            const next = String(maxNum + 1).padStart(3, '0');
            return { bmrNo: `${prefix}${next}`, bprNo: `BPR-${year}-${next}` };
        }

        let batchIndex = 0;
        for (const itemRow of createdItems) {
            batchIndex += 1;
            const plain = itemRow.get ? itemRow.get({ plain: true }) : itemRow;
            const { bmrNo, bprNo } = await getNextBMRBPR();
            const pb = await ProductionBatch.create({
                bmr_no: bmrNo,
                bpr_no: bprNo,
                product_name: plain.product_name || 'Unknown Product',
                sku: plain.sku || soNo,
                so_no: soNo,
                order_qty: plain.ordered_qty || 0,
                batch_size: plain.ordered_qty || 0,
                batch_no: `B-${String(batchIndex).padStart(2, '0')}`,
                batch_index: batchIndex,
                total_batches: createdItems.length,
                bmr_status: 'draft',
                bpr_status: 'draft',
                due_date: expectedShipmentDateStr,
            }, { transaction: t });

            await FulfillmentBatchSplit.create({
                fulfillment_order_item_id: plain.id,
                fulfillment_order_id: ffOrder.id,
                production_batch_id: pb.id,
                bmr_no: bmrNo,
                bpr_no: bprNo,
                planned_qty: plain.ordered_qty || 0,
                fg_qty: 0,
                fg_location: null,
                ff_status: 'fg_pending',
            }, { transaction: t });
        }

        // Create staged payment records for treasury/client tracking.
        const scheduleMeta = {
            advance_pct: advancePct,
            pre_shipment_pct: preShipmentPct,
            post_shipment_pct: postShipmentPct,
            credit_days: creditDays,
            cheque_details: payment_method === 'cheque' ? (cheque_details || null) : null,
        };
        if (advancePct > 0) {
            await Payment.create({
                orderOrderId: order.order_id,
                UserUserid: order.user_id,
                gateway: (payment_method === 'cheque' ? 'cheque' : 'razorpay'),
                gatewayReference: JSON.stringify({
                    kind: 'stage_due',
                    stage: 'advance',
                    ...scheduleMeta,
                }),
                paidAmount: 0,
                remainingAmount: advance_amount_due,
                currency: 'INR',
                status: 'pending',
            }, { transaction: t });
        }
        if (preShipmentPct > 0) {
            await Payment.create({
                orderOrderId: order.order_id,
                UserUserid: order.user_id,
                gateway: 'cod',
                gatewayReference: JSON.stringify({
                    kind: 'stage_due',
                    stage: 'pre_shipment',
                    ...scheduleMeta,
                }),
                paidAmount: 0,
                remainingAmount: preShipmentAmountDue,
                currency: 'INR',
                status: 'pending',
            }, { transaction: t });
        }
        if (postShipmentPct > 0) {
            await Payment.create({
                orderOrderId: order.order_id,
                UserUserid: order.user_id,
                gateway: 'cod',
                gatewayReference: JSON.stringify({
                    kind: 'stage_due',
                    stage: 'post_shipment',
                    ...scheduleMeta,
                }),
                paidAmount: 0,
                remainingAmount: postShipmentAmountDue,
                currency: 'INR',
                status: 'pending',
            }, { transaction: t });
        }
        await t.commit();

        const result = await Order.findByPk(order.order_id, { include: [OrderItem] });
        const resultPlain = result?.get ? result.get({ plain: true }) : result;
        return res.status(201).json({
            ...(resultPlain || {}),
            lead_time_days: orderLeadTimeDays,
            expected_shipment_date: expectedShipmentDateStr,
            due_date: expectedShipmentDateStr,
            payment_terms: {
                advance_pct: advancePct,
                pre_shipment_pct: preShipmentPct,
                post_shipment_pct: postShipmentPct,
                credit_days: creditDays,
            },
        });
    } catch (err) {
        await t.rollback();
        return res.status(400).json({ error: err.message });
    }
};

// Admin roles that can see all orders; others see only their own
const ORDER_ADMIN_ROLES = ['super_admin', 'admin', 'bd_manager'];

function parseGatewayRefJSON(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(String(value)); } catch { return null; }
}

function attachPaymentSchedule(orderPlain) {
    const payments = Array.isArray(orderPlain?.payments) ? orderPlain.payments : [];
    const stageRows = payments
        .map((p) => ({ p, meta: parseGatewayRefJSON(p.gatewayReference) }))
        .filter(({ meta }) => meta && meta.kind === 'stage_due');
    const byStage = {};
    for (const { p, meta } of stageRows) {
        byStage[meta.stage] = p;
    }
    const getPct = (key, fallback = 0) => {
        const first = stageRows[0]?.meta;
        const n = first ? Number(first[key]) : NaN;
        return Number.isFinite(n) ? n : fallback;
    };
    const creditDaysRaw = stageRows[0]?.meta?.credit_days;
    const creditDays = Number.isFinite(Number(creditDaysRaw)) ? Number(creditDaysRaw) : null;

    const dueDateRaw = orderPlain?.due_date || orderPlain?.expected_shipment_date || null;
    let postShipmentDueDate = null;
    let postShipmentDaysLeft = null;
    if (dueDateRaw && creditDays != null) {
        const d = new Date(dueDateRaw);
        if (!Number.isNaN(d.getTime())) {
            d.setDate(d.getDate() + creditDays);
            postShipmentDueDate = d.toISOString().slice(0, 10);
            const now = new Date();
            now.setHours(0, 0, 0, 0);
            const target = new Date(postShipmentDueDate);
            postShipmentDaysLeft = Math.ceil((target - now) / (1000 * 60 * 60 * 24));
        }
    }

    orderPlain.payment_schedule = {
        advance_pct: getPct('advance_pct', Number(orderPlain?.advance_amount_due) > 0 ? 100 : 0),
        pre_shipment_pct: getPct('pre_shipment_pct', 0),
        post_shipment_pct: getPct('post_shipment_pct', 0),
        credit_days: creditDays,
        advance_amount_due: Number(byStage.advance?.remainingAmount ?? orderPlain?.advance_amount_due ?? 0),
        pre_shipment_amount_due: Number(byStage.pre_shipment?.remainingAmount ?? 0),
        post_shipment_amount_due: Number(byStage.post_shipment?.remainingAmount ?? 0),
        post_shipment_due_date: postShipmentDueDate,
        post_shipment_days_left: postShipmentDaysLeft,
    };
    return orderPlain;
}

const getAllOrders = async (req, res) => {
    try {
        const userId = Number(req.user?.id);
        const isAdmin = req.user && ORDER_ADMIN_ROLES.includes(req.user.role);
        const { status } = req.query;

        const where = isAdmin ? {} : { user_id: userId };
        if (status) {
            where.order_status = status;
        }

        const orders = await Order.findAll({
            where,
            include: [
                OrderItem,
                { model: Payment, as: 'payments', required: false, attributes: ['remainingAmount', 'gatewayReference', 'gateway', 'status', 'paidAmount'] },
            ],
        });

        const { FulfillmentOrder } = require('../fulfillment/models');
        const soNos = (orders || [])
            .map((o) => (o?.so_no != null ? String(o.so_no) : null))
            .filter((x) => x && x.trim());

        const dueBySoNo = new Map();
        if (soNos.length) {
            const fulfillmentRows = await FulfillmentOrder.findAll({
                where: { so_no: { [Op.in]: soNos } },
                attributes: ['so_no', 'due_date'],
                raw: true,
            });
            for (const r of fulfillmentRows) {
                const key = r.so_no;
                dueBySoNo.set(String(key), r.due_date ?? null);
            }
        }

        const enriched = (orders || []).map((o) => {
            const plain = o?.get ? o.get({ plain: true }) : o;
            const due = plain?.so_no ? dueBySoNo.get(String(plain.so_no)) ?? null : null;
            plain.expected_shipment_date = due;
            plain.due_date = due;
            return attachPaymentSchedule(plain);
        });

        return res.json(enriched);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
const getOrderById = async (req, res) => {
    try {
        const order = await Order.findByPk(req.params.id, {
            include: [
                OrderItem,
                { model: Payment, as: 'payments', required: false, attributes: ['remainingAmount', 'gatewayReference', 'gateway', 'status', 'paidAmount'] },
            ],
        });
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const isAdmin = req.user && ORDER_ADMIN_ROLES.includes(req.user.role);
        if (!isAdmin && order.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Not allowed to view this order' });
        }
        const { FulfillmentOrder } = require('../fulfillment/models');
        const plain = order?.get ? order.get({ plain: true }) : order;
        const soNo = plain?.so_no ? String(plain.so_no) : null;
        let due = null;
        if (soNo) {
            const f = await FulfillmentOrder.findOne({
                where: { so_no: soNo },
                attributes: ['due_date'],
                raw: true,
            });
            due = f?.due_date ?? null;
        }
        plain.expected_shipment_date = due;
        plain.due_date = due;
        res.json(attachPaymentSchedule(plain));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const updateOrder = async (req, res) => {
    try {
        // const { error } = updateOrderSchema.validate(req.body, { abortEarly: false });
        // if (error) {
        //     return res.status(400).json({ errors: error.details.map(e => e.message) });
        // };
        const order = await Order.findByPk(req.params.id);
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const isAdmin = req.user && ORDER_ADMIN_ROLES.includes(req.user.role);
        if (!isAdmin && order.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Not allowed to update this order' });
        }
        const previousStatus = order.order_status;
        await order.update(req.body);


        res.status(200).json(order);
    } catch (err) {
        console.log(err);
        res.status(500).json({ error: err.message });
    }
};

const deleteOrder = async (req, res) => {
    try {
        const order = await Order.findByPk(req.params.id);
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const isAdmin = req.user && ORDER_ADMIN_ROLES.includes(req.user.role);
        if (!isAdmin && order.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Not allowed to delete this order' });
        }
        await order.destroy();
        res.json({ message: 'Order deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const getOrderStatus = async (req, res) => {
    try {
        const order = await Order.findByPk(req.params.id);
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const isAdmin = req.user && ORDER_ADMIN_ROLES.includes(req.user.role);
        if (!isAdmin && order.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Not allowed to view this order' });
        }
        res.json({ id: order.order_id, status: order.order_status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const getOrdersByUserId = async (req, res) => {
    try {
        const requestedUserId = Number(req.params.userId);
        const isAdmin = req.user && ORDER_ADMIN_ROLES.includes(req.user.role);
        if (!isAdmin && req.user?.id !== requestedUserId) {
            return res.status(403).json({ error: 'Not allowed to view orders for this user' });
        }
        const orders = await Order.findAll({
            where: { user_id: requestedUserId },
            include: [
                OrderItem,
                { model: Payment, as: 'payments', required: false, attributes: ['remainingAmount', 'gatewayReference', 'gateway', 'status', 'paidAmount'] },
            ],
        });

        const { FulfillmentOrder } = require('../fulfillment/models');
        const soNos = (orders || [])
            .map((o) => (o?.so_no != null ? String(o.so_no) : null))
            .filter((x) => x && x.trim());

        const dueBySoNo = new Map();
        if (soNos.length) {
            const fulfillmentRows = await FulfillmentOrder.findAll({
                where: { so_no: { [Op.in]: soNos } },
                attributes: ['so_no', 'due_date'],
                raw: true,
            });
            for (const r of fulfillmentRows) {
                const key = r.so_no;
                dueBySoNo.set(String(key), r.due_date ?? null);
            }
        }

        const enriched = (orders || []).map((o) => {
            const plain = o?.get ? o.get({ plain: true }) : o;
            const due = plain?.so_no ? dueBySoNo.get(String(plain.so_no)) ?? null : null;
            plain.expected_shipment_date = due;
            plain.due_date = due;
            return attachPaymentSchedule(plain);
        });

        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};



module.exports = {
    saveOrder,
    getAllOrders,
    getOrderById,
    getOrdersByUserId,
    updateOrder,
    deleteOrder,
    getOrderStatus,
};
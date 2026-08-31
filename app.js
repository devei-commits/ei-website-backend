const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('./db');
const orderRouters = require('./src/orders/routers');
const userRouters = require('./src/users/routers');
const rolesRouters = require('./src/roles/routers');
const productRouters = require('./src/products/routers');
const paymentRouters = require('./src/payments/routers');
const otpRouters = require('./src/otp/routers');
const appointmentRouters = require('./src/appointments/routers');
const newdevelopmentsRouters = require('./src/newdevelopments/routers');
const customizationRouters = require('./src/customizations/routers');
const productCustomizationRouters = require('./src/productCustomizations/routers');
const enquiryRouters = require('./src/enquiries/routers');
const packagingRouters = require('./src/packaging/routers');
const packMaterialsRouters = require('./src/packMaterials/routers');
const rawMaterialsRouters = require('./src/rawMaterials/routers');
const masterAttachmentsRouters = require('./src/masterAttachments/routers');
const qualitySpecRulesRouters = require('./src/qualitySpecRules/routers');
const technicalSpecRulesRouters = require('./src/technicalSpecRules/routers');
const bomRouters = require('./src/bom/routers');
const itemsMasterRouters = require('./src/itemsMaster/routers');
const vendorClientRouters = require('./src/vendorClient/routers');
const salesOrdersRouters = require('./src/salesOrders/routers');
const purchaseOrdersRouters = require('./src/purchaseOrders/routers');
const universalSwapRouters = require('./src/universalSwap/routers');
const itemGroupsRouters = require('./src/itemGroups/routers');
const warehouseInventoryRouters = require('./src/warehouseInventory/routers');
const warehouseLocationsRouters = require('./src/warehouseLocations/routers');
const warehouseRouters = require('./src/warehouse/routers');
const grnRouters = require('./src/grn/routers');
const mrnRouters = require('./src/mrn/routers');
const logisticsSchedulesRouters = require('./src/logisticsSchedules/routers');
const itemsListRouters = require('./src/itemsList/routers');
const planningExtractedRouters = require('./src/planningExtracted/routers');
const procurementRequestsRouters = require('./src/procurementRequests/routers');
const procurementQuotationsRouters = require('./src/procurementQuotations/routers');
const planningQuotationAsksRouters = require('./src/planningQuotationAsks/routers');
const poTrackingRouters = require('./src/poTracking/routers');
const treasuryRouters = require('./src/treasury/routers');
const productionRouters = require('./src/production/routers');
const facilityAreasRouters = require('./src/facilityAreas/routers');
const departmentsRouters = require('./src/departments/routers');
const fulfillmentRouters = require('./src/fulfillment/routers');
const clientHubRouters = require('./src/clientHub/routers');
const bdRouters = require('./src/bd/routers');
const dashboardRouters = require('./src/dashboard/routers');
const errorHandler = require('./src/middleware/error_handler');
const logginHandler = require('./src/middleware/logging')
const { isAuthenticated, authorizeRoles } = require('./src/middleware/security')
const { cacheInvalidationMiddleware } = require('./src/cache/cacheInvalidationMiddleware');
const dotenv = require('dotenv');
const cors = require('cors');
dotenv.config();

require('./src/leadTime/leadTimeStatModel'); // §10 lead-time stats cache
// Schema is patch-driven: all prior `ensure*` column/table patches are already applied to
// the live DB and have been removed. The only remaining boot schema step is a one-time
// cleanup of the duplicate UNIQUE constraints that db.sync({alter}) accumulated.
const { dropDuplicateConstraints } = require('./src/db/dropDuplicateConstraints');
const { ensureReservedBatchItemPlanningColumns } = require('./src/db/ensureReservedBatchItemPlanningColumns');
const { ensureReservedBatchItemRequestedColumn } = require('./src/db/ensureReservedBatchItemRequestedColumn');
const { ensureQualitySpecRuleItemScope } = require('./src/db/ensureQualitySpecRuleItemScope');
const { ensurePlanningBatchBomConfirmedColumn } = require('./src/db/ensurePlanningBatchBomConfirmedColumn');
const { ensurePlanningExtractedCommittedDateColumn } = require('./src/db/ensurePlanningExtractedCommittedDateColumn');
const { ensureItemListTierSourceAskColumn } = require('./src/db/ensureItemListTierSourceAskColumn');
const { ensureFulfillmentOrderItemTaxColumns } = require('./src/db/ensureFulfillmentOrderItemTaxColumns');
const { ensureVendorBatchSequenceTable } = require('./src/db/ensureVendorBatchSequenceTable');
const { ensureGrnGeneratedPackLabelsColumn } = require('./src/db/ensureGrnGeneratedPackLabelsColumn');
const warehousePacksRouters = require('./src/warehousePacks/routers');
require('./src/customizationPackaging/models');
const customizationPackagingAdminRouter = require('./src/customizationPackaging/routers');
const { listPublicCustomizationPackaging } = require('./src/customizationPackaging/controller');
const { ensureCustomizationPackagingPresets } = require('./src/customizationPackaging/ensureCustomizationPackagingPresets');
require('./src/quotations/models');
const { seedQuotationDefaults } = require('./src/quotations/seedQuotationDefaults');
const quotationRouters = require('./src/quotations/routers');
const { ensureTreasuryDefaults } = require('./src/treasury/ensureTreasuryDefaults');

const app = express();
const port = process.env.PORT || 3000;

/** Comma-separated extra origins (e.g. custom domains). Merged with defaults below. */
function parseExtraCorsOrigins() {
    const raw = process.env.CORS_ALLOWED_ORIGINS;
    if (!raw || !String(raw).trim()) return [];
    return String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/** Vite defaults: public site often :5173; EI-Admin uses :5174 (see EI-Admin/vite.config.ts). */
const defaultCorsOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5174',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://esthetic-insights-website.vercel.app',
    'https://ei-admin.vercel.app',
];

const allowedOrigins = [...new Set([...defaultCorsOrigins, ...parseExtraCorsOrigins()])];

/**
 * Vercel preview URLs (e.g. ei-admin-git-main-xxx.vercel.app) — production hostnames are exact matches.
 */
function isOurVercelOrigin(origin) {
    try {
        const { protocol, hostname } = new URL(origin);
        if (protocol !== 'https:') return false;
        if (!hostname.endsWith('.vercel.app')) return false;
        if (hostname === 'ei-admin.vercel.app' || hostname.startsWith('ei-admin-')) return true;
        if (hostname === 'esthetic-insights-website.vercel.app' || hostname.startsWith('esthetic-insights-website-')) {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

const corsOptions = {
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        if (isOurVercelOrigin(origin)) return callback(null, true);
        if (process.env.NODE_ENV === 'development') return callback(null, true);
        callback(null, false);
    },
    credentials: true,
};
app.use(cors(corsOptions));
// Raised from the 100kb default to accommodate inline (base64) receipt/dispatch photos
// stored in JSON columns (GRN sourceDocuments.receipt, MRN generated_labels).
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.json({ limit: '15mb' }));
app.use(cookieParser())
app.use(logginHandler);
app.use(cacheInvalidationMiddleware);

const apiPrefix = '/api/v1';

/** Authenticated API responses must not be cached by the browser (Redis handles server-side caching). */
app.use(apiPrefix, (_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    next();
});

const { mountSwagger } = require('./src/docs/swaggerSetup');
mountSwagger(app, { apiPrefix, port: Number(process.env.PORT) || 3000 });

app.get(`${apiPrefix}/health`, (req, res) => {
    res.json({ status: 'ok' });
});

/** Website customize flow — no auth (register before any `/customization-packaging-options` router that could capture `/public`). */
app.get(`${apiPrefix}/customization-packaging-options/public`, listPublicCustomizationPackaging);

app.use(`${apiPrefix}/users`, userRouters);
app.use(`${apiPrefix}/roles`, rolesRouters);
app.use(`${apiPrefix}/otp`, otpRouters);
app.use(`${apiPrefix}/orders`, isAuthenticated, orderRouters);
app.use(`${apiPrefix}/products`, isAuthenticated, productRouters);
app.use(`${apiPrefix}/payments`, isAuthenticated, paymentRouters);
app.use(`${apiPrefix}/appointments`, isAuthenticated, appointmentRouters);
app.use(`${apiPrefix}/newdevelopments`, isAuthenticated, newdevelopmentsRouters);
app.use(`${apiPrefix}/customizations`, isAuthenticated, customizationRouters);
app.use(`${apiPrefix}/productCustomizations`, isAuthenticated, productCustomizationRouters);
app.use(`${apiPrefix}/enquiries`, isAuthenticated, enquiryRouters);
app.use(`${apiPrefix}/packaging`, isAuthenticated, packagingRouters);
app.use(`${apiPrefix}/admin/customization-packaging-options`, customizationPackagingAdminRouter);
app.use(`${apiPrefix}/pack-materials`, isAuthenticated, packMaterialsRouters);
app.use(`${apiPrefix}/raw-materials`, isAuthenticated, rawMaterialsRouters);
app.use(`${apiPrefix}/master-attachments`, masterAttachmentsRouters);
app.use(`${apiPrefix}/quality-spec-rules`, isAuthenticated, qualitySpecRulesRouters);
app.use(`${apiPrefix}/technical-spec-rules`, isAuthenticated, technicalSpecRulesRouters);
app.use(`${apiPrefix}/bom`, isAuthenticated, bomRouters);
app.use(`${apiPrefix}/items-master`, isAuthenticated, itemsMasterRouters);
app.use(`${apiPrefix}/vendor-client`, isAuthenticated, vendorClientRouters);
app.use(`${apiPrefix}/sales-orders`, isAuthenticated, salesOrdersRouters);
app.use(`${apiPrefix}/purchase-orders`, isAuthenticated, purchaseOrdersRouters);
app.use(`${apiPrefix}/universal-swap`, isAuthenticated, universalSwapRouters);
app.use(`${apiPrefix}/item-groups`, isAuthenticated, itemGroupsRouters);
app.use(`${apiPrefix}/warehouse-inventory`, isAuthenticated, warehouseInventoryRouters);
app.use(`${apiPrefix}/warehouse-packs`, isAuthenticated, warehousePacksRouters);
app.use(`${apiPrefix}/warehouse-locations`, isAuthenticated, warehouseLocationsRouters);
app.use(`${apiPrefix}/warehouse`, isAuthenticated, warehouseRouters);
app.use(`${apiPrefix}/grn`, isAuthenticated, grnRouters);
app.use(`${apiPrefix}/mrn`, isAuthenticated, mrnRouters);
app.use(`${apiPrefix}/logistics-schedules`, isAuthenticated, logisticsSchedulesRouters);
app.use(`${apiPrefix}/items-list`, isAuthenticated, itemsListRouters);
app.use(`${apiPrefix}/planning-extracted`, isAuthenticated, planningExtractedRouters);
app.use(`${apiPrefix}/procurement`, isAuthenticated, procurementRequestsRouters);
app.use(`${apiPrefix}/procurement-quotations`, isAuthenticated, procurementQuotationsRouters);
app.use(`${apiPrefix}/planning-quotation-asks`, isAuthenticated, planningQuotationAsksRouters);
app.use(`${apiPrefix}/po-tracking`, isAuthenticated, poTrackingRouters);
app.use(`${apiPrefix}/treasury`, isAuthenticated, treasuryRouters);
app.use(`${apiPrefix}/production`, isAuthenticated, productionRouters);
app.use(`${apiPrefix}/facility-areas`, isAuthenticated, facilityAreasRouters);
app.use(`${apiPrefix}/departments`, departmentsRouters);
app.use(`${apiPrefix}/fulfillment`, isAuthenticated, fulfillmentRouters);
app.use(`${apiPrefix}/client-hub`, isAuthenticated, clientHubRouters);
app.use(`${apiPrefix}/bd`, isAuthenticated, bdRouters);
app.use(`${apiPrefix}/dashboard`, isAuthenticated, dashboardRouters);
app.use(`${apiPrefix}/quotes`, isAuthenticated, authorizeRoles('super_admin'), quotationRouters);

app.use(errorHandler);

app.use((req, res) => {
    res.status(404).send('Not Found');
});

// After all routers/models are loaded: GET reads exclude lifecycle_status = 'deleted'.
const { registerActiveReadScopes } = require('./src/lib/registerActiveReadScopes');
registerActiveReadScopes(db);

function isManagedProductionDatabase() {
    if (process.env.NODE_ENV === 'production') return true;
    const databaseUrl = process.env.DATABASE_URL || '';
    return databaseUrl.includes('rds.amazonaws.com');
}

function shouldRunSyncAlter() {
    const override = String(process.env.DB_SYNC_ALTER || '').toLowerCase();
    if (override === 'true' || override === '1') return true;
    if (override === 'false' || override === '0') return false;
    return !isManagedProductionDatabase();
}

if (process.env.NODE_ENV !== 'test') {
    // SKIP_DB_BOOTSTRAP=true → connect and serve ONLY; run no sync({alter}) and no seeders.
    // Use this when pointing a local/dev app at a database you must not mutate (e.g. production
    // over a tunnel). Default (unset/false) keeps normal dev boot behaviour (sync + seed).
    const skipDbBootstrap = String(process.env.SKIP_DB_BOOTSTRAP || '').toLowerCase() === 'true';
    // eslint-disable-next-line no-inner-declarations
    function scheduleLeadTimeStatsRecompute() {
        const { recomputeAllLeadTimeStats } = require('./src/leadTime/recompute');
        const run = () =>
            Promise.resolve(recomputeAllLeadTimeStats())
                .then((r) => {
                    if (r && r.upserts) console.log(`[lead-time] recomputed ${r.upserts} item/vendor lead stats`);
                })
                .catch((e) => console.warn('[lead-time] recompute failed:', e && e.message ? e.message : e));
        run(); // boot backfill
        const DAY_MS = 24 * 60 * 60 * 1000;
        const timer = setInterval(run, DAY_MS);
        if (timer.unref) timer.unref();
    }
    db.authenticate()
        .then(async () => {
            if (skipDbBootstrap) {
                console.log('[startup] SKIP_DB_BOOTSTRAP=true — skipping sync and seeders (read/serve only).');
            } else if (!isManagedProductionDatabase()) {
                // Schema is patch-driven now (no db.sync alter; prior ensure* patches removed —
                // all already applied to the live DB). Data seeders + the one-time dup-constraint
                // cleanup remain.
                await ensureCustomizationPackagingPresets();
                await seedQuotationDefaults();
                await ensureTreasuryDefaults();
                await dropDuplicateConstraints();
                await ensureReservedBatchItemPlanningColumns();
                await ensureReservedBatchItemRequestedColumn();
                await ensureQualitySpecRuleItemScope();
                await ensurePlanningBatchBomConfirmedColumn();
                await ensurePlanningExtractedCommittedDateColumn();
                await ensureItemListTierSourceAskColumn();
                await ensureFulfillmentOrderItemTaxColumns();
                await ensureVendorBatchSequenceTable();
                await ensureGrnGeneratedPackLabelsColumn();
            } else {
                await ensureTreasuryDefaults();
                await dropDuplicateConstraints();
                await ensureReservedBatchItemPlanningColumns();
                await ensureReservedBatchItemRequestedColumn();
                await ensureQualitySpecRuleItemScope();
                await ensurePlanningBatchBomConfirmedColumn();
                await ensurePlanningExtractedCommittedDateColumn();
                await ensureItemListTierSourceAskColumn();
                await ensureFulfillmentOrderItemTaxColumns();
                await ensureVendorBatchSequenceTable();
                await ensureGrnGeneratedPackLabelsColumn();
            }
            app.listen(port, '0.0.0.0', () => {
                console.log(`Server is running on port ${port}`);
            });
            if (!skipDbBootstrap) {
                // §10.4: keep the actual-from-history lead-time cache fresh — backfill on boot, then
                // nightly (also recomputed event-driven on each GRN completion).
                scheduleLeadTimeStatsRecompute();
            }
        })
        .catch((err) => {
            console.error('Failed to connect to the database', err);
            process.exit(1);
        });
}

module.exports = app;

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
const poTrackingRouters = require('./src/poTracking/routers');
const productionRouters = require('./src/production/routers');
const facilityAreasRouters = require('./src/facilityAreas/routers');
const itemDedicatedFacilityLocationsRouters = require('./src/itemDedicatedFacilityLocations/routers');
const departmentsRouters = require('./src/departments/routers');
const fulfillmentRouters = require('./src/fulfillment/routers');
const clientHubRouters = require('./src/clientHub/routers');
const errorHandler = require('./src/middleware/error_handler');
const logginHandler = require('./src/middleware/logging')
const { isAuthenticated } = require('./src/middleware/security')
const { cacheInvalidationMiddleware } = require('./src/cache/cacheInvalidationMiddleware');
const dotenv = require('dotenv');
const cors = require('cors');
dotenv.config();

require('./src/customizationPackaging/models');
const customizationPackagingAdminRouter = require('./src/customizationPackaging/routers');
const { listPublicCustomizationPackaging } = require('./src/customizationPackaging/controller');
const { ensureCustomizationPackagingPresets } = require('./src/customizationPackaging/ensureCustomizationPackagingPresets');

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
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser())
app.use(logginHandler);
app.use(cacheInvalidationMiddleware);

const apiPrefix = '/api/v1';

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
app.use(`${apiPrefix}/appointments`,isAuthenticated, appointmentRouters);
app.use(`${apiPrefix}/newdevelopments`,isAuthenticated, newdevelopmentsRouters);
app.use(`${apiPrefix}/customizations`, isAuthenticated, customizationRouters);
app.use(`${apiPrefix}/productCustomizations`, isAuthenticated, productCustomizationRouters);
app.use(`${apiPrefix}/enquiries`, isAuthenticated, enquiryRouters);
app.use(`${apiPrefix}/packaging`, isAuthenticated, packagingRouters);
app.use(`${apiPrefix}/admin/customization-packaging-options`, customizationPackagingAdminRouter);
app.use(`${apiPrefix}/pack-materials`, isAuthenticated, packMaterialsRouters);
app.use(`${apiPrefix}/raw-materials`, isAuthenticated, rawMaterialsRouters);
app.use(`${apiPrefix}/bom`, isAuthenticated, bomRouters);
app.use(`${apiPrefix}/items-master`, isAuthenticated, itemsMasterRouters);
app.use(`${apiPrefix}/vendor-client`, isAuthenticated, vendorClientRouters);
app.use(`${apiPrefix}/sales-orders`, isAuthenticated, salesOrdersRouters);
app.use(`${apiPrefix}/purchase-orders`, isAuthenticated, purchaseOrdersRouters);
app.use(`${apiPrefix}/universal-swap`, isAuthenticated, universalSwapRouters);
app.use(`${apiPrefix}/item-groups`, isAuthenticated, itemGroupsRouters);
app.use(`${apiPrefix}/warehouse-inventory`, isAuthenticated, warehouseInventoryRouters);
app.use(`${apiPrefix}/warehouse-locations`, isAuthenticated, warehouseLocationsRouters);
app.use(`${apiPrefix}/warehouse`, isAuthenticated, warehouseRouters);
app.use(`${apiPrefix}/grn`, isAuthenticated, grnRouters);
app.use(`${apiPrefix}/mrn`, isAuthenticated, mrnRouters);
app.use(`${apiPrefix}/logistics-schedules`, isAuthenticated, logisticsSchedulesRouters);
app.use(`${apiPrefix}/items-list`, isAuthenticated, itemsListRouters);
app.use(`${apiPrefix}/planning-extracted`, isAuthenticated, planningExtractedRouters);
app.use(`${apiPrefix}/procurement`, isAuthenticated, procurementRequestsRouters);
app.use(`${apiPrefix}/procurement-quotations`, isAuthenticated, procurementQuotationsRouters);
app.use(`${apiPrefix}/po-tracking`, isAuthenticated, poTrackingRouters);
app.use(`${apiPrefix}/production`, isAuthenticated, productionRouters);
app.use(`${apiPrefix}/facility-areas`, isAuthenticated, facilityAreasRouters);
app.use(`${apiPrefix}/item-dedicated-facility-locations`, itemDedicatedFacilityLocationsRouters);
app.use(`${apiPrefix}/departments`, departmentsRouters);
app.use(`${apiPrefix}/fulfillment`, isAuthenticated, fulfillmentRouters);
app.use(`${apiPrefix}/client-hub`, isAuthenticated, clientHubRouters);

app.use(errorHandler);

app.use((req, res) => {
    res.status(404).send('Not Found');
});

if (process.env.NODE_ENV !== 'test') {
  db.authenticate()
    .then(async () => {
      await db.sync({ alter: true });
      await ensureCustomizationPackagingPresets();
      app.listen(port, () => {
        console.log(`Server is running on port ${port}`);
      });
    })
    .catch((err) => {
      console.error('Failed to connect to the database', err);
      process.exit(1);
    });
}

module.exports = app;

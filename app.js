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
const errorHandler = require('./src/middleware/error_handler');
const logginHandler = require('./src/middleware/logging')
const { isAuthenticated } = require('./src/middleware/security')
const dotenv = require('dotenv');
const cors = require('cors');
dotenv.config();


const app = express();
const port = process.env.PORT || 3000;

// Middleware
const allowedOrigins = [
    'http://localhost:5173',
    'https://esthetic-insights-website.vercel.app',
];
const corsOptions = {
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        return callback(null, true); // Allow all origins for development
    },
    credentials: true,
};
app.use(cors(corsOptions));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser())
app.use(logginHandler);

const apiPrefix = '/api/v1';

app.get(`${apiPrefix}/health`, (req, res) => {
    res.json({ status: 'ok' });
});

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
app.use(`${apiPrefix}/pack-materials`, isAuthenticated, packMaterialsRouters);
app.use(`${apiPrefix}/raw-materials`, isAuthenticated, rawMaterialsRouters);
app.use(`${apiPrefix}/bom`, isAuthenticated, bomRouters);

app.use(errorHandler);

app.use((req, res) => {
    res.status(404).send('Not Found');
});

db.authenticate().then(async () => {
    // Database will be synced by seed.js before the server starts
    app.listen(port, () => {
        console.log(`Server is running on port ${port}`);
    });
}).catch(err => {
    console.error('Failed to connect to the database', err);
    process.exit(1);
});

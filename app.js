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
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) return callback(null, true);
        if (origin.endsWith('.vercel.app')) return callback(null, true);
        callback(new Error('Not allowed by CORS'));
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

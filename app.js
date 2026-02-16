const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('./db');
const orderRouters = require('./src/orders/routers');
const userRouters = require('./src/users/routers');
const productRouters = require('./src/products/routers');
const paymentRouters = require('./src/payments/routers');
const errorHandler = require('./src/middleware/error_handler');
const logginHandler = require('./src/middleware/logging')
const { isAuthenticated } = require('./src/middleware/security')

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser())
app.use(logginHandler);

const apiPrefix = '/api/v1';

app.get(`${apiPrefix}/health`, (req, res) => {
    res.json({ status: 'ok' });
});

app.use(`${apiPrefix}/users`, userRouters);
app.use(`${apiPrefix}/orders`, isAuthenticated, orderRouters);
app.use(`${apiPrefix}/products`, isAuthenticated, productRouters);
app.use(`${apiPrefix}/payments`, isAuthenticated, paymentRouters);

app.use(errorHandler);

app.use((req, res) => {
    res.status(404).send('Not Found');
});

db.authenticate().then(async () => {

    //@comment: Auto sync the database based on models
    await db.sync({alter: true}).then(() => {
        console.log('Database is synced');
    }).catch(err => {
        console.error('Failed to sync the database', err);
    });
    app.listen(port, () => {
        console.log(`Server is running on port ${port}`);
    });
}).catch(err => {
    console.error('Failed to connect to the database', err);
});

const { Sequelize } = require('sequelize');
const dotenv = require('dotenv');
dotenv.config();

// Handle both Railway (which provides DATABASE_URL) and local Docker (which builds it)
let databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  // Fallback for local development when DATABASE_URL is not provided
  const user = process.env.POSTGRES_USER || 'orders_user';
  const password = process.env.POSTGRES_PASSWORD || 'orders_password';
  const host = process.env.POSTGRES_HOST || 'db';
  const port = process.env.POSTGRES_PORT || '5432';
  const dbName = process.env.POSTGRES_DB || 'orders_db';
  databaseUrl = `postgres://${user}:${password}@${host}:${port}/${dbName}`;
}

console.log('Connecting to database...');
const db = new Sequelize(databaseUrl, {
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000
  },
  // Connection retry settings
  retry: {
    max: 5,
    match: [/SequelizeConnectionError/, /SequelizeConnectionRefusedError/, /SequelizeHostNotFoundError/, /SequelizeInvalidConnectionError/, /SequelizeConnectionTimedOutError/],
  },
  logging: process.env.NODE_ENV === 'development' ? console.log : false,
});

// Test connection with retry logic
let connectionAttempts = 0;
const maxConnectionAttempts = 15;  // Increased for Railway's boot time
const connectionRetryInterval = 2000; // 2 seconds

const waitForConnection = async () => {
  while (connectionAttempts < maxConnectionAttempts) {
    try {
      await db.authenticate();
      console.log('✓ Database connection established successfully');
      return;
    } catch (error) {
      connectionAttempts++;
      console.error(`Database connection attempt ${connectionAttempts}/${maxConnectionAttempts} failed:`, error.message);

      if (connectionAttempts >= maxConnectionAttempts) {
        console.error('Failed to connect to database after', maxConnectionAttempts, 'attempts');
        process.exit(1);
      }

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, connectionRetryInterval));
    }
  }
};

// Initialize connection attempt
waitForConnection().catch(err => {
  console.error('Fatal database connection error:', err);
  process.exit(1);
});

module.exports = db;

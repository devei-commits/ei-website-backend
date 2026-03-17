module.exports = {
  testEnvironment: 'node',
  testTimeout: 10000,
  testMatch: ['**/test/**/*.test.js'],
  // Integration tests use the same DB and db.sync({ force: true }); run serially to avoid conflicts.
  maxWorkers: 1,
};

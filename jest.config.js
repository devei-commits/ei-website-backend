module.exports = {
  testEnvironment: 'node',
  testTimeout: 10000,
  testMatch: ['**/test/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', 'planningBatchEditLock\\.test\\.js$'],
  // Integration tests share the dev DB; run serially to avoid conflicts.
  maxWorkers: 1,
};

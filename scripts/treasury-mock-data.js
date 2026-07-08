/**
 * Treasury mock-data CLI (thin wrapper over src/treasury/mockData.js).
 *
 *   node scripts/treasury-mock-data.js --seed    → wipe + fill demo dataset
 *   node scripts/treasury-mock-data.js --reset   → wipe ALL treasury data + mock clients; balances → 0
 *
 * npm run treasury:mock         (= --seed)
 * npm run treasury:mock:reset   (= --reset)
 *
 * The same logic is exposed to the UI via POST /api/v1/treasury/dev/seed-mock | reset-mock.
 */
const db = require('../db');
const { seedMock, resetMock } = require('../src/treasury/mockData');

(async () => {
  const mode = process.argv.includes('--reset') ? 'reset' : process.argv.includes('--seed') ? 'seed' : null;
  if (!mode) { console.error('Usage: node scripts/treasury-mock-data.js --seed | --reset'); process.exit(2); }
  let code = 0;
  try {
    await db.authenticate();
    if (mode === 'reset') {
      const r = await resetMock();
      console.log('[treasury-mock] reset done. Bank balances → 0.', JSON.stringify(r));
    } else {
      const r = await seedMock();
      console.log('[treasury-mock] seed done:', JSON.stringify(r));
      console.log('[treasury-mock] balances: HDFC ₹62L · SBI ₹18L · ICICI ₹4.2L');
    }
  } catch (e) {
    console.error('[treasury-mock] error:', e && e.stack ? e.stack : e);
    code = 1;
  } finally {
    await db.close().catch(() => {});
  }
  process.exit(code);
})();

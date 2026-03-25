#!/usr/bin/env node
/**
 * Check Zoho env + OAuth refresh (no contact created).
 *   node scripts/debug-zoho-env.js
 *   docker compose exec app node scripts/debug-zoho-env.js
 */
require('dotenv').config();

async function main() {
  const enabled = process.env.ZOHO_BOOKS_ENABLED === 'true';
  const org = process.env.ZOHO_BOOKS_ORGANIZATION_ID;
  const cur = process.env.ZOHO_DEFAULT_CURRENCY_ID;
  const hasOAuth = !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN);

  console.log('ZOHO_BOOKS_ENABLED:', process.env.ZOHO_BOOKS_ENABLED, '→', enabled);
  console.log('ZOHO_BOOKS_ORGANIZATION_ID:', org ? 'set' : '(missing)');
  console.log('ZOHO_DEFAULT_CURRENCY_ID:', cur ? 'set' : '(missing)');
  console.log('OAuth (client + secret + refresh):', hasOAuth ? 'set' : '(missing)');

  if (!enabled) {
    console.error('\n→ Set ZOHO_BOOKS_ENABLED=true and restart the app.');
    process.exit(1);
  }
  if (!hasOAuth || !org || !cur) {
    console.error('\n→ Fill Zoho OAuth + org + currency in .env.');
    process.exit(1);
  }

  try {
    const { getAccessToken } = require('../src/services/zohoBooks');
    const token = await getAccessToken();
    console.log('\nOAuth refresh: OK (got access_token, length', token.length, ')');
    console.log('If user create still fails, check POST /users/create response body: zoho_sync.error');
  } catch (e) {
    console.error('\nOAuth refresh: FAILED —', e.message);
    process.exit(1);
  }
}

main();

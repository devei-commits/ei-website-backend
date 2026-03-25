#!/usr/bin/env node
/**
 * Print currency_id + code for your Zoho Books org. Set ZOHO_DEFAULT_CURRENCY_ID to one of these.
 *   docker compose exec app node scripts/list-zoho-currencies.js
 */
require('dotenv').config();

async function main() {
  const { listCurrencies } = require('../src/services/zohoBooks');
  const { currencies, raw } = await listCurrencies();
  if (!currencies.length) {
    console.log('No currencies in response. Raw:', JSON.stringify(raw).slice(0, 800));
    return;
  }
  console.log('Use one of these for ZOHO_DEFAULT_CURRENCY_ID (and items/invoices):\n');
  currencies.forEach((c) => {
    const id = c.currency_id != null ? c.currency_id : c.currencyId;
    const code = c.currency_code || c.currencyCode || '';
    const name = c.currency_name || c.currencyName || '';
    const base = c.is_base_currency ? ' (base)' : '';
    console.log(`  ${id}\t${code}\t${name}${base}`);
  });
}

main().catch((e) => {
  console.error(e.message);
  if (e.zohoRaw) console.error(JSON.stringify(e.zohoRaw).slice(0, 600));
  process.exit(1);
});

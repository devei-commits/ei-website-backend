'use strict';

const db = require('../../db');

/**
 * Idempotently ensure the `technical_spec_rules` table exists.
 *
 * Dev auto-creates it via db.sync({ alter: true }); managed production SKIPS sync, so this
 * CREATE TABLE IF NOT EXISTS on boot keeps them converged with no manual migration.
 * Column set mirrors src/technicalSpecRules/models.js.
 */
async function ensureTechnicalSpecRulesTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS technical_spec_rules (
        id               SERIAL PRIMARY KEY,
        entity_type      VARCHAR(20) NOT NULL,
        category         VARCHAR(150) NOT NULL,
        sub_category     VARCHAR(150) NOT NULL DEFAULT '',
        sub_sub_category VARCHAR(150) NOT NULL DEFAULT '',
        rows             JSON,
        created_at       TIMESTAMPTZ,
        updated_at       TIMESTAMPTZ
      );
    `);
    // One rule per (entity_type, category, sub_category, sub_sub_category) scope.
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS technical_spec_rules_scope_uniq
         ON technical_spec_rules (entity_type, category, sub_category, sub_sub_category);`
    );
    return { ensured: true };
  } catch (err) {
    console.warn('[technical-spec-rules] ensureTechnicalSpecRulesTable failed:', err && err.message ? err.message : err);
    return { ensured: false };
  }
}

module.exports = { ensureTechnicalSpecRulesTable };

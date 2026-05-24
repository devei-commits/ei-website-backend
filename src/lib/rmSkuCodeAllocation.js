/**
 * RM internal SKU allocation: MAX suffix in SQL (Postgres), advisory lock, uniqueness check.
 */
const { QueryTypes } = require('sequelize');
const RawMaterial = require('../rawMaterials/models');
const { nextNumericSuffixAfterMax } = require('./nextNumericMasterCode');

const RM_DIGIT_SERIES_NUMERIC_SUFFIX_LEN = 6;
const RM_DIGIT_SERIES_LEGACY_NUMERIC_SUFFIX_LEN = 5;
const RM_CLUB_NUMERIC_SUFFIX_LEN = 5;
const CLUB_ITEMS_SKU_PREFIX = 'CLUB';
const RM_CODE_ALLOC_ADVISORY_KEY1 = 98273502;
const RM_CODE_ALLOC_ADVISORY_KEY2 = 1;
const RM_CODE_ALLOC_UNIQUE_ATTEMPTS = 100;

async function acquireRmCodeAllocationLock(sequelize, transaction) {
  const dialect = sequelize.getDialect && sequelize.getDialect();
  if (dialect === 'postgres') {
    await sequelize.query(
      `SELECT pg_advisory_xact_lock(${RM_CODE_ALLOC_ADVISORY_KEY1}, ${RM_CODE_ALLOC_ADVISORY_KEY2})`,
      { transaction }
    );
  }
}

async function rmCodeExists(code, { transaction }) {
  const n = await RawMaterial.count({
    where: { code: String(code || '').trim() },
    transaction,
  });
  return n > 0;
}

/**
 * Highest numeric suffix for digit-series codes (1/2/3 + 5 or 6 digits). Postgres uses MAX(); else scans rows.
 */
async function maxRmDigitSeriesNumericSuffix(digit, { transaction }) {
  const sequelize = RawMaterial.sequelize;
  const dialect = sequelize.getDialect && sequelize.getDialect();
  if (dialect === 'postgres') {
    const rows = await sequelize.query(
      `SELECT MAX(
         CASE
           WHEN code ~ :re6 THEN SUBSTRING(code FROM 2)::INTEGER
           WHEN code ~ :re5 THEN SUBSTRING(code FROM 2)::INTEGER
         END
       )::INTEGER AS max_suffix
       FROM raw_materials
       WHERE code LIKE :like`,
      {
        replacements: {
          re6: `^${digit}[0-9]{${RM_DIGIT_SERIES_NUMERIC_SUFFIX_LEN}}$`,
          re5: `^${digit}[0-9]{${RM_DIGIT_SERIES_LEGACY_NUMERIC_SUFFIX_LEN}}$`,
          like: `${digit}%`,
        },
        transaction,
        type: QueryTypes.SELECT,
      }
    );
    const n = rows[0]?.max_suffix;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  const { Op } = require('sequelize');
  const rows = await RawMaterial.findAll({
    attributes: ['code'],
    where: { code: { [Op.like]: `${digit}%` } },
    transaction,
  });
  let max = 0;
  for (const row of rows) {
    const n = parseRmDigitSeriesNumericSuffix(row.get ? row.get('code') : row.code, digit);
    if (n != null && Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/** Highest numeric suffix for CLUB##### codes. */
async function maxRmClubNumericSuffix({ transaction }) {
  const prefix = CLUB_ITEMS_SKU_PREFIX;
  const sequelize = RawMaterial.sequelize;
  const dialect = sequelize.getDialect && sequelize.getDialect();
  if (dialect === 'postgres') {
    const rows = await sequelize.query(
      `SELECT MAX(SUBSTRING(UPPER(code) FROM :fromPos)::INTEGER) AS max_suffix
       FROM raw_materials
       WHERE UPPER(code) ~ :re`,
      {
        replacements: {
          fromPos: prefix.length + 1,
          re: `^${prefix}[0-9]{${RM_CLUB_NUMERIC_SUFFIX_LEN}}$`,
        },
        transaction,
        type: QueryTypes.SELECT,
      }
    );
    const n = rows[0]?.max_suffix;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  const { Op } = require('sequelize');
  const rows = await RawMaterial.findAll({
    attributes: ['code'],
    where: { code: { [Op.iLike]: `${prefix}%` } },
    transaction,
  });
  const re = new RegExp(`^${prefix}(\\d{${RM_CLUB_NUMERIC_SUFFIX_LEN}})$`, 'i');
  let max = 0;
  for (const row of rows) {
    const m = String(row.get ? row.get('code') : row.code || '').match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max;
}

function parseRmDigitSeriesNumericSuffix(codeStr, digit) {
  const s = String(codeStr || '').trim();
  const m6 = s.match(new RegExp(`^${digit}(\\d{${RM_DIGIT_SERIES_NUMERIC_SUFFIX_LEN}})$`));
  if (m6) return parseInt(m6[1], 10);
  const m5 = s.match(
    new RegExp(`^${digit}(\\d{${RM_DIGIT_SERIES_LEGACY_NUMERIC_SUFFIX_LEN}})$`)
  );
  if (m5) return parseInt(m5[1], 10);
  return null;
}

async function allocateUniqueCodeFromMax(getMaxSuffix, buildCode, seriesPrefix, { transaction }) {
  const max = await getMaxSuffix({ transaction });
  let suffix = nextNumericSuffixAfterMax(max);
  for (let attempt = 0; attempt < RM_CODE_ALLOC_UNIQUE_ATTEMPTS; attempt += 1) {
    const code = buildCode(suffix);
    if (!(await rmCodeExists(code, { transaction }))) {
      return { code, seriesPrefix };
    }
    suffix += 1;
  }
  return { error: 'Unable to allocate a unique internal RM code. Try again.' };
}

module.exports = {
  RM_DIGIT_SERIES_NUMERIC_SUFFIX_LEN,
  RM_DIGIT_SERIES_LEGACY_NUMERIC_SUFFIX_LEN,
  RM_CLUB_NUMERIC_SUFFIX_LEN,
  CLUB_ITEMS_SKU_PREFIX,
  parseRmDigitSeriesNumericSuffix,
  acquireRmCodeAllocationLock,
  maxRmDigitSeriesNumericSuffix,
  maxRmClubNumericSuffix,
  allocateUniqueCodeFromMax,
};

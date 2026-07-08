/**
 * Shared Treasury helpers: sequential code generation, audit logging,
 * Indian FY quarter, and small coercion utilities.
 */
const { Op } = require('sequelize');
const db = require('../../db');
const { TreasuryAuditLog } = require('./models');

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round((num(n)) * 100) / 100;
const plain = (row) => (row && row.get ? row.get({ plain: true }) : row);

/** Calendar year of a date (defaults to now) — used in IN-YYYY-NNNN / OUT-YYYY-NNNN codes. */
function codeYear(dateLike) {
  const d = dateLike ? new Date(dateLike) : new Date();
  return (Number.isNaN(d.getTime()) ? new Date() : d).getUTCFullYear();
}

/**
 * Next sequential code for a model, e.g. nextSequentialCode(Model, 'inward_code', 'IN', 2026, 4)
 * → "IN-2026-0099". Scans existing codes with the matching prefix and increments the max.
 * Callers should wrap create() in retryOnUniqueViolation to survive rare races.
 */
async function nextSequentialCode(model, field, prefix, year, pad = 4, transaction) {
  const full = `${prefix}-${year}-`;
  const rows = await model.findAll({
    where: { [field]: { [Op.like]: `${full}%` } },
    attributes: [field],
    transaction,
    paranoid: false,
  });
  let max = 0;
  for (const r of rows) {
    const code = plain(r)[field] || '';
    const n = parseInt(String(code).slice(full.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${full}${String(max + 1).padStart(pad, '0')}`;
}

/** Retry a create/txn once on a unique-constraint collision (racing code generation). */
async function retryOnUniqueViolation(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const name = err && err.name;
      if (name === 'SequelizeUniqueConstraintError' && i < attempts - 1) continue;
      throw err;
    }
  }
  throw lastErr;
}

/** Write a treasury audit-log row. Never throws (audit failure must not break the action). */
async function writeAudit({ entityType, entityId, entityCode, action, req, details, transaction }) {
  try {
    await TreasuryAuditLog.create(
      {
        entity_type: entityType,
        entity_id: entityId ?? null,
        entity_code: entityCode ?? null,
        action,
        actor_id: req && req.user ? req.user.id : null,
        actor_name: req && req.user ? req.user.fullName : null,
        details: details || null,
      },
      { transaction }
    );
  } catch (e) {
    console.warn('[treasury] audit write failed:', e && e.message ? e.message : e);
  }
}

/**
 * Indian financial-year quarter for a date. FY runs Apr→Mar; label is the ENDING year.
 * e.g. 2026-07-08 → { quarter:'Q2', fyLabel:'FY27', code:'Q2 FY27' }
 */
function fyQuarter(dateLike) {
  const d = dateLike ? new Date(dateLike) : new Date();
  const base = Number.isNaN(d.getTime()) ? new Date() : d;
  const m = base.getUTCMonth(); // 0=Jan
  const y = base.getUTCFullYear();
  let quarter;
  let fyEnd;
  if (m >= 3 && m <= 5) { quarter = 'Q1'; fyEnd = y + 1; } // Apr-Jun
  else if (m >= 6 && m <= 8) { quarter = 'Q2'; fyEnd = y + 1; } // Jul-Sep
  else if (m >= 9 && m <= 11) { quarter = 'Q3'; fyEnd = y + 1; } // Oct-Dec
  else { quarter = 'Q4'; fyEnd = y; } // Jan-Mar
  const fyLabel = `FY${String(fyEnd).slice(-2)}`;
  return { quarter, fyLabel, code: `${quarter} ${fyLabel}` };
}

/** Advance a YYYY-MM-DD key by a recurring cadence. */
function nextCadenceDate(dateKey, cadence) {
  const d = new Date(`${String(dateKey).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateKey;
  const months = cadence === 'annual' ? 12 : cadence === 'quarterly' ? 3 : 1;
  const day = d.getUTCDate();
  d.setUTCDate(1); // avoid month-overflow (e.g. Jan 31 → Mar)
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

/** Whole-day difference newDate - baseDate (both YYYY-MM-DD or Date). */
function dayDiff(newDate, baseDate) {
  if (!newDate || !baseDate) return 0;
  const a = new Date(`${String(newDate).slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${String(baseDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.round((a - b) / 86_400_000);
}

module.exports = {
  db,
  num,
  round2,
  plain,
  codeYear,
  nextSequentialCode,
  retryOnUniqueViolation,
  writeAudit,
  fyQuarter,
  dayDiff,
  nextCadenceDate,
};

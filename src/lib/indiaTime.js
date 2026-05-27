/**
 * India (Asia/Kolkata) calendar and instant helpers for API + business logic.
 * Use backendNow() instead of DB NOW() / raw SQL timestamps for application events.
 */

const INDIA_TZ = 'Asia/Kolkata';

/** Current instant (UTC internally; compare with other Date values normally). */
function backendNow() {
  return new Date();
}

/** YYYY-MM-DD for "today" in India. */
function indiaDateOnlyString(date = backendNow()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: INDIA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Start of a calendar day in India as a UTC instant. */
function parseIndiaDateOnlyStart(dateOnly) {
  const m = String(dateOnly ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T00:00:00+05:30`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Serialize instants for API with explicit +05:30 offset (readable in India). */
function serializeInstantIndia(date) {
  if (date == null || date === '') return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: INDIA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+05:30`;
}

function addDaysToIndiaDateOnly(baseDateOnly, days) {
  const start = parseIndiaDateOnlyStart(String(baseDateOnly).slice(0, 10));
  if (!start) return '';
  const next = new Date(start.getTime() + (Number(days) || 0) * 86400000);
  return indiaDateOnlyString(next);
}

function daysLeftFromDueDateIndia(dueDateOnly) {
  if (!dueDateOnly) return '';
  const due = parseIndiaDateOnlyStart(String(dueDateOnly).slice(0, 10));
  const today = parseIndiaDateOnlyStart(indiaDateOnlyString());
  if (!due || !today) return '';
  const diff = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return 'Overdue';
  if (diff === 0) return 'Today';
  return `${diff} days`;
}

module.exports = {
  INDIA_TZ,
  backendNow,
  indiaDateOnlyString,
  parseIndiaDateOnlyStart,
  serializeInstantIndia,
  addDaysToIndiaDateOnly,
  daysLeftFromDueDateIndia,
};

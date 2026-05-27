const indiaTime = require('./indiaTime');
const { parseIndiaDateOnlyStart, serializeInstantIndia } = indiaTime;
const { parseDbDate } = require('./backendTimestamps');

/**
 * Parse timestamps for Planning SLA (India date-only + ISO instants).
 * @param {string|Date|null|undefined} raw
 * @returns {Date|null}
 */
function parsePlanningSlaTimestamp(raw) {
  if (raw == null) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;

  const s = String(raw).trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return parseIndiaDateOnlyStart(s);
  }

  const legacyUtcSpace = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (legacyUtcSpace) {
    const ts = Date.parse(
      `${legacyUtcSpace[1]}-${legacyUtcSpace[2]}-${legacyUtcSpace[3]}T${legacyUtcSpace[4]}:${legacyUtcSpace[5]}:${legacyUtcSpace[6]}Z`
    );
    return Number.isFinite(ts) ? new Date(ts) : null;
  }

  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * 48h planning SLA — clock starts when the row entered planning (created_at), not SO order_date.
 * @param {{ createdAt?: unknown, orderDate?: unknown, bomConfirmedAt?: unknown, remainingUnits?: number }} opts
 */
function computePlanningSlaMeta(opts) {
  const remainingUnits = Number(opts.remainingUnits) || 0;
  const start =
    parsePlanningSlaTimestamp(opts.createdAt) ??
    parseDbDate(opts.createdAt) ??
    parsePlanningSlaTimestamp(opts.orderDate) ??
    indiaTime.backendNow();

  const now = indiaTime.backendNow();
  let stopAt = now;
  if (remainingUnits <= 0) {
    const confirmedAt =
      parsePlanningSlaTimestamp(opts.bomConfirmedAt) ?? parseDbDate(opts.bomConfirmedAt) ?? null;
    stopAt = confirmedAt ?? now;
    if (stopAt.getTime() > now.getTime()) stopAt = now;
  }

  const elapsedHours = Math.max(0, (stopAt.getTime() - start.getTime()) / (1000 * 60 * 60));
  const hrs = Math.floor(elapsedHours);
  const mins = Math.floor((elapsedHours - hrs) * 60);
  const clock = `${hrs}h ${mins}m / 48h`;

  let label = clock;
  let sub = 'Running (< 36h)';
  let tone = 'green';

  if (remainingUnits <= 0) {
    label = `Completed ${clock}`;
    if (elapsedHours < 48) {
      sub = 'Completed on time';
      tone = 'green';
    } else {
      sub = 'Completed late';
      tone = 'red';
    }
  } else if (elapsedHours >= 48) {
    sub = `Breached by ${Math.max(0, Math.floor(elapsedHours - 48))}h`;
    tone = 'red';
  } else if (elapsedHours >= 36) {
    sub = 'Nearing breach (36–48h)';
    tone = 'amber';
  }

  return {
    elapsedHours,
    label,
    sub,
    tone,
    startedAt: serializeInstantIndia(start),
    stoppedAt: serializeInstantIndia(stopAt),
    timezone: 'Asia/Kolkata',
  };
}

module.exports = {
  parsePlanningSlaTimestamp,
  computePlanningSlaMeta,
};

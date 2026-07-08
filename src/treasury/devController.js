/**
 * Treasury dev/demo endpoints — populate/depopulate mock data from the UI.
 * Blocked in production. Backed by the shared src/treasury/mockData.js.
 */
const { Op } = require('sequelize');
const { seedMock, resetMock } = require('./mockData');
const { num, plain } = require('./helpers');
const { TreasuryGateOverride } = require('./models');

const isProd = () => String(process.env.NODE_ENV).toLowerCase() === 'production';

async function seedMockHandler(req, res) {
  if (isProd()) return res.status(403).json({ error: 'Mock data is disabled in production' });
  try {
    const counts = await seedMock();
    res.json({ ok: true, action: 'seed', counts });
  } catch (err) {
    console.error('[treasury] seedMockHandler error', err);
    res.status(500).json({ error: 'Failed to seed mock data' });
  }
}

async function resetMockHandler(req, res) {
  if (isProd()) return res.status(403).json({ error: 'Mock data is disabled in production' });
  try {
    const r = await resetMock();
    res.json({ ok: true, action: 'reset', ...r });
  } catch (err) {
    console.error('[treasury] resetMockHandler error', err);
    res.status(500).json({ error: 'Failed to reset mock data' });
  }
}

/** Cash-Risk report — logged cashflow-gate overrides. */
async function listGateOverrides(req, res) {
  try {
    const rows = await TreasuryGateOverride.findAll({ order: [['created_at', 'DESC']], limit: 500 });
    const data = rows.map((r) => {
      const d = plain(r);
      return {
        id: d.id, actionType: d.action_type, refType: d.ref_type, refId: d.ref_id, refCode: d.ref_code,
        projectedLowestBefore: num(d.projected_lowest_before), projectedLowestAfter: num(d.projected_lowest_after),
        threshold: num(d.threshold), amount: num(d.amount), reason: d.reason,
        approverName: d.approver_name, createdAt: d.created_at,
      };
    });
    const totalExposure = data.reduce((s, o) => s + o.amount, 0);
    res.json({ data, summary: { count: data.length, totalExposure } });
  } catch (err) {
    console.error('[treasury] listGateOverrides error', err);
    res.status(500).json({ error: 'Failed to load gate overrides' });
  }
}

module.exports = { seedMockHandler, resetMockHandler, listGateOverrides };

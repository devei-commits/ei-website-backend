/**
 * Express guard: block PO workflow mutations while a PO is on hold or cancelled
 * (Flowchart exception paths). Applied to approval / vendor / match action routes.
 *
 * Fail-open on a pre-migration schema (exception_status column absent) so existing
 * flows keep working until db.sync adds the column.
 */
const PurchaseOrder = require('./models');

function isMissingColumnError(err) {
  const code = err?.original?.code ?? err?.parent?.code;
  return code === '42703';
}

function blockOnExceptions({ blockOnHold = true, blockCancelled = true } = {}) {
  return async function poExceptionGuard(req, res, next) {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return next();
      let po;
      try {
        po = await PurchaseOrder.findByPk(id, { attributes: ['id', 'exception_status'] });
      } catch (err) {
        if (isMissingColumnError(err)) return next(); // column not migrated yet — don't block
        throw err;
      }
      if (!po) return next(); // let the handler return 404
      const ex = String(po.get('exception_status') || '').trim();
      if (blockCancelled && ex === 'cancelled') {
        return res.status(409).json({ error: 'PO is cancelled — no further actions are allowed.', code: 'PO_CANCELLED' });
      }
      if (blockOnHold && ex === 'on_hold') {
        return res.status(409).json({ error: 'PO is on hold — resume it before continuing.', code: 'PO_ON_HOLD' });
      }
      return next();
    } catch (err) {
      console.error('[poExceptionGuard] error', err);
      return next(err);
    }
  };
}

module.exports = { blockOnExceptions };

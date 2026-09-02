'use strict';

const db = require('../../db');

/**
 * Idempotently ensure the PO approval-workflow / exception / RTV columns (Flowchart Sub-flow E
 * + §5 PO types) exist on `purchase_orders`, the `po_approval_log` audit table, and the vendor-ack /
 * invoice-match / closure columns on `po_tracking` (Sub-flow F & I).
 *
 * Dev auto-adds these via db.sync({ alter: true }), but managed production SKIPS sync — so without
 * this the columns are missing there and the approval, hold/cancel/amend, and short-close/RTV paths
 * fail at runtime with Postgres 42703 (undefined column) → the controllers return
 * APPROVAL_SCHEMA_MISSING / EXCEPTION_SCHEMA_MISSING / GRN_EXCEPTION_SCHEMA_MISSING.
 *
 * A boot-time `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (like ensureLeadTimeStatsTable) makes dev
 * and prod converge with no manual migration. Fully idempotent and safe to run every boot.
 *
 * Column set + types mirror src/purchaseOrders/models.js and poApprovalLog.model.js exactly
 * (Sequelize DATE → TIMESTAMPTZ, STRING(n) → VARCHAR(n), DECIMAL → NUMERIC, JSON → JSON).
 */
async function ensurePurchaseOrderWorkflowColumns() {
  try {
    // Additive columns on purchase_orders — one ALTER, each guarded by IF NOT EXISTS.
    await db.query(`
      ALTER TABLE purchase_orders
        ADD COLUMN IF NOT EXISTS po_type                 VARCHAR(30)   DEFAULT 'regular',
        ADD COLUMN IF NOT EXISTS approval_status         VARCHAR(40),
        ADD COLUMN IF NOT EXISTS approval_required_role  VARCHAR(30),
        ADD COLUMN IF NOT EXISTS approval_amount         NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS submitted_for_review_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS approved_at             TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS exception_status        VARCHAR(20),
        ADD COLUMN IF NOT EXISTS exception_reason        VARCHAR(1000),
        ADD COLUMN IF NOT EXISTS exception_at            TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS exception_by            VARCHAR(200),
        ADD COLUMN IF NOT EXISTS amendment_count         INTEGER       DEFAULT 0,
        ADD COLUMN IF NOT EXISTS short_closed_at         TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS short_close_note        VARCHAR(500),
        ADD COLUMN IF NOT EXISTS rtv_status              VARCHAR(20),
        ADD COLUMN IF NOT EXISTS rtv_reason              VARCHAR(1000),
        ADD COLUMN IF NOT EXISTS rtv_debit_note_ref      VARCHAR(120),
        ADD COLUMN IF NOT EXISTS rtv_at                  TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS order_status            JSON,
        ADD COLUMN IF NOT EXISTS zoho_purchase_order_id  VARCHAR(100),
        ADD COLUMN IF NOT EXISTS zoho_bill_id            VARCHAR(100);
    `);

    // Append-only approval-transition audit trail (poApprovalLog.model.js, tableName 'po_approval_log').
    await db.query(`
      CREATE TABLE IF NOT EXISTS po_approval_log (
        id                SERIAL PRIMARY KEY,
        purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        action            VARCHAR(40)  NOT NULL,
        from_status       VARCHAR(40),
        to_status         VARCHAR(40),
        required_role     VARCHAR(30),
        po_type           VARCHAR(30),
        amount            NUMERIC(14,2),
        actor_id          INTEGER,
        actor_name        VARCHAR(200),
        actor_role        VARCHAR(50),
        note              VARCHAR(1000),
        created_at        TIMESTAMPTZ,
        updated_at        TIMESTAMPTZ,
        deleted_at        TIMESTAMPTZ,
        lifecycle_status  VARCHAR(255) DEFAULT 'active'
      );
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS po_approval_log_po_id_idx ON po_approval_log (purchase_order_id);
    `);

    // po_tracking — vendor-ack loop (Sub-flow F), vendor-reject path, invoice + 3-way match
    // (Sub-flow I), final payment, and closure columns. Missing on managed prod → getExceptionState
    // / tracking reads fail with 42703 ("sent_channel does not exist"). Types mirror poTracking/models.js.
    await db.query(`
      ALTER TABLE po_tracking
        ADD COLUMN IF NOT EXISTS sent_channel         VARCHAR(50),
        ADD COLUMN IF NOT EXISTS ack_sla_due_at       DATE,
        ADD COLUMN IF NOT EXISTS vendor_rejected_at   DATE,
        ADD COLUMN IF NOT EXISTS vendor_rejected_note VARCHAR(500),
        ADD COLUMN IF NOT EXISTS under_grn_at         DATE,
        ADD COLUMN IF NOT EXISTS under_grn_note       VARCHAR(500),
        ADD COLUMN IF NOT EXISTS grn_complete_at      DATE,
        ADD COLUMN IF NOT EXISTS grn_complete_note    VARCHAR(500),
        ADD COLUMN IF NOT EXISTS invoice_no           VARCHAR(100),
        ADD COLUMN IF NOT EXISTS invoice_date         DATE,
        ADD COLUMN IF NOT EXISTS invoice_amount       NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS match_status         VARCHAR(30),
        ADD COLUMN IF NOT EXISTS matched_at           TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS match_note           VARCHAR(1000),
        ADD COLUMN IF NOT EXISTS final_paid_at        DATE,
        ADD COLUMN IF NOT EXISTS final_paid_amount    NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS closed_at            TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS closed_note          VARCHAR(500);
    `);
    return { ensured: true };
  } catch (err) {
    // Never block boot on this — the affected paths degrade to a 409 "schema missing" until resolved.
    console.warn('[po-workflow] ensurePurchaseOrderWorkflowColumns failed:', err && err.message ? err.message : err);
    return { ensured: false };
  }
}

module.exports = { ensurePurchaseOrderWorkflowColumns };

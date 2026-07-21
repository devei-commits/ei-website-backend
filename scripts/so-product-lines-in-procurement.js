/*
 * For every OPEN procurement request, resolve the exact SO product LINE it was
 * raised for (via planning_extracted_id), the product's BOM, and the material(s)
 * being procured — so the BOM can be confirmed.
 */
const db = require('../db');
const CLOSED = ['Completed','Closed','Cancelled','Canceled','Rejected','GRN Received','Received','Fulfilled','Done'];

(async () => {
  try {
    const [rows] = await db.query(`
      WITH open_pr AS (
        SELECT id, status, planning_extracted_id, items::jsonb AS items
        FROM procurement_requests
        WHERE deleted_at IS NULL AND COALESCE(lifecycle_status,'active')='active'
          AND COALESCE(status,'') NOT IN (:closed)
      )
      SELECT
        so.order_id            AS so_no,
        so.customer_name       AS customer,
        pe.id                  AS planning_line_id,
        pe.product_id          AS product_id,
        p.product_code         AS product_code,
        COALESCE(p.product_name, p.commercial_name) AS product_name,
        pe.order_qty_display   AS ord_qty,
        pe.bom_status          AS plan_status,
        b.id                   AS bom_id,
        b.bom_code             AS bom_code,
        op.id                  AS pr_id,
        op.status              AS pr_status,
        string_agg(DISTINCT
          (e->>'type')||' '||(e->>'code')||' '||COALESCE(e->>'name','')||
          '  shortage '||COALESCE(e->>'shortage','?')||' '||COALESCE(e->>'unit',''),
          E'\n      ') AS materials_in_procurement
      FROM open_pr op
      JOIN planning_extracted pe ON pe.id = op.planning_extracted_id
      JOIN sales_orders so        ON so.id = pe.sales_order_id
      LEFT JOIN products p        ON p.product_id = pe.product_id
      LEFT JOIN boms b            ON b.product_id = pe.product_id
                                   AND b.deleted_at IS NULL
                                   AND COALESCE(b.lifecycle_status,'active')='active'
      LEFT JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(op.items)='array' THEN op.items ELSE '[]'::jsonb END) e ON TRUE
      GROUP BY so.order_id, so.customer_name, pe.id, pe.product_id, p.product_code,
               COALESCE(p.product_name, p.commercial_name), pe.order_qty_display, pe.bom_status, b.id, b.bom_code, op.id, op.status
      ORDER BY so.order_id, pe.id, op.id
    `, { replacements: { closed: CLOSED } });

    if (!rows.length) { console.log('No open procurement requests linked to an SO line.'); process.exit(0); }

    console.log(`\nSO product lines currently in procurement (confirm BOM against each):\n`);
    for (const r of rows) {
      console.log(`── ${r.so_no}  ·  ${r.customer}`);
      console.log(`   Product : ${r.product_code || '(no product_code)'}  —  ${r.product_name || '(name?)'}   [product_id ${r.product_id}]`);
      console.log(`   BOM     : ${r.bom_code || '(no active BOM linked!)'}${r.bom_id ? '  [bom_id '+r.bom_id+']' : ''}`);
      console.log(`   Planning: line #${r.planning_line_id} · ${r.plan_status} · ${r.ord_qty}`);
      console.log(`   PR      : #${r.pr_id} (${r.pr_status})`);
      console.log(`   Material: ${r.materials_in_procurement}`);
      console.log('');
    }
    process.exit(0);
  } catch (e) { console.error('ERR', e.message, e.stack); process.exit(1); }
})();

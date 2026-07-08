/**
 * Idempotent startup schema patches.
 *
 * Why this file exists: `sequelize.sync({ alter: true })` is not always reliable for adding
 * new columns (especially JSON / DECIMAL on large tables, or when a previous failed alter
 * left the table in a state Sequelize does not detect). When the ORM model and the live
 * Postgres schema drift, queries fail at runtime with `column "X" does not exist`.
 *
 * Each patch here is `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (Postgres-native and safe
 * to run repeatedly). Failures are logged but never fatal.
 *
 * Run on demand: `npm run db:patch` (after deploy, backup restore, or missing-column errors).
 * Not run on every server boot — once applied, patches are no-ops until new entries are added.
 *
 * Add new entries when a model gains a column that older databases don't have. Keep
 * statements ordered by table for readability.
 */

const db = require('../../db');
const { removeLegacyParentManufacturingArea } = require('../facilityAreas/removeLegacyParentMuArea');
const { ensureFacilityDefaultLocations } = require('../facilityAreas/ensureSingleDefaultLocationPerType');
const { getSoftDeleteSchemaPatches } = require('./softDeleteSchemaPatches');

const PATCHES = [
  // boms — SKU BOM (per-unit RM lines + net-per-unit limit) added April 2026
  {
    name: 'boms.sku_rm_lines',
    table: 'boms',
    sql: 'ALTER TABLE "boms" ADD COLUMN IF NOT EXISTS "sku_rm_lines" JSON',
  },
  {
    name: 'boms.sku_bom_limit_qty',
    table: 'boms',
    sql: 'ALTER TABLE "boms" ADD COLUMN IF NOT EXISTS "sku_bom_limit_qty" DECIMAL(18,6)',
  },
  {
    name: 'boms.sku_bom_limit_uom',
    table: 'boms',
    sql: 'ALTER TABLE "boms" ADD COLUMN IF NOT EXISTS "sku_bom_limit_uom" VARCHAR(20)',
  },
  // boms — Composite item flag (PR/CI series switch) added 2026
  {
    name: 'boms.bom_composite_item',
    table: 'boms',
    sql: 'ALTER TABLE "boms" ADD COLUMN IF NOT EXISTS "bom_composite_item" BOOLEAN DEFAULT false',
  },
  {
    name: 'boms.pr_masters_composite_item_data',
    table: 'boms',
    sql: `UPDATE "boms" SET "bom_composite_item" = true
      WHERE "product_id" IS NOT NULL
        AND COALESCE("bom_composite_item", false) IS NOT TRUE`,
  },
  {
    name: 'boms.pr_facility_licences',
    table: 'boms',
    sql: 'ALTER TABLE "boms" ADD COLUMN IF NOT EXISTS "pr_facility_licences" JSON',
  },
  // boms — pack lines + process steps + stability + linkage to products (long-running drift)
  {
    name: 'boms.pm_lines',
    table: 'boms',
    sql: 'ALTER TABLE "boms" ADD COLUMN IF NOT EXISTS "pm_lines" JSON',
  },
  {
    name: 'boms.process_steps',
    table: 'boms',
    sql: 'ALTER TABLE "boms" ADD COLUMN IF NOT EXISTS "process_steps" JSON',
  },
  {
    name: 'boms.stability_summary',
    table: 'boms',
    sql: 'ALTER TABLE "boms" ADD COLUMN IF NOT EXISTS "stability_summary" TEXT',
  },
  {
    name: 'boms.product_id',
    table: 'boms',
    sql: 'ALTER TABLE "boms" ADD COLUMN IF NOT EXISTS "product_id" INTEGER',
  },

  // Item masters (RM / PM / PR) — May 2026: column rename for clarity.
  // raw_materials.sku        → raw_materials.zoho_sku_code
  // pack_materials.sku       → pack_materials.zoho_sku_code
  // products.product_sku     → products.zoho_sku_code
  //
  // Idempotent rename via DO block (Postgres has no IF EXISTS on RENAME COLUMN).
  // Safe scenarios:
  //   - Old column present, new column absent  → renames.
  //   - Old column absent, new column present  → no-op (after first successful run, or fresh DB created from updated model).
  //   - Both present (unlikely)                → no-op (manual cleanup needed).
  {
    name: 'raw_materials.sku→zoho_sku_code',
    table: 'raw_materials',
    sql: `
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'raw_materials' AND column_name = 'sku'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'raw_materials' AND column_name = 'zoho_sku_code'
        ) THEN
          ALTER TABLE "raw_materials" RENAME COLUMN "sku" TO "zoho_sku_code";
        END IF;
      END $$;
    `,
  },
  {
    name: 'pack_materials.sku→zoho_sku_code',
    table: 'pack_materials',
    sql: `
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'pack_materials' AND column_name = 'sku'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'pack_materials' AND column_name = 'zoho_sku_code'
        ) THEN
          ALTER TABLE "pack_materials" RENAME COLUMN "sku" TO "zoho_sku_code";
        END IF;
      END $$;
    `,
  },
  {
    name: 'products.product_sku→zoho_sku_code',
    table: 'products',
    sql: `
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'product_sku'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'zoho_sku_code'
        ) THEN
          ALTER TABLE "products" RENAME COLUMN "product_sku" TO "zoho_sku_code";
        END IF;
      END $$;
    `,
  },

  // Rename the partial-unique indexes added earlier (they still point at the renamed column,
  // but the index name itself should reflect the new column for human legibility).
  {
    name: 'raw_materials_sku_uniq→zoho_sku_code_uniq',
    table: 'raw_materials',
    sql: 'ALTER INDEX IF EXISTS "raw_materials_sku_uniq" RENAME TO "raw_materials_zoho_sku_code_uniq"',
  },
  {
    name: 'pack_materials_sku_uniq→zoho_sku_code_uniq',
    table: 'pack_materials',
    sql: 'ALTER INDEX IF EXISTS "pack_materials_sku_uniq" RENAME TO "pack_materials_zoho_sku_code_uniq"',
  },
  {
    name: 'products_product_sku_uniq→zoho_sku_code_uniq',
    table: 'products',
    sql: 'ALTER INDEX IF EXISTS "products_product_sku_uniq" RENAME TO "products_zoho_sku_code_uniq"',
  },

  // (Re-)create the partial unique indexes under the new name. No-op if already present
  // (e.g. after the rename above, or on a fresh DB where Sequelize created neither).
  {
    name: 'raw_materials.zoho_sku_code.unique',
    table: 'raw_materials',
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "raw_materials_zoho_sku_code_uniq" ON "raw_materials" ("zoho_sku_code") WHERE "zoho_sku_code" IS NOT NULL',
  },
  {
    name: 'pack_materials.zoho_sku_code.unique',
    table: 'pack_materials',
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "pack_materials_zoho_sku_code_uniq" ON "pack_materials" ("zoho_sku_code") WHERE "zoho_sku_code" IS NOT NULL',
  },
  {
    name: 'products.zoho_sku_code.unique',
    table: 'products',
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "products_zoho_sku_code_uniq" ON "products" ("zoho_sku_code") WHERE "zoho_sku_code" IS NOT NULL',
  },

  // Item masters — ensure Zoho id columns are nullable. Models declare allowNull:true,
  // but if an older DB was created with NOT NULL we drop it here so inserts without a
  // Zoho id (e.g. when zoho sync is disabled or the upstream call fails) succeed.
  {
    name: 'raw_materials.zoho_id.drop_not_null',
    table: 'raw_materials',
    sql: 'ALTER TABLE "raw_materials" ALTER COLUMN "zoho_id" DROP NOT NULL',
  },
  {
    name: 'raw_materials.master_lifecycle_status',
    table: 'raw_materials',
    sql: 'ALTER TABLE "raw_materials" ADD COLUMN IF NOT EXISTS "master_lifecycle_status" VARCHAR(50)',
  },
  {
    name: 'raw_materials.rm_owner',
    table: 'raw_materials',
    sql: 'ALTER TABLE "raw_materials" ADD COLUMN IF NOT EXISTS "rm_owner" VARCHAR(255)',
  },
  {
    name: 'raw_materials.universal_swap_eligibility',
    table: 'raw_materials',
    sql: 'ALTER TABLE "raw_materials" ADD COLUMN IF NOT EXISTS "universal_swap_eligibility" VARCHAR(10)',
  },
  {
    name: 'raw_materials.functional_equivalents',
    table: 'raw_materials',
    sql: 'ALTER TABLE "raw_materials" ADD COLUMN IF NOT EXISTS "functional_equivalents" TEXT',
  },
  {
    name: 'pack_materials.zoho_id.drop_not_null',
    table: 'pack_materials',
    sql: 'ALTER TABLE "pack_materials" ALTER COLUMN "zoho_id" DROP NOT NULL',
  },
  {
    name: 'products.zoho_item_id.drop_not_null',
    table: 'products',
    sql: 'ALTER TABLE "products" ALTER COLUMN "zoho_item_id" DROP NOT NULL',
  },
  {
    name: 'products.pr_record_type',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "pr_record_type" VARCHAR(20)',
  },

  // RM/PM qty precision through SO lifecycle (planning → reserve → inventory)
  {
    name: 'reserved_batch_items.quantity_reserved_decimal_16',
    table: 'reserved_batch_items',
    sql: 'ALTER TABLE "reserved_batch_items" ALTER COLUMN "quantity_reserved" TYPE DECIMAL(28, 16)',
  },
  {
    name: 'warehouse_inventory.wh_stock_decimal_16',
    table: 'warehouse_inventory',
    sql: 'ALTER TABLE "warehouse_inventory" ALTER COLUMN "wh_stock" TYPE DECIMAL(28, 16)',
  },
  {
    name: 'warehouse_inventory.ml1_stock_decimal_16',
    table: 'warehouse_inventory',
    sql: 'ALTER TABLE "warehouse_inventory" ALTER COLUMN "ml1_stock" TYPE DECIMAL(28, 16)',
  },
  {
    name: 'warehouse_inventory.ml2_stock_decimal_16',
    table: 'warehouse_inventory',
    sql: 'ALTER TABLE "warehouse_inventory" ALTER COLUMN "ml2_stock" TYPE DECIMAL(28, 16)',
  },
  {
    name: 'warehouse_inventory.stock_in_hand_decimal_16',
    table: 'warehouse_inventory',
    sql: 'ALTER TABLE "warehouse_inventory" ALTER COLUMN "stock_in_hand" TYPE DECIMAL(28, 16)',
  },
  {
    name: 'warehouse_inventory.reserved_decimal_16',
    table: 'warehouse_inventory',
    sql: 'ALTER TABLE "warehouse_inventory" ALTER COLUMN "reserved" TYPE DECIMAL(28, 16)',
  },
  {
    name: 'warehouse_inventory.in_transit_decimal_16',
    table: 'warehouse_inventory',
    sql: 'ALTER TABLE "warehouse_inventory" ALTER COLUMN "in_transit" TYPE DECIMAL(28, 16)',
  },
  {
    name: 'warehouse_rack_items.qty_wh_decimal_16',
    table: 'warehouse_rack_items',
    sql: 'ALTER TABLE "warehouse_rack_items" ALTER COLUMN "qty_wh" TYPE DECIMAL(28, 16)',
  },
  {
    name: 'warehouse_inventory_location_history.qty_delta_decimal_16',
    table: 'warehouse_inventory_location_history',
    sql: 'ALTER TABLE "warehouse_inventory_location_history" ALTER COLUMN "qty_delta" TYPE DECIMAL(28, 16)',
  },
  {
    name: 'warehouse_inventory_location_history.reserved_delta_decimal_16',
    table: 'warehouse_inventory_location_history',
    sql: 'ALTER TABLE "warehouse_inventory_location_history" ALTER COLUMN "reserved_delta" TYPE DECIMAL(28, 16)',
  },
  {
    name: 'warehouse_inventory_location_history.reserved_after_decimal_16',
    table: 'warehouse_inventory_location_history',
    sql: 'ALTER TABLE "warehouse_inventory_location_history" ALTER COLUMN "reserved_after" TYPE DECIMAL(28, 16)',
  },

  // po_tracking — payment transaction captured at PO release (Treasury)
  {
    name: 'po_tracking.payment_transaction_no',
    table: 'po_tracking',
    sql: 'ALTER TABLE "po_tracking" ADD COLUMN IF NOT EXISTS "payment_transaction_no" VARCHAR(100)',
  },
  {
    name: 'po_tracking.payment_mode',
    table: 'po_tracking',
    sql: 'ALTER TABLE "po_tracking" ADD COLUMN IF NOT EXISTS "payment_mode" VARCHAR(50)',
  },
  {
    name: 'po_tracking.payment_transaction_date',
    table: 'po_tracking',
    sql: 'ALTER TABLE "po_tracking" ADD COLUMN IF NOT EXISTS "payment_transaction_date" DATE',
  },

  // facility_areas / warehouse_locations — Zoho Inventory location + warehouse sync (May 2026)
  {
    name: 'facility_areas.zoho_location_id',
    table: 'facility_areas',
    sql: 'ALTER TABLE "facility_areas" ADD COLUMN IF NOT EXISTS "zoho_location_id" VARCHAR(32)',
  },
  {
    name: 'facility_areas.zoho_meta',
    table: 'facility_areas',
    sql: 'ALTER TABLE "facility_areas" ADD COLUMN IF NOT EXISTS "zoho_meta" JSONB',
  },
  {
    name: 'facility_areas.zoho_location_id_uniq',
    table: 'facility_areas',
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "facility_areas_zoho_location_id_uniq" ON "facility_areas" ("zoho_location_id") WHERE "zoho_location_id" IS NOT NULL',
  },
  {
    name: 'warehouse_locations.zoho_warehouse_id',
    table: 'warehouse_locations',
    sql: 'ALTER TABLE "warehouse_locations" ADD COLUMN IF NOT EXISTS "zoho_warehouse_id" VARCHAR(32)',
  },
  {
    name: 'warehouse_locations.zoho_location_id',
    table: 'warehouse_locations',
    sql: 'ALTER TABLE "warehouse_locations" ADD COLUMN IF NOT EXISTS "zoho_location_id" VARCHAR(32)',
  },
  {
    name: 'warehouse_locations.is_active',
    table: 'warehouse_locations',
    sql: 'ALTER TABLE "warehouse_locations" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN DEFAULT true',
  },
  {
    name: 'warehouse_locations.zoho_meta',
    table: 'warehouse_locations',
    sql: 'ALTER TABLE "warehouse_locations" ADD COLUMN IF NOT EXISTS "zoho_meta" JSONB',
  },
  {
    name: 'warehouse_locations.zoho_warehouse_id_uniq',
    table: 'warehouse_locations',
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_locations_zoho_warehouse_id_uniq" ON "warehouse_locations" ("zoho_warehouse_id") WHERE "zoho_warehouse_id" IS NOT NULL',
  },
  {
    name: 'warehouse_locations.is_zoho_primary',
    table: 'warehouse_locations',
    sql: 'ALTER TABLE "warehouse_locations" ADD COLUMN IF NOT EXISTS "is_zoho_primary" BOOLEAN DEFAULT false',
  },
  {
    name: 'warehouse_locations.is_default',
    table: 'warehouse_locations',
    sql: 'ALTER TABLE "warehouse_locations" ADD COLUMN IF NOT EXISTS "is_default" BOOLEAN DEFAULT false',
  },
  {
    name: 'warehouse_locations.is_default_per_type_uniq',
    table: 'warehouse_locations',
    sql:
      'CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_locations_is_default_per_type_uniq" ON "warehouse_locations" ("location_type") WHERE "is_default" = true',
  },

  // Items List — MOQ tiers may be fractional (e.g. 0.5 KG) from Procurement quotations
  {
    name: 'item_list_tiers.moq_min_decimal',
    table: 'item_list_tiers',
    sql: 'ALTER TABLE "item_list_tiers" ALTER COLUMN "moq_min" TYPE DECIMAL(14,4) USING "moq_min"::decimal',
  },
  {
    name: 'item_list_tiers.moq_max_decimal',
    table: 'item_list_tiers',
    sql: 'ALTER TABLE "item_list_tiers" ALTER COLUMN "moq_max" TYPE DECIMAL(14,4) USING "moq_max"::decimal',
  },
  {
    name: 'item_list_vendor_rates.default_moq_decimal',
    table: 'item_list_vendor_rates',
    sql:
      'ALTER TABLE "item_list_vendor_rates" ALTER COLUMN "default_moq" TYPE DECIMAL(14,4) USING "default_moq"::decimal',
  },

  // production_batches — schedule-first BMR: MU zone + notes at schedule time
  {
    name: 'production_batches.scheduled_mu_zone',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "scheduled_mu_zone" VARCHAR(80)',
  },
  {
    name: 'production_batches.schedule_remarks',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "schedule_remarks" TEXT',
  },
  {
    name: 'production_team_members.drop_table',
    sql: 'DROP TABLE IF EXISTS "production_team_members" CASCADE',
  },
  {
    name: 'enum_production_team_members_department.drop_type',
    sql: 'DROP TYPE IF EXISTS "enum_production_team_members_department" CASCADE',
  },
  ...getSoftDeleteSchemaPatches(),
  {
    name: 'raw_materials.approval_assigned_user_id',
    table: 'raw_materials',
    sql: 'ALTER TABLE "raw_materials" ADD COLUMN IF NOT EXISTS "approval_assigned_user_id" INTEGER',
  },
  {
    name: 'raw_materials.approval_assigned_display_name',
    table: 'raw_materials',
    sql: 'ALTER TABLE "raw_materials" ADD COLUMN IF NOT EXISTS "approval_assigned_display_name" VARCHAR(255)',
  },
  {
    name: 'pack_materials.approval_assigned_user_id',
    table: 'pack_materials',
    sql: 'ALTER TABLE "pack_materials" ADD COLUMN IF NOT EXISTS "approval_assigned_user_id" INTEGER',
  },
  {
    name: 'pack_materials.approval_assigned_display_name',
    table: 'pack_materials',
    sql: 'ALTER TABLE "pack_materials" ADD COLUMN IF NOT EXISTS "approval_assigned_display_name" VARCHAR(255)',
  },
  {
    name: 'products.approval_assigned_user_id',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "approval_assigned_user_id" INTEGER',
  },
  {
    name: 'products.approval_assigned_display_name',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "approval_assigned_display_name" VARCHAR(255)',
  },
  {
    name: 'raw_materials.approval_stage_assignees',
    table: 'raw_materials',
    sql: 'ALTER TABLE "raw_materials" ADD COLUMN IF NOT EXISTS "approval_stage_assignees" JSONB',
  },
  {
    name: 'pack_materials.approval_stage_assignees',
    table: 'pack_materials',
    sql: 'ALTER TABLE "pack_materials" ADD COLUMN IF NOT EXISTS "approval_stage_assignees" JSONB',
  },
  {
    name: 'products.approval_stage_assignees',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "approval_stage_assignees" JSONB',
  },
  {
    name: 'products.approval_team_pending',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "approval_team_pending" JSONB',
  },
  {
    name: 'products.form_data',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "form_data" JSONB',
  },
  {
    name: 'users.last_login_at',
    table: 'users',
    sql: 'ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_login_at" TIMESTAMPTZ',
  },
  {
    name: 'master_approval_status_history.table',
    table: 'master_approval_status_history',
    skipTableCheck: true,
    sql: `CREATE TABLE IF NOT EXISTS "master_approval_status_history" (
      "id" SERIAL PRIMARY KEY,
      "master_kind" VARCHAR(4) NOT NULL,
      "master_id" INTEGER NOT NULL,
      "master_code" VARCHAR(120),
      "from_status" VARCHAR(64),
      "to_status" VARCHAR(64) NOT NULL,
      "changed_by_user_id" INTEGER,
      "changed_by_display_name" VARCHAR(255),
      "source" VARCHAR(64),
      "note" TEXT,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  },
  {
    name: 'master_approval_status_history.kind_id_idx',
    table: 'master_approval_status_history',
    skipTableCheck: true,
    sql:
      'CREATE INDEX IF NOT EXISTS "master_approval_status_history_kind_id_idx" ON "master_approval_status_history" ("master_kind", "master_id", "created_at" DESC)',
  },

  // quality_spec_rules — category/sub-category quality-spec templates for RM/PM/PR masters
  // (src/qualitySpecRules/models.js), replacing the frontend's localStorage-based rule store.
  {
    name: 'quality_spec_rules.table',
    table: 'quality_spec_rules',
    skipTableCheck: true,
    sql: `CREATE TABLE IF NOT EXISTS "quality_spec_rules" (
      "id" SERIAL PRIMARY KEY,
      "entity_type" VARCHAR(20) NOT NULL,
      "category" VARCHAR(150) NOT NULL,
      "sub_category" VARCHAR(150) NOT NULL DEFAULT '',
      "rows" JSONB,
      "created_at" TIMESTAMPTZ,
      "updated_at" TIMESTAMPTZ
    )`,
  },
  {
    name: 'quality_spec_rules.entity_category_subcategory.unique',
    table: 'quality_spec_rules',
    skipTableCheck: true,
    sql:
      'CREATE UNIQUE INDEX IF NOT EXISTS "quality_spec_rules_entity_category_subcategory_uniq" ON "quality_spec_rules" ("entity_type", "category", "sub_category")',
  },
  {
    // entity_type widened for PR section namespaces (e.g. 'PR_FINAL_CLEARANCE' = 18 chars);
    // needed on any DB where the table was already created with the original VARCHAR(10).
    name: 'quality_spec_rules.entity_type.widen',
    table: 'quality_spec_rules',
    sql: 'ALTER TABLE "quality_spec_rules" ALTER COLUMN "entity_type" TYPE VARCHAR(20)',
  },

  // quality_specs_locked — once true, an item's own saved quality specs win over the
  // category/sub-category rule (one-way; see src/qualitySpecRules/itemLock.js).
  {
    name: 'raw_materials.quality_specs_locked',
    table: 'raw_materials',
    sql: 'ALTER TABLE "raw_materials" ADD COLUMN IF NOT EXISTS "quality_specs_locked" BOOLEAN NOT NULL DEFAULT false',
  },
  {
    name: 'pack_materials.quality_specs_locked',
    table: 'pack_materials',
    sql: 'ALTER TABLE "pack_materials" ADD COLUMN IF NOT EXISTS "quality_specs_locked" BOOLEAN NOT NULL DEFAULT false',
  },
  {
    name: 'boms.quality_specs_locked',
    table: 'boms',
    sql: 'ALTER TABLE "boms" ADD COLUMN IF NOT EXISTS "quality_specs_locked" BOOLEAN NOT NULL DEFAULT false',
  },
];

async function tableExists(tableName) {
  try {
    const [rows] = await db.query(
      `SELECT to_regclass($1) AS oid`,
      { bind: [`public."${tableName}"`] }
    );
    return Array.isArray(rows) && rows[0] && rows[0].oid != null;
  } catch (_e) {
    return false;
  }
}

async function ensureSchemaPatches() {
  const dialect = db.getDialect ? db.getDialect() : null;
  if (dialect && dialect !== 'postgres') {
    // Patches use Postgres-only `ADD COLUMN IF NOT EXISTS`; skip for sqlite (test) etc.
    return;
  }

  // Cache existence per table so we only hit pg_catalog once per unique table name.
  const tableExistsCache = new Map();
  const checkTable = async (name) => {
    if (!name) return true;
    if (tableExistsCache.has(name)) return tableExistsCache.get(name);
    const exists = await tableExists(name);
    tableExistsCache.set(name, exists);
    return exists;
  };

  for (const patch of PATCHES) {
    if (!patch.skipTableCheck) {
      const exists = await checkTable(patch.table);
      if (!exists) {
        // Fresh DB / table not yet created — Sequelize sync will create it with the
        // column already present in the model. Skip silently to avoid log noise.
        continue;
      }
    }
    try {
      await db.query(patch.sql);
    } catch (err) {
      console.warn(
        `[ensureSchemaPatches] Skipped ${patch.name}: ${err && err.message ? err.message : err}`
      );
    }
  }

  try {
    await removeLegacyParentManufacturingArea();
  } catch (err) {
    console.warn(
      `[ensureSchemaPatches] removeLegacyParentManufacturingArea: ${err && err.message ? err.message : err}`
    );
  }

  try {
    const defs = await ensureFacilityDefaultLocations();
    if (defs.warehouse) {
      const tag = defs.warehouse.changed ? 'set' : 'ok';
      console.log(
        `[ensureSchemaPatches] warehouse default (${tag}): ${defs.warehouse.code} (id=${defs.warehouse.id})`
      );
    }
    if (defs.production) {
      const tag = defs.production.changed ? 'set' : 'ok';
      console.log(
        `[ensureSchemaPatches] production default (${tag}): ${defs.production.code} (id=${defs.production.id})`
      );
    }
  } catch (err) {
    console.warn(
      `[ensureSchemaPatches] ensureFacilityDefaultLocations: ${err && err.message ? err.message : err}`
    );
  }
}

module.exports = { ensureSchemaPatches };

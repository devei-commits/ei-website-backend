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

  // Safety net: a DB that has neither the old column (sku/product_sku) nor the new one
  // (zoho_sku_code) — e.g. created before any of the above renames ever ran — would fall
  // through both rename DO blocks as no-ops and be left with zoho_sku_code missing entirely.
  // Runs after the renames above so a real rename always wins over this fallback.
  {
    name: 'raw_materials.zoho_sku_code.add_if_missing',
    table: 'raw_materials',
    sql: 'ALTER TABLE "raw_materials" ADD COLUMN IF NOT EXISTS "zoho_sku_code" VARCHAR(100)',
  },
  {
    name: 'pack_materials.zoho_sku_code.add_if_missing',
    table: 'pack_materials',
    sql: 'ALTER TABLE "pack_materials" ADD COLUMN IF NOT EXISTS "zoho_sku_code" VARCHAR(100)',
  },
  {
    name: 'products.zoho_sku_code.add_if_missing',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "zoho_sku_code" VARCHAR(100)',
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
    name: 'raw_materials.zoho_id.add_if_missing',
    table: 'raw_materials',
    sql: 'ALTER TABLE "raw_materials" ADD COLUMN IF NOT EXISTS "zoho_id" VARCHAR(100)',
  },
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
  // raw_materials — remaining columns added over time but never patched (audit, Jul 2026).
  {
    name: 'raw_materials.hsn_code',
    table: 'raw_materials',
    sql: 'ALTER TABLE "raw_materials" ADD COLUMN IF NOT EXISTS "hsn_code" VARCHAR(50)',
  },
  {
    name: 'raw_materials.tax_pref',
    table: 'raw_materials',
    sql: 'ALTER TABLE "raw_materials" ADD COLUMN IF NOT EXISTS "tax_pref" VARCHAR(50)',
  },
  {
    name: 'raw_materials.sales_purchase_account',
    table: 'raw_materials',
    sql: 'ALTER TABLE "raw_materials" ADD COLUMN IF NOT EXISTS "sales_purchase_account" VARCHAR(255)',
  },
  {
    name: 'raw_materials.form_data',
    table: 'raw_materials',
    sql: 'ALTER TABLE "raw_materials" ADD COLUMN IF NOT EXISTS "form_data" JSON',
  },
  {
    name: 'raw_materials.specific_gravity',
    table: 'raw_materials',
    sql: 'ALTER TABLE "raw_materials" ADD COLUMN IF NOT EXISTS "specific_gravity" DECIMAL(5,3)',
  },
  {
    name: 'raw_materials.lead_time_days',
    table: 'raw_materials',
    sql: 'ALTER TABLE "raw_materials" ADD COLUMN IF NOT EXISTS "lead_time_days" INTEGER',
  },
  {
    name: 'pack_materials.zoho_id.add_if_missing',
    table: 'pack_materials',
    sql: 'ALTER TABLE "pack_materials" ADD COLUMN IF NOT EXISTS "zoho_id" VARCHAR(100)',
  },
  {
    name: 'pack_materials.zoho_id.drop_not_null',
    table: 'pack_materials',
    sql: 'ALTER TABLE "pack_materials" ALTER COLUMN "zoho_id" DROP NOT NULL',
  },
  // pack_materials — remaining columns added over time but never patched (audit, Jul 2026).
  {
    name: 'pack_materials.hsn_code',
    table: 'pack_materials',
    sql: 'ALTER TABLE "pack_materials" ADD COLUMN IF NOT EXISTS "hsn_code" VARCHAR(50)',
  },
  {
    name: 'pack_materials.unit',
    table: 'pack_materials',
    sql: 'ALTER TABLE "pack_materials" ADD COLUMN IF NOT EXISTS "unit" VARCHAR(20)',
  },
  {
    name: 'pack_materials.tax_pref',
    table: 'pack_materials',
    sql: 'ALTER TABLE "pack_materials" ADD COLUMN IF NOT EXISTS "tax_pref" VARCHAR(50)',
  },
  {
    name: 'pack_materials.sales_purchase_account',
    table: 'pack_materials',
    sql: 'ALTER TABLE "pack_materials" ADD COLUMN IF NOT EXISTS "sales_purchase_account" VARCHAR(255)',
  },
  {
    name: 'pack_materials.form_data',
    table: 'pack_materials',
    sql: 'ALTER TABLE "pack_materials" ADD COLUMN IF NOT EXISTS "form_data" JSON',
  },
  {
    name: 'products.zoho_item_id.add_if_missing',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "zoho_item_id" VARCHAR(64)',
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
  // products — remaining PR-master fields added over time but never patched (audit, Jul 2026).
  {
    name: 'products.commercial_name',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "commercial_name" VARCHAR(255)',
  },
  {
    name: 'products.lead_time_days',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "lead_time_days" INTEGER',
  },
  {
    name: 'products.form',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "form" VARCHAR(100)',
  },
  {
    name: 'products.fill_size',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "fill_size" VARCHAR(50)',
  },
  {
    name: 'products.batch_size_kg',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "batch_size_kg" INTEGER',
  },
  {
    name: 'products.shelf_life_months',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "shelf_life_months" INTEGER',
  },
  {
    name: 'products.version',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "version" VARCHAR(50)',
  },
  {
    name: 'products.license_cml',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "license_cml" VARCHAR(100)',
  },
  {
    name: 'products.theoretical_yield_pct',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "theoretical_yield_pct" DECIMAL(5,2)',
  },
  {
    name: 'products.pao_months',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "pao_months" INTEGER',
  },
  {
    name: 'products.manufacturing_location',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "manufacturing_location" VARCHAR(255)',
  },
  {
    name: 'products.equipment_vessel',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "equipment_vessel" VARCHAR(255)',
  },
  {
    name: 'products.storage_conditions',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "storage_conditions" TEXT',
  },
  {
    name: 'products.approved_claims',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "approved_claims" TEXT',
  },
  {
    name: 'products.ph_range',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "ph_range" VARCHAR(50)',
  },
  {
    name: 'products.viscosity_range',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "viscosity_range" VARCHAR(100)',
  },
  {
    name: 'products.spf_pa_rating',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "spf_pa_rating" VARCHAR(50)',
  },
  {
    name: 'products.appearance',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "appearance" VARCHAR(255)',
  },
  {
    name: 'products.odour',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "odour" VARCHAR(255)',
  },
  {
    name: 'products.fill_weight_spec',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "fill_weight_spec" VARCHAR(100)',
  },
  {
    name: 'products.stability_summary',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "stability_summary" TEXT',
  },

  // RM/PM qty precision through SO lifecycle (planning → reserve → inventory)
  {
    name: 'reserved_batch_items.quantity_reserved_decimal_16',
    table: 'reserved_batch_items',
    sql: 'ALTER TABLE "reserved_batch_items" ALTER COLUMN "quantity_reserved" TYPE DECIMAL(28, 16)',
  },
  // warehouse_inventory / warehouse_inventory_location_history — core inventory tables
  // (src/warehouseInventory/models.js, locationHistoryModel.js). CREATE TABLE fallback so a
  // managed production DB that skips sync({alter:true}) still gets these if missing entirely;
  // the ALTER COLUMN patches below then widen decimal precision on whichever copy exists.
  {
    name: 'warehouse_inventory.table',
    table: 'warehouse_inventory',
    skipTableCheck: true,
    sql: `CREATE TABLE IF NOT EXISTS "warehouse_inventory" (
      "id" SERIAL PRIMARY KEY,
      "item_type" VARCHAR(10) NOT NULL,
      "raw_material_id" INTEGER UNIQUE,
      "pack_material_id" INTEGER UNIQUE,
      "product_id" INTEGER UNIQUE,
      "zone" TEXT,
      "rack" TEXT,
      "wh_stock" DECIMAL(28,16) DEFAULT 0,
      "wh_unit" VARCHAR(20) DEFAULT 'KG',
      "ml1_stock" DECIMAL(28,16) DEFAULT 0,
      "ml2_stock" DECIMAL(28,16) DEFAULT 0,
      "stock_in_hand" DECIMAL(28,16) DEFAULT 0,
      "reserved" DECIMAL(28,16) DEFAULT 0,
      "in_transit" DECIMAL(28,16) DEFAULT 0,
      "reorder_pt" DECIMAL(14,2) DEFAULT 0,
      "avg_mo" DECIMAL(14,2) DEFAULT 0,
      "qc_status" VARCHAR(50) DEFAULT 'In Stock',
      "batch_number" VARCHAR(50),
      "expiry_date" DATE,
      "created_at" TIMESTAMPTZ,
      "updated_at" TIMESTAMPTZ,
      "deleted_at" TIMESTAMPTZ,
      "lifecycle_status" VARCHAR(255) DEFAULT 'active'
    )`,
  },
  {
    name: 'warehouse_inventory_location_history.table',
    table: 'warehouse_inventory_location_history',
    skipTableCheck: true,
    sql: `CREATE TABLE IF NOT EXISTS "warehouse_inventory_location_history" (
      "id" SERIAL PRIMARY KEY,
      "warehouse_inventory_id" INTEGER NOT NULL,
      "item_type" VARCHAR(10) NOT NULL,
      "raw_material_id" INTEGER,
      "pack_material_id" INTEGER,
      "product_id" INTEGER,
      "from_zone" VARCHAR(100),
      "from_rack" VARCHAR(100),
      "to_zone" VARCHAR(100),
      "to_rack" VARCHAR(100),
      "qty_delta" DECIMAL(28,16),
      "action_type" VARCHAR(30),
      "source_grn_id" INTEGER,
      "source_mrn_id" INTEGER,
      "moved_at" TIMESTAMPTZ NOT NULL,
      "reserved_delta" DECIMAL(28,16),
      "reserved_after" DECIMAL(28,16),
      "production_batch_id" INTEGER,
      "batch_no" VARCHAR(50),
      "dispensing_bundle_id" VARCHAR(80),
      "changes_json" JSONB,
      "note" TEXT,
      "deleted_at" TIMESTAMPTZ,
      "lifecycle_status" VARCHAR(255) DEFAULT 'active'
    )`,
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
  // production_batches — BMR/BPR team + shift lead + QC officer assignment (present in the
  // model since the batch team-assignment feature, but never patched here for managed DBs).
  {
    name: 'production_batches.team_bmr',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "team_bmr" JSON',
  },
  {
    name: 'production_batches.team_bpr',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "team_bpr" JSON',
  },
  {
    name: 'production_batches.shift_lead_bmr',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "shift_lead_bmr" VARCHAR(20)',
  },
  {
    name: 'production_batches.shift_lead_bpr',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "shift_lead_bpr" VARCHAR(20)',
  },
  {
    name: 'production_batches.qc_officer_bmr',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "qc_officer_bmr" VARCHAR(20)',
  },
  {
    name: 'production_batches.qc_officer_bpr',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "qc_officer_bpr" VARCHAR(20)',
  },
  // production_batches — the rest of the model's columns, safety-netted rather than assumed
  // present. The team_bmr/shift_lead_bmr group above came from this table's original creation
  // commit and was STILL missing here, so "part of the first migration" isn't a reliable signal
  // for this particular table — audit, Jul 2026.
  {
    name: 'production_batches.planning_batch_id',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "planning_batch_id" INTEGER',
  },
  {
    name: 'production_batches.color',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "color" VARCHAR(30)',
  },
  {
    name: 'production_batches.process_type',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "process_type" VARCHAR(10)',
  },
  {
    name: 'production_batches.homogenizer',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "homogenizer" BOOLEAN DEFAULT false',
  },
  {
    name: 'production_batches.main_vessel',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "main_vessel" VARCHAR(20)',
  },
  {
    name: 'production_batches.supporting_tanks',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "supporting_tanks" JSON',
  },
  {
    name: 'production_batches.filling_line',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "filling_line" VARCHAR(20)',
  },
  {
    name: 'production_batches.filling_type',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "filling_type" VARCHAR(20)',
  },
  {
    name: 'production_batches.packaging_line',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "packaging_line" VARCHAR(20)',
  },
  {
    name: 'production_batches.monocarton',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "monocarton" BOOLEAN DEFAULT false',
  },
  {
    name: 'production_batches.shrink',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "shrink" BOOLEAN DEFAULT false',
  },
  {
    name: 'production_batches.mfg_date',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "mfg_date" DATE',
  },
  {
    name: 'production_batches.fill_date',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "fill_date" DATE',
  },
  {
    name: 'production_batches.pack_date',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "pack_date" DATE',
  },
  {
    name: 'production_batches.fg_date',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "fg_date" DATE',
  },
  {
    name: 'production_batches.rm_connect_date',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "rm_connect_date" DATE',
  },
  {
    name: 'production_batches.pm_connect_date',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "pm_connect_date" DATE',
  },
  {
    name: 'production_batches.rm_reserved',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "rm_reserved" BOOLEAN DEFAULT false',
  },
  {
    name: 'production_batches.pm_reserved',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "pm_reserved" BOOLEAN DEFAULT false',
  },
  {
    name: 'production_batches.rm_connected',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "rm_connected" BOOLEAN DEFAULT false',
  },
  {
    name: 'production_batches.pm_connected',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "pm_connected" BOOLEAN DEFAULT false',
  },
  {
    name: 'production_batches.dispensing_rm',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "dispensing_rm" JSON',
  },
  {
    name: 'production_batches.dispensing_pm',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "dispensing_pm" JSON',
  },
  {
    name: 'production_batches.mu_dispensing_bundle_id',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "mu_dispensing_bundle_id" VARCHAR(80)',
  },
  {
    name: 'production_batches.mu_dispensing_bundles',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "mu_dispensing_bundles" JSON',
  },
  {
    name: 'production_batches.bulk_yield',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "bulk_yield" DECIMAL(12,3)',
  },
  {
    name: 'production_batches.fill_yield',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "fill_yield" DECIMAL(12,3)',
  },
  {
    name: 'production_batches.fg_yield',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "fg_yield" DECIMAL(12,3)',
  },
  {
    name: 'production_batches.bulk_batch_accepted',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "bulk_batch_accepted" BOOLEAN',
  },
  {
    name: 'production_batches.fill_batch_accepted',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "fill_batch_accepted" BOOLEAN',
  },
  {
    name: 'production_batches.fg_batch_accepted',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "fg_batch_accepted" BOOLEAN',
  },
  {
    name: 'production_batches.qc_specs',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "qc_specs" JSON',
  },
  {
    name: 'production_batches.remarks',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "remarks" TEXT',
  },
  {
    name: 'production_batches.due_date',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "due_date" DATE',
  },
  {
    name: 'production_batches.compatible_vessels',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "compatible_vessels" JSON',
  },
  {
    name: 'production_batches.compatible_fill_lines',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "compatible_fill_lines" JSON',
  },
  {
    name: 'production_batches.compatible_pack_lines',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "compatible_pack_lines" JSON',
  },
  {
    name: 'production_batches.required_volume_liters',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "required_volume_liters" DECIMAL(10,2)',
  },
  {
    name: 'production_batches.batch_index',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "batch_index" INTEGER',
  },
  {
    name: 'production_batches.total_batches',
    table: 'production_batches',
    sql: 'ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "total_batches" INTEGER',
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
  // PR master dual-track approval — independent RM + PM approval state (send → approve).
  // PR goes Active only when both tracks are Approved; any BOM edit resets both. See
  // src/lib/prTrackApproval.js. Backfill: existing Active rows get both tracks pre-Approved.
  {
    name: 'products.pr_track_approvals',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "pr_track_approvals" JSONB',
  },
  {
    name: 'products.pr_track_approvals.backfill_active',
    table: 'products',
    sql: `UPDATE "products"
      SET "pr_track_approvals" = jsonb_build_object(
        'rm', jsonb_build_object('status', 'Approved', 'sent_at', NULL, 'sent_by', NULL, 'approved_at', NULL, 'approved_by', NULL, 'note', NULL),
        'pm', jsonb_build_object('status', 'Approved', 'sent_at', NULL, 'sent_by', NULL, 'approved_at', NULL, 'approved_by', NULL, 'note', NULL)
      )
      WHERE "pr_track_approvals" IS NULL
        AND lower(COALESCE("status", "lifecycle_status", '')) = 'active'`,
  },
  {
    name: 'products.form_data',
    table: 'products',
    sql: 'ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "form_data" JSONB',
  },
  // products.lifecycle_status had no column default (unlike raw_materials/pack_materials, both
  // 'active'), so any create path that omitted it (e.g. the Zoho item import) left the row with
  // lifecycle_status = NULL — invisible to every scoped query, since the default read scope is
  // `lifecycle_status != 'deleted'`, and NULL != 'deleted' is unknown in SQL, not true.
  {
    name: 'products.lifecycle_status.default',
    table: 'products',
    sql: `ALTER TABLE "products" ALTER COLUMN "lifecycle_status" SET DEFAULT 'Draft'`,
  },
  {
    name: 'products.lifecycle_status.backfill_null',
    table: 'products',
    sql: `UPDATE "products" SET "lifecycle_status" = 'Draft' WHERE "lifecycle_status" IS NULL OR "lifecycle_status" = ''`,
  },
  {
    name: 'users.last_login_at',
    table: 'users',
    sql: 'ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_login_at" TIMESTAMPTZ',
  },
  // users — remaining columns added over time but never patched (audit, Jul 2026).
  {
    name: 'users.portal_signup_role',
    table: 'users',
    sql: 'ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "portal_signup_role" VARCHAR(64)',
  },
  {
    name: 'users.zoho_contact_id',
    table: 'users',
    sql: 'ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "zoho_contact_id" VARCHAR(64)',
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
  // fulfillment_orders — columns added after the table's initial creation; production DBs that
  // never ran sync({alter:true}) never got them, causing `column ... does not exist` crashes
  // (e.g. manual_status_override, hit 2026-07-08 on GET /api/v1/fulfillment).
  {
    name: 'fulfillment_orders.manual_status_override',
    table: 'fulfillment_orders',
    sql: 'ALTER TABLE "fulfillment_orders" ADD COLUMN IF NOT EXISTS "manual_status_override" BOOLEAN NOT NULL DEFAULT false',
  },
  {
    name: 'fulfillment_orders.commercial_status',
    table: 'fulfillment_orders',
    sql: `ALTER TABLE "fulfillment_orders" ADD COLUMN IF NOT EXISTS "commercial_status" VARCHAR(30) DEFAULT 'received'`,
  },
  {
    name: 'fulfillment_orders.on_hold_previous_status',
    table: 'fulfillment_orders',
    sql: 'ALTER TABLE "fulfillment_orders" ADD COLUMN IF NOT EXISTS "on_hold_previous_status" VARCHAR(30)',
  },
  {
    name: 'fulfillment_orders.raw_import',
    table: 'fulfillment_orders',
    sql: 'ALTER TABLE "fulfillment_orders" ADD COLUMN IF NOT EXISTS "raw_import" JSONB',
  },
  {
    name: 'fulfillment_orders.vendor_client_id',
    table: 'fulfillment_orders',
    sql: 'ALTER TABLE "fulfillment_orders" ADD COLUMN IF NOT EXISTS "vendor_client_id" INTEGER',
  },
  {
    name: 'fulfillment_orders.zoho_invoice_id',
    table: 'fulfillment_orders',
    sql: 'ALTER TABLE "fulfillment_orders" ADD COLUMN IF NOT EXISTS "zoho_invoice_id" VARCHAR(64)',
  },

  // treasury_* — working-capital command center (src/treasury/models.js). Schema was meant to be
  // materialized by `db.sync({ alter: true })`, but managed production DBs skip that call, so
  // these tables never got created there and `ensureTreasuryDefaults()` crashes on boot with
  // "relation does not exist". FK columns are plain INTEGER here (no DB-level FK constraint) —
  // Sequelize associations don't require one; keeps this idempotent and order-independent.
  {
    name: 'treasury_bank_accounts.table',
    table: 'treasury_bank_accounts',
    skipTableCheck: true,
    sql: `CREATE TABLE IF NOT EXISTS "treasury_bank_accounts" (
      "id" SERIAL PRIMARY KEY,
      "account_code" VARCHAR(40) NOT NULL UNIQUE,
      "bank_name" VARCHAR(120) NOT NULL,
      "account_label" VARCHAR(160),
      "account_number" VARCHAR(40),
      "account_type" VARCHAR(30) NOT NULL DEFAULT 'current',
      "purpose" VARCHAR(300),
      "current_balance" DECIMAL(16,2) DEFAULT 0,
      "overdraft_limit" DECIMAL(16,2) DEFAULT 0,
      "is_active" BOOLEAN NOT NULL DEFAULT true,
      "sort_order" INTEGER DEFAULT 0,
      "created_at" TIMESTAMPTZ,
      "updated_at" TIMESTAMPTZ,
      "deleted_at" TIMESTAMPTZ,
      "lifecycle_status" VARCHAR(255) DEFAULT 'active'
    )`,
  },
  {
    name: 'treasury_settings.table',
    table: 'treasury_settings',
    skipTableCheck: true,
    sql: `CREATE TABLE IF NOT EXISTS "treasury_settings" (
      "id" SERIAL PRIMARY KEY,
      "key" VARCHAR(120) NOT NULL UNIQUE,
      "value" JSONB,
      "description" VARCHAR(300),
      "created_at" TIMESTAMPTZ,
      "updated_at" TIMESTAMPTZ,
      "deleted_at" TIMESTAMPTZ,
      "lifecycle_status" VARCHAR(255) DEFAULT 'active'
    )`,
  },
  {
    name: 'treasury_recurring_payments.table',
    table: 'treasury_recurring_payments',
    skipTableCheck: true,
    sql: `CREATE TABLE IF NOT EXISTS "treasury_recurring_payments" (
      "id" SERIAL PRIMARY KEY,
      "recurring_code" VARCHAR(40) NOT NULL UNIQUE,
      "description" VARCHAR(300) NOT NULL,
      "source_module" VARCHAR(30),
      "source_subtype" VARCHAR(120),
      "payee_id" INTEGER,
      "payee_name" VARCHAR(300),
      "amount" DECIMAL(16,2) DEFAULT 0,
      "cadence" VARCHAR(20) NOT NULL DEFAULT 'monthly',
      "next_due_date" DATE,
      "last_generated_date" DATE,
      "bank_account_id" INTEGER,
      "auto_create_state" VARCHAR(20) NOT NULL DEFAULT 'draft',
      "auto_approve" BOOLEAN NOT NULL DEFAULT false,
      "status" VARCHAR(20) NOT NULL DEFAULT 'active',
      "created_by_id" INTEGER,
      "created_at" TIMESTAMPTZ,
      "updated_at" TIMESTAMPTZ,
      "deleted_at" TIMESTAMPTZ,
      "lifecycle_status" VARCHAR(255) DEFAULT 'active'
    )`,
  },
  {
    name: 'treasury_inward_payments.table',
    table: 'treasury_inward_payments',
    skipTableCheck: true,
    sql: `CREATE TABLE IF NOT EXISTS "treasury_inward_payments" (
      "id" SERIAL PRIMARY KEY,
      "inward_code" VARCHAR(40) NOT NULL UNIQUE,
      "type" VARCHAR(20) NOT NULL DEFAULT 'invoice',
      "client_id" INTEGER,
      "client_name" VARCHAR(300),
      "bd_poc_id" INTEGER,
      "expected_date" DATE,
      "original_expected_date" DATE,
      "expected_amount" DECIMAL(16,2) DEFAULT 0,
      "invoice_amount" DECIMAL(16,2) DEFAULT 0,
      "advance_amount" DECIMAL(16,2) DEFAULT 0,
      "expected_tds_percent" DECIMAL(5,2) DEFAULT 0,
      "expected_tds_amount" DECIMAL(16,2) DEFAULT 0,
      "net_expected_amount" DECIMAL(16,2) DEFAULT 0,
      "currency" VARCHAR(8) NOT NULL DEFAULT 'INR',
      "mode" VARCHAR(20),
      "destination_bank_account_id" INTEGER,
      "advance_against" VARCHAR(300),
      "adjustable_on" VARCHAR(300),
      "commitment_basis" VARCHAR(120),
      "commitment_attachment_url" VARCHAR(1000),
      "notes" TEXT,
      "status" VARCHAR(20) NOT NULL DEFAULT 'expected',
      "reschedule_count" INTEGER NOT NULL DEFAULT 0,
      "parent_inward_id" INTEGER,
      "actual_date" DATE,
      "actual_amount" DECIMAL(16,2) DEFAULT 0,
      "actual_mode" VARCHAR(20),
      "utr_reference" VARCHAR(120),
      "receiving_bank_account_id" INTEGER,
      "variance_amount" DECIMAL(16,2) DEFAULT 0,
      "variance_days" INTEGER DEFAULT 0,
      "statement_matched" BOOLEAN NOT NULL DEFAULT false,
      "confirmed_at" TIMESTAMPTZ,
      "confirmed_by_id" INTEGER,
      "reconciled_at" TIMESTAMPTZ,
      "hold_reason" VARCHAR(500),
      "write_off_amount" DECIMAL(16,2) DEFAULT 0,
      "write_off_reason" VARCHAR(500),
      "write_off_approved_by_id" INTEGER,
      "created_by_id" INTEGER,
      "created_at" TIMESTAMPTZ,
      "updated_at" TIMESTAMPTZ,
      "deleted_at" TIMESTAMPTZ,
      "lifecycle_status" VARCHAR(255) DEFAULT 'active'
    )`,
  },
  {
    name: 'treasury_inward_invoices.table',
    table: 'treasury_inward_invoices',
    skipTableCheck: true,
    sql: `CREATE TABLE IF NOT EXISTS "treasury_inward_invoices" (
      "id" SERIAL PRIMARY KEY,
      "inward_payment_id" INTEGER NOT NULL,
      "fulfillment_invoice_id" INTEGER,
      "invoice_no" VARCHAR(100),
      "amount_applied" DECIMAL(16,2) DEFAULT 0,
      "created_at" TIMESTAMPTZ,
      "updated_at" TIMESTAMPTZ,
      "deleted_at" TIMESTAMPTZ,
      "lifecycle_status" VARCHAR(255) DEFAULT 'active'
    )`,
  },
  {
    name: 'treasury_inward_variances.table',
    table: 'treasury_inward_variances',
    skipTableCheck: true,
    sql: `CREATE TABLE IF NOT EXISTS "treasury_inward_variances" (
      "id" SERIAL PRIMARY KEY,
      "inward_payment_id" INTEGER NOT NULL,
      "reason" VARCHAR(40) NOT NULL,
      "amount" DECIMAL(16,2) DEFAULT 0,
      "note" VARCHAR(500),
      "tds_quarter" VARCHAR(20),
      "tds_section" VARCHAR(20),
      "form16a_url" VARCHAR(1000),
      "created_by_id" INTEGER,
      "created_at" TIMESTAMPTZ,
      "updated_at" TIMESTAMPTZ,
      "deleted_at" TIMESTAMPTZ,
      "lifecycle_status" VARCHAR(255) DEFAULT 'active'
    )`,
  },
  {
    name: 'treasury_reschedule_history.table',
    table: 'treasury_reschedule_history',
    skipTableCheck: true,
    sql: `CREATE TABLE IF NOT EXISTS "treasury_reschedule_history" (
      "id" SERIAL PRIMARY KEY,
      "inward_payment_id" INTEGER NOT NULL,
      "old_date" DATE,
      "new_date" DATE,
      "delay_days" INTEGER DEFAULT 0,
      "reason_category" VARCHAR(120),
      "source" VARCHAR(120),
      "notes" TEXT,
      "attachment_url" VARCHAR(1000),
      "gate_verdict" VARCHAR(10),
      "gate_lowest_before" DECIMAL(16,2) DEFAULT 0,
      "gate_lowest_after" DECIMAL(16,2) DEFAULT 0,
      "override_reason" VARCHAR(500),
      "created_by_id" INTEGER,
      "created_at" TIMESTAMPTZ,
      "updated_at" TIMESTAMPTZ,
      "deleted_at" TIMESTAMPTZ,
      "lifecycle_status" VARCHAR(255) DEFAULT 'active'
    )`,
  },
  {
    name: 'treasury_advances.table',
    table: 'treasury_advances',
    skipTableCheck: true,
    sql: `CREATE TABLE IF NOT EXISTS "treasury_advances" (
      "id" SERIAL PRIMARY KEY,
      "client_id" INTEGER,
      "client_name" VARCHAR(300),
      "source_inward_id" INTEGER,
      "bank_account_id" INTEGER,
      "amount" DECIMAL(16,2) DEFAULT 0,
      "balance_amount" DECIMAL(16,2) DEFAULT 0,
      "advance_against" VARCHAR(300),
      "adjustable_on" VARCHAR(300),
      "status" VARCHAR(30) NOT NULL DEFAULT 'held',
      "created_at" TIMESTAMPTZ,
      "updated_at" TIMESTAMPTZ,
      "deleted_at" TIMESTAMPTZ,
      "lifecycle_status" VARCHAR(255) DEFAULT 'active'
    )`,
  },
  {
    name: 'treasury_tds_receivables.table',
    table: 'treasury_tds_receivables',
    skipTableCheck: true,
    sql: `CREATE TABLE IF NOT EXISTS "treasury_tds_receivables" (
      "id" SERIAL PRIMARY KEY,
      "inward_payment_id" INTEGER,
      "client_id" INTEGER,
      "client_name" VARCHAR(300),
      "amount" DECIMAL(16,2) DEFAULT 0,
      "tds_quarter" VARCHAR(20),
      "tds_section" VARCHAR(20),
      "form16a_url" VARCHAR(1000),
      "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
      "created_at" TIMESTAMPTZ,
      "updated_at" TIMESTAMPTZ,
      "deleted_at" TIMESTAMPTZ,
      "lifecycle_status" VARCHAR(255) DEFAULT 'active'
    )`,
  },
  {
    name: 'treasury_outward_payments.table',
    table: 'treasury_outward_payments',
    skipTableCheck: true,
    sql: `CREATE TABLE IF NOT EXISTS "treasury_outward_payments" (
      "id" SERIAL PRIMARY KEY,
      "outward_code" VARCHAR(40) NOT NULL UNIQUE,
      "source_module" VARCHAR(30) NOT NULL DEFAULT 'manual',
      "source_subtype" VARCHAR(120),
      "source_ref_type" VARCHAR(60),
      "source_ref_id" INTEGER,
      "source_ref_label" VARCHAR(200),
      "payee_type" VARCHAR(20),
      "payee_id" INTEGER,
      "payee_name" VARCHAR(300),
      "purpose" VARCHAR(500),
      "gross_amount" DECIMAL(16,2) DEFAULT 0,
      "tds_percent" DECIMAL(5,2) DEFAULT 0,
      "tds_amount" DECIMAL(16,2) DEFAULT 0,
      "net_amount" DECIMAL(16,2) DEFAULT 0,
      "currency" VARCHAR(8) NOT NULL DEFAULT 'INR',
      "due_date" DATE,
      "scheduled_date" DATE,
      "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
      "approval_tier" VARCHAR(60),
      "required_chain" JSONB,
      "is_capex" BOOLEAN NOT NULL DEFAULT false,
      "auto_approved" BOOLEAN NOT NULL DEFAULT false,
      "gate_verdict" VARCHAR(10),
      "bank_account_id" INTEGER,
      "mode" VARCHAR(20),
      "utr_reference" VARCHAR(120),
      "paid_at" TIMESTAMPTZ,
      "executed_by_id" INTEGER,
      "reconciled_at" TIMESTAMPTZ,
      "recurring_id" INTEGER,
      "hold_reason" VARCHAR(500),
      "reject_reason" VARCHAR(500),
      "notes" TEXT,
      "created_by_id" INTEGER,
      "created_at" TIMESTAMPTZ,
      "updated_at" TIMESTAMPTZ,
      "deleted_at" TIMESTAMPTZ,
      "lifecycle_status" VARCHAR(255) DEFAULT 'active'
    )`,
  },
  {
    name: 'treasury_approvals.table',
    table: 'treasury_approvals',
    skipTableCheck: true,
    sql: `CREATE TABLE IF NOT EXISTS "treasury_approvals" (
      "id" SERIAL PRIMARY KEY,
      "outward_payment_id" INTEGER NOT NULL,
      "level" INTEGER NOT NULL DEFAULT 1,
      "role_required" VARCHAR(30) NOT NULL,
      "approver_id" INTEGER,
      "approver_name" VARCHAR(200),
      "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
      "reason" VARCHAR(500),
      "gate_verdict_at_action" VARCHAR(10),
      "override_reason" VARCHAR(500),
      "sla_due_at" TIMESTAMPTZ,
      "acted_at" TIMESTAMPTZ,
      "created_at" TIMESTAMPTZ,
      "updated_at" TIMESTAMPTZ,
      "deleted_at" TIMESTAMPTZ,
      "lifecycle_status" VARCHAR(255) DEFAULT 'active'
    )`,
  },
  {
    name: 'treasury_gate_overrides.table',
    table: 'treasury_gate_overrides',
    skipTableCheck: true,
    sql: `CREATE TABLE IF NOT EXISTS "treasury_gate_overrides" (
      "id" SERIAL PRIMARY KEY,
      "action_type" VARCHAR(30) NOT NULL,
      "ref_type" VARCHAR(40),
      "ref_id" INTEGER,
      "ref_code" VARCHAR(40),
      "projected_lowest_before" DECIMAL(16,2) DEFAULT 0,
      "projected_lowest_after" DECIMAL(16,2) DEFAULT 0,
      "threshold" DECIMAL(16,2) DEFAULT 0,
      "amount" DECIMAL(16,2) DEFAULT 0,
      "reason" VARCHAR(500) NOT NULL,
      "approver_id" INTEGER,
      "approver_name" VARCHAR(200),
      "created_at" TIMESTAMPTZ,
      "updated_at" TIMESTAMPTZ,
      "deleted_at" TIMESTAMPTZ,
      "lifecycle_status" VARCHAR(255) DEFAULT 'active'
    )`,
  },
  {
    name: 'treasury_bank_statements.table',
    table: 'treasury_bank_statements',
    skipTableCheck: true,
    sql: `CREATE TABLE IF NOT EXISTS "treasury_bank_statements" (
      "id" SERIAL PRIMARY KEY,
      "bank_account_id" INTEGER,
      "txn_date" DATE,
      "direction" VARCHAR(10),
      "amount" DECIMAL(16,2) DEFAULT 0,
      "utr_reference" VARCHAR(120),
      "narration" VARCHAR(500),
      "matched_inward_id" INTEGER,
      "matched_outward_id" INTEGER,
      "match_status" VARCHAR(20) NOT NULL DEFAULT 'unmatched',
      "raw" JSONB,
      "created_at" TIMESTAMPTZ,
      "updated_at" TIMESTAMPTZ,
      "deleted_at" TIMESTAMPTZ,
      "lifecycle_status" VARCHAR(255) DEFAULT 'active'
    )`,
  },
  {
    name: 'treasury_audit_log.table',
    table: 'treasury_audit_log',
    skipTableCheck: true,
    sql: `CREATE TABLE IF NOT EXISTS "treasury_audit_log" (
      "id" SERIAL PRIMARY KEY,
      "entity_type" VARCHAR(40) NOT NULL,
      "entity_id" INTEGER,
      "entity_code" VARCHAR(40),
      "action" VARCHAR(60) NOT NULL,
      "actor_id" INTEGER,
      "actor_name" VARCHAR(200),
      "details" JSONB,
      "created_at" TIMESTAMPTZ,
      "updated_at" TIMESTAMPTZ,
      "deleted_at" TIMESTAMPTZ,
      "lifecycle_status" VARCHAR(255) DEFAULT 'active'
    )`,
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
      "sub_sub_category" VARCHAR(150) NOT NULL DEFAULT '',
      "rows" JSONB,
      "created_at" TIMESTAMPTZ,
      "updated_at" TIMESTAMPTZ
    )`,
  },
  {
    // entity_type widened for PR section namespaces (e.g. 'PR_FINAL_CLEARANCE' = 18 chars);
    // needed on any DB where the table was already created with the original VARCHAR(10).
    name: 'quality_spec_rules.entity_type.widen',
    table: 'quality_spec_rules',
    sql: 'ALTER TABLE "quality_spec_rules" ALTER COLUMN "entity_type" TYPE VARCHAR(20)',
  },
  {
    // sub_sub_category: RM/PM quality-spec rules can now be scoped a 3rd level deep (e.g.
    // category="Surfactant", sub_category="Anionic", sub_sub_category="<detail>").
    name: 'quality_spec_rules.sub_sub_category',
    table: 'quality_spec_rules',
    sql: `ALTER TABLE "quality_spec_rules" ADD COLUMN IF NOT EXISTS "sub_sub_category" VARCHAR(150) NOT NULL DEFAULT ''`,
  },
  {
    name: 'quality_spec_rules.entity_category_subcategory.unique.drop',
    table: 'quality_spec_rules',
    sql: 'DROP INDEX IF EXISTS "quality_spec_rules_entity_category_subcategory_uniq"',
  },
  {
    // Postgres identifiers cap at 63 bytes — the descriptive name silently truncates and can
    // collide with itself across separate CREATE attempts, so this uses a short, exact name.
    name: 'quality_spec_rules.scope.unique.drop_oversized_name_attempt',
    table: 'quality_spec_rules',
    sql: 'DROP INDEX IF EXISTS "quality_spec_rules_entity_category_subcategory_subsubcategory_u"',
  },
  {
    name: 'quality_spec_rules.scope.unique',
    table: 'quality_spec_rules',
    sql:
      'CREATE UNIQUE INDEX IF NOT EXISTS "quality_spec_rules_scope_uniq" ON "quality_spec_rules" ("entity_type", "category", "sub_category", "sub_sub_category")',
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

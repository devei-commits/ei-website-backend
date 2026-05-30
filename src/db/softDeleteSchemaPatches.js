/**
 * Idempotent schema patches: deleted_at + lifecycle_status on operational tables.
 */

const OPERATIONAL_TABLES = [
  'sales_orders',
  'planning_extracted',
  'planning_batches',
  'planning_bom_override',
  'planning_quotation_asks',
  'procurement_requests',
  'procurement_quotations',
  'purchase_orders',
  'po_tracking',
  'goods_received_notes',
  'production_batches',
  'production_equipment',
  'production_team_members',
  'material_request_notes',
  'fulfillment_orders',
  'fulfillment_order_items',
  'fulfillment_batch_splits',
  'fulfillment_invoices',
  'reserved_batch_items',
  'warehouse_inventory',
  'warehouse_inventory_location_history',
  'warehouse_locations',
  'warehouse_racks',
  'warehouse_rack_items',
  'products',
  'raw_materials',
  'pack_materials',
  'boms',
  'items_master',
  'items_list',
  'item_list_vendor_rates',
  'item_list_tiers',
  'item_groups',
  'vendor_clients',
  'facility_areas',
  'packaging',
  'customizations',
  'customization_packaging_options',
  'product_customizations',
  'orders',
  'order_items',
  'payments',
  'users',
  'addresses',
  'appointments',
  'departments',
  'roles',
  'enquiries',
  'logistics_schedules',
  'universal_swap_history',
  'transporters',
  'client_queries',
  'client_developments',
  'client_orders',
  'client_appointments',
  'newdevelopments',
  'doctor_profiles',
  'staff_profiles',
  'vendors',
];

function buildSoftDeleteColumnPatches() {
  const patches = [];
  for (const table of OPERATIONAL_TABLES) {
    patches.push({
      name: `${table}.deleted_at`,
      table,
      sql: `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ`,
    });
    patches.push({
      name: `${table}.lifecycle_status`,
      table,
      sql: `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "lifecycle_status" VARCHAR(255)`,
    });
  }
  return patches;
}

/** Partial unique indexes so soft-deleted rows do not block re-create. */
const PARTIAL_UNIQUE_INDEX_PATCHES = [
  {
    name: 'users.email.unique_active',
    table: 'users',
    sql: `
      DROP INDEX IF EXISTS "users_email_key";
      CREATE UNIQUE INDEX IF NOT EXISTS "users_email_active_uniq"
        ON "users" ("email") WHERE "deleted_at" IS NULL;
    `,
  },
  {
    name: 'products.zoho_sku_code.unique_active',
    table: 'products',
    sql: `
      DROP INDEX IF EXISTS "products_zoho_sku_code_uniq";
      DROP INDEX IF EXISTS "products_zoho_sku_code_key";
      CREATE UNIQUE INDEX IF NOT EXISTS "products_zoho_sku_code_active_uniq"
        ON "products" ("zoho_sku_code") WHERE "zoho_sku_code" IS NOT NULL AND "deleted_at" IS NULL;
    `,
  },
  {
    name: 'raw_materials.zoho_sku_code.unique_active',
    table: 'raw_materials',
    sql: `
      DROP INDEX IF EXISTS "raw_materials_zoho_sku_code_uniq";
      CREATE UNIQUE INDEX IF NOT EXISTS "raw_materials_zoho_sku_code_active_uniq"
        ON "raw_materials" ("zoho_sku_code") WHERE "zoho_sku_code" IS NOT NULL AND "deleted_at" IS NULL;
    `,
  },
  {
    name: 'raw_materials.code.unique_active',
    table: 'raw_materials',
    sql: `
      DROP INDEX IF EXISTS "raw_materials_code_key";
      CREATE UNIQUE INDEX IF NOT EXISTS "raw_materials_code_active_uniq"
        ON "raw_materials" ("code") WHERE "deleted_at" IS NULL;
    `,
  },
  {
    name: 'pack_materials.zoho_sku_code.unique_active',
    table: 'pack_materials',
    sql: `
      DROP INDEX IF EXISTS "pack_materials_zoho_sku_code_uniq";
      CREATE UNIQUE INDEX IF NOT EXISTS "pack_materials_zoho_sku_code_active_uniq"
        ON "pack_materials" ("zoho_sku_code") WHERE "zoho_sku_code" IS NOT NULL AND "deleted_at" IS NULL;
    `,
  },
];

/** Tables where lifecycle_status is archive-only (not a separate domain enum like products). */
const ARCHIVE_LIFECYCLE_TABLES = OPERATIONAL_TABLES.filter((t) => t !== 'products');

const LIFECYCLE_STATUS_BACKFILL_PATCHES = ARCHIVE_LIFECYCLE_TABLES.map((table) => ({
  name: `${table}.lifecycle_status.backfill_active`,
  sql: `
    UPDATE "${table}"
    SET "lifecycle_status" = 'active'
    WHERE "lifecycle_status" IS NULL AND "deleted_at" IS NULL;
  `,
}));

function getSoftDeleteSchemaPatches() {
  return [
    ...buildSoftDeleteColumnPatches(),
    ...LIFECYCLE_STATUS_BACKFILL_PATCHES,
    ...PARTIAL_UNIQUE_INDEX_PATCHES,
  ];
}

module.exports = { OPERATIONAL_TABLES, getSoftDeleteSchemaPatches };

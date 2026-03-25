# Zoho Books: seed sync & related code reference

This document describes how the **EI backend** pushes master data to **Zoho Books** from **`seed.js`**, which modules implement it, and how the same helpers are used at **API runtime** when you create records in the app. Use it when extending Zoho coverage (more vendors, more clients, other entities).

---

## Prerequisites (all Zoho calls)

Configured in **`.env`** (see **`backend/.env.example`** for the full list).

| Requirement | Notes |
|-------------|--------|
| `ZOHO_BOOKS_ENABLED=true` | Master switch; seed blocks and most sync helpers no-op without this. |
| OAuth | `ZOHO_REFRESH_TOKEN`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, optional `ZOHO_REDIRECT_URI`, `ZOHO_ACCOUNTS_TOKEN_URL`. |
| Org | `ZOHO_BOOKS_ORGANIZATION_ID` |
| API host | `ZOHO_BOOKS_API_BASE` (default India DC: `https://www.zohoapis.in/books/v3`). Use the DC that matches your org. |
| Currency (contacts & many flows) | `ZOHO_DEFAULT_CURRENCY_ID` — must be a **currency_id** from your org (e.g. run `node scripts/list-zoho-currencies.js`). |
| Item tax (optional) | `ZOHO_DEFAULT_ITEM_TAX_ID` — used when building item payloads. |
| Debug | `ZOHO_DEBUG=true` or `ZOHO_LOG_API=true` — logs Books request/response bodies (do not leave on in production). |

**HTTP layer:** `backend/src/services/zohoBooks.js` — token refresh cache, `createItem`, `createContact`, `createInvoice`, etc.

**Large IDs:** Zoho returns 16+ digit ids; JSON numbers lose precision. Helpers use `backend/src/services/zohoEnv.js` → `zohoNumericIdForJson()` where needed.

---

## Seed-only toggles (avoid calling Zoho on every re-seed)

`seed.js` loads `.env` via `dotenv` at the top. By default, **seed does not call Zoho** unless you explicitly opt in:

| Variable | Effect when `=== 'true'` (and `ZOHO_BOOKS_ENABLED=true`) |
|----------|----------------------------------------------------------|
| **`ZOHO_SEED_SYNC_ITEMS`** | After RM/PM bulk seed + `form_data` patches: create Books **items** for every seeded **Product (FG)**, **RawMaterial**, and **PackMaterial** that still has a null Zoho id field. Also requires **`ZOHO_SYNC_ITEMS` ≠ `'false'`**. |
| **`ZOHO_SEED_SYNC_CONTACT`** | (1) After addresses: sync **website user** `client1@example.com` to a **customer** contact. (2) After **VendorClient** bulk create: sync **Luminos Skincare** (`EI-CLI-00001`) as **customer** and **Chemspec India** (`EI-VEN-00001`) as **vendor**. |

Set these to **`false`** (or omit) for normal re-seeds so Books is not hit every time.

---

## Order of operations inside `seed.js`

Rough flow relative to Zoho:

1. **Users** (including `client1`) and **addresses**.
2. **If** `ZOHO_BOOKS_ENABLED` + `ZOHO_SEED_SYNC_CONTACT`: **User contact** — `client1` → `users.zoho_contact_id` (billing address from seeded `Address` row).
3. **Products**, **Pack materials**, **Raw materials** bulk create + optional `form_data` updates.
4. **If** `ZOHO_BOOKS_ENABLED` + `ZOHO_SEED_SYNC_ITEMS` + `ZOHO_SYNC_ITEMS` ≠ `false`:
   - All **`products`** with `zoho_item_id` null → `POST /items` → update **`products.zoho_item_id`**.
   - All **`raw_materials`** with `zoho_id` null → `POST /items` → update **`raw_materials.zoho_id`**.
   - All **`pack_materials`** with `zoho_id` null → `POST /items` → update **`pack_materials.zoho_id`**.
5. Later: **VendorClient** bulk create (Chemspec with `zoho_id: null`, Luminos with `zoho_id: null`, other vendors may keep placeholder ids).
6. **If** same contact seed flags: **VendorClient** contacts — Luminos → **`vendor_clients.zoho_id`** (customer), Chemspec → **`vendor_clients.zoho_id`** (vendor).

---

## What maps to what (Zoho ↔ Postgres)

| Local entity | Table / field | Zoho Books API | `contact_type` or item | Seed / helper |
|--------------|---------------|----------------|-------------------------|---------------|
| Finished good (catalogue product) | `products.zoho_item_id` | `POST /v3/items` | Item (goods) | `syncZohoItemForNewProduct` — `backend/src/products/zohoItemSync.js` |
| Raw material | `raw_materials.zoho_id` | `POST /v3/items` | Item (goods) | `syncZohoItemForNewRawMaterial` — `backend/src/services/zohoMasterItemSync.js` |
| Pack material | `pack_materials.zoho_id` | `POST /v3/items` | Item (goods) | `syncZohoItemForNewPackMaterial` — `backend/src/services/zohoMasterItemSync.js` |
| Website user (customer) | `users.zoho_contact_id` | `POST /v3/contacts` | `customer` | `syncZohoContactForNewUser` — `backend/src/users/zohoContactSync.js` |
| Vendor / client master row | `vendor_clients.zoho_id` | `POST /v3/contacts` | `customer` if `type === 'client'`, **`vendor`** if `type === 'vendor'` | `syncZohoContactForVendorClient` — `backend/src/users/zohoContactSync.js` |

**Fulfillment invoicing** (outside seed) uses `POST /invoices` and prefers **`products.zoho_item_id`** on line items; customer resolution uses **`users.zoho_contact_id`**, **`vendor_clients.zoho_id`**, or env fallback — see `backend/src/fulfillment/zohoInvoiceSync.js`.

---

## Runtime (non-seed) — same patterns

When expanding scope, mirror these controller hooks:

| Create path | After `Model.create` | Module |
|-------------|----------------------|--------|
| `POST` product (FG) | `syncZohoItemForNewProduct` → `products.zoho_item_id` | `backend/src/products/controller.js` |
| `POST` raw material | `syncZohoItemForNewRawMaterial` → `zoho_id` | `backend/src/rawMaterials/controller.js` |
| `POST` pack material | `syncZohoItemForNewPackMaterial` → `zoho_id` | `backend/src/packMaterials/controller.js` |
| Admin `POST` user create | `syncZohoContactForNewUser` if usertype in `ZOHO_SYNC_USERTYPES` (default `customer`) | `backend/src/users/controller.js` |

Vendor/client **create** via `vendorClient` controller does not yet call `syncZohoContactForVendorClient` — only seed does for Luminos/Chemspec today; adding it there would align with “expand scope”.

---

## Payload builders (for debugging / extension)

- **Items (FG):** `buildZohoItemPayload` in `products/zohoItemSync.js` — name, sku, rate, tax, HSN, etc.
- **Items (RM/PM):** `buildRawMaterialZohoPayload` / `buildPackMaterialZohoPayload` in `zohoMasterItemSync.js`.
- **Contacts (user):** `buildZohoContactPayload` in `zohoContactSync.js` — company name, `contact_persons`, currency, payment terms, optional billing.
- **Contacts (vendor_clients):** `buildZohoContactPayloadFromVendorClient` in `zohoContactSync.js` — sets `contact_type` from `type`, `contact_number` from `entity_code`, billing/shipping from row + `data`, `attention` on addresses.

All sync entrypoints are **non-throwing**: they return `{ synced, error?, itemId? | contactId? }` so local DB writes still succeed if Zoho fails.

---

## Extending (checklist)

1. **Decide** item vs contact and the correct Books `contact_type` (customer / vendor).
2. **Reuse** `zohoBooks.js` for new verbs; keep token refresh centralized.
3. **Store** returned id in a **string** column (length enough for 16+ digit strings).
4. **Gate** heavy or one-off pushes with env flags (seed: `ZOHO_SEED_*`; API: existing `ZOHO_SYNC_*` patterns).
5. **Skip** when id already set (or define explicit “force re-sync” if you need it).
6. **Log** with stable prefixes: `[Seed]`, `[Zoho]`, `[Zoho API]` for grep.
7. Update **this doc** when you add new entities or env vars.

---

## Related project rules

- Backend overview and Zoho summary: **`.cursor/rules/backend.mdc`** (Zoho Books section + seed paragraph).
- Item/contact/invoice surfaces table in that file should stay in sync when you add new sync points.

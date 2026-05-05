#!/usr/bin/env node
/**
 * Push seeded master data to Zoho Books (contacts + items), update Postgres, then
 * rewrite Zoho id maps in `seed.js` for checked-in reference.
 *
 * Prerequisites (same as other Zoho scripts):
 *   DATABASE_URL, ZOHO_REFRESH_TOKEN, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET,
 *   ZOHO_BOOKS_ORGANIZATION_ID, ZOHO_DEFAULT_CURRENCY_ID
 *
 * This script temporarily forces ZOHO_BOOKS_ENABLED and sync flags on for the process
 * (does not modify your .env file).
 *
 * Usage:
 *   node scripts/zoho-seed-upload-and-patch-seed.js [--dry-run] [--no-write-seed] [--patch-seed-only] [--force-reupload]
 *
 *   --dry-run          Log actions only (no Zoho POST, no DB updates, no seed.js write).
 *   --no-write-seed    Update DB from Zoho only; do not modify seed.js.
 *   --patch-seed-only  Skip Zoho API; read current DB zoho_* columns and refresh seed.js maps only.
 *   --force-reupload   Always POST new contacts/items to Books (skips “already has zoho id” and does
 *                      not reuse index lookup first). Overwrites local zoho_* with the new response ids.
 *                      If Books returns duplicate, retries once with a -fr{timestamp} suffix on
 *                      contact_number / sku (may leave an older row in Zoho unless you delete it there).
 */

require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');

const SEED_REL = '../seed.js';

function parseFlags(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    noWriteSeed: argv.includes('--no-write-seed'),
    patchSeedOnly: argv.includes('--patch-seed-only'),
    forceReupload: argv.includes('--force-reupload') || argv.includes('--force'),
  };
}

function applyZohoEnvForUpload() {
  process.env.ZOHO_BOOKS_ENABLED = 'true';
  process.env.ZOHO_SYNC_ITEMS = 'true';
  process.env.ZOHO_SYNC_CONTACTS = 'true';
  process.env.ZOHO_SYNC_VENDOR_CONTACTS = 'true';
  process.env.ZOHO_SYNC_CLIENT_CONTACTS = 'true';
  // So seeded staff rows (admin, doctor, …) get Books contacts unless you explicitly narrowed .env.
  if (!String(process.env.ZOHO_SYNC_USERTYPES || '').trim()) {
    process.env.ZOHO_SYNC_USERTYPES = 'super_admin,admin,bd_manager,accounts_team,doctor,customer';
  }
}

/** @param {Error & { zohoRaw?: unknown }} [err] */
function isZohoDuplicateContactError(err) {
  if (!err) return false;
  const raw = err.zohoRaw && typeof err.zohoRaw === 'object' ? err.zohoRaw : {};
  const m1 = String(err.message || '').toLowerCase();
  const m2 = String(raw.message || raw.error || '').toLowerCase();
  const s = `${m1} ${m2}`;
  if (/\balready exists\b/.test(s)) return true;
  if (/\bduplicate\b/.test(s)) return true;
  if (/\bcontact number\b/.test(s) && /\b(taken|exists|already)\b/.test(s)) return true;
  return false;
}

/** @param {Record<string, unknown>[]} contacts */
function buildContactLookup(contacts) {
  /** @type {Map<string, string>} */
  const byContactNumber = new Map();
  /** @type {Map<string, string>} */
  const byEmailLower = new Map();

  for (const c of contacts) {
    const id = c.contact_id != null ? String(c.contact_id).trim() : '';
    if (!id) continue;
    const cn = c.contact_number != null ? String(c.contact_number).trim() : '';
    if (cn) byContactNumber.set(cn, id);
    const persons = Array.isArray(c.contact_persons) ? c.contact_persons : [];
    for (const p of persons) {
      const em = p && p.email != null ? String(p.email).trim().toLowerCase() : '';
      if (em) byEmailLower.set(em, id);
    }
    const topEmail = c.email != null ? String(c.email).trim().toLowerCase() : '';
    if (topEmail) byEmailLower.set(topEmail, id);
  }
  return { byContactNumber, byEmailLower };
}

/**
 * @param {Record<string, unknown>[]} items
 * @returns {Map<string, string>}
 */
function buildSkuToItemId(items) {
  const m = new Map();
  for (const it of items) {
    const sku = it.sku != null ? String(it.sku).trim() : '';
    const id = it.item_id != null ? String(it.item_id).trim() : '';
    if (sku && id) m.set(sku, id);
  }
  return m;
}

/**
 * @param {string} constName
 * @param {Record<string, string>} obj
 */
function formatJsConstStringMap(constName, obj) {
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
  const lines = [`const ${constName} = {`];
  for (const k of keys) {
    lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(obj[k])},`);
  }
  lines.push('};');
  return lines.join('\n');
}

/**
 * @param {string} source
 * @param {string} constName
 * @param {string} newBlock
 */
function replaceConstBlock(source, constName, newBlock) {
  // Line endings: LF or CRLF (Docker on Windows mounts, git autocrlf, etc.)
  const re = new RegExp(
    `const ${constName.replace(/\$/g, '\\$')} = \\{[\\s\\S]*?\\r?\\n\\};`,
    'm'
  );
  if (!re.test(source)) {
    throw new Error(`seed.js: could not find const ${constName} = { ... }; to replace`);
  }
  return source.replace(re, newBlock);
}

/**
 * Insert or replace PR/RM/PM Zoho item_id maps in seed.js.
 * @param {string} source
 * @param {{
 *   productByCode: Record<string, string>,
 *   rmByCode: Record<string, string>,
 *   pmByCode: Record<string, string>,
 * }} maps
 */
function patchItemMapsInSeed(source, maps) {
  const pr = formatJsConstStringMap('ZOHO_SEED_PRODUCT_ITEM_IDS', maps.productByCode);
  const rm = formatJsConstStringMap('ZOHO_SEED_RAW_MATERIAL_ITEM_IDS', maps.rmByCode);
  const pm = formatJsConstStringMap('ZOHO_SEED_PACK_MATERIAL_ITEM_IDS', maps.pmByCode);
  const itemSection = [
    '/** Zoho Books item_id for seeded products (PR), keyed by product_code — reference only. */',
    pr,
    '',
    '/** Zoho Books item_id for seeded raw materials (RM), keyed by code — reference only. */',
    rm,
    '',
    '/** Zoho Books item_id for seeded pack materials (PM), keyed by code — reference only. */',
    pm,
  ].join('\n');

  const hasAll =
    source.includes('ZOHO_SEED_PRODUCT_ITEM_IDS') &&
    source.includes('ZOHO_SEED_RAW_MATERIAL_ITEM_IDS') &&
    source.includes('ZOHO_SEED_PACK_MATERIAL_ITEM_IDS');

  if (hasAll) {
    let s = source;
    s = replaceConstBlock(s, 'ZOHO_SEED_PRODUCT_ITEM_IDS', pr);
    s = replaceConstBlock(s, 'ZOHO_SEED_RAW_MATERIAL_ITEM_IDS', rm);
    s = replaceConstBlock(s, 'ZOHO_SEED_PACK_MATERIAL_ITEM_IDS', pm);
    return s;
  }

  // Require closing `};` then optional CRLF/LF line break before next statement
  const anchor =
    /const ZOHO_SEED_USER_CONTACT_IDS = \{[\s\S]*?\r?\n\};\r?\n/;
  if (anchor.test(source)) {
    return source.replace(anchor, (m) => `${m}\n${itemSection}\n`);
  }
  const anchorNoTrailingNl = /const ZOHO_SEED_USER_CONTACT_IDS = \{[\s\S]*?\r?\n\};/;
  if (anchorNoTrailingNl.test(source)) {
    return source.replace(anchorNoTrailingNl, (m) => `${m}\n\n${itemSection}\n`);
  }
  throw new Error(
    'seed.js: anchor ZOHO_SEED_USER_CONTACT_IDS block not found (check const name and line endings)'
  );
}

/**
 * @param {string} seedPath
 * @param {{
 *   vendorClientByEntity: Record<string, string>,
 *   userByEmail: Record<string, string>,
 *   productByCode: Record<string, string>,
 *   rmByCode: Record<string, string>,
 *   pmByCode: Record<string, string>,
 * }} maps
 */
async function writeSeedJs(seedPath, maps) {
  let source = await fs.readFile(seedPath, 'utf8');

  source = replaceConstBlock(
    source,
    'ZOHO_SEED_VENDOR_CLIENT_CONTACT_IDS',
    formatJsConstStringMap('ZOHO_SEED_VENDOR_CLIENT_CONTACT_IDS', maps.vendorClientByEntity)
  );
  source = replaceConstBlock(
    source,
    'ZOHO_SEED_USER_CONTACT_IDS',
    formatJsConstStringMap('ZOHO_SEED_USER_CONTACT_IDS', maps.userByEmail)
  );

  source = patchItemMapsInSeed(source, {
    productByCode: maps.productByCode,
    rmByCode: maps.rmByCode,
    pmByCode: maps.pmByCode,
  });
  await fs.writeFile(seedPath, source, 'utf8');
}

function hasZohoId(v) {
  return v != null && String(v).trim() !== '';
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const seedPath = path.resolve(__dirname, SEED_REL);

  if (!flags.patchSeedOnly) {
    applyZohoEnvForUpload();
  }

  // Load DB + models after env (zohoEnv reads process.env at require time).
  const db = require('../db');
  const VendorClient = require('../src/vendorClient/models');
  const { User } = require('../src/users/models');
  const { Product } = require('../src/products/models');
  const RawMaterial = require('../src/rawMaterials/models');
  const PackMaterial = require('../src/packMaterials/models');

  const { listAllContacts, listAllItems, normalizeZohoId, createContact, createItem } = require('../src/services/zohoBooks');
  const { isZohoDuplicateItemError } = require('../src/services/zohoSyncHelpers');
  const {
    syncZohoContactForVendorClient,
    buildZohoContactPayloadFromVendorClient,
    syncZohoContactForNewUser,
    buildZohoContactPayload,
    shouldSyncZohoForUsertype,
  } = require('../src/users/zohoContactSync');
  const {
    syncZohoItemForNewRawMaterial,
    syncZohoItemForNewPackMaterial,
    buildRawMaterialZohoPayload,
    buildPackMaterialZohoPayload,
  } = require('../src/services/zohoMasterItemSync');
  const { syncZohoItemForNewProduct, buildZohoItemPayload } = require('../src/products/zohoItemSync');

  try {
    await db.authenticate();
    console.log('[zoho-seed-upload] DB OK');

    /** @type {Record<string, unknown>[]|null} */
    let cachedContacts = null;
    /** @type {Map<string, string>|null} */
    let cachedSkuToItemId = null;

    async function refreshZohoCaches() {
      if (flags.patchSeedOnly || flags.dryRun) return;
      console.log('[zoho-seed-upload] Loading Zoho contacts index…');
      cachedContacts = await listAllContacts({});
      console.log('[zoho-seed-upload] Loading Zoho items index…');
      const items = await listAllItems({});
      cachedSkuToItemId = buildSkuToItemId(items);
      console.log(
        `[zoho-seed-upload] Index: ${cachedContacts.length} contacts, ${cachedSkuToItemId.size} SKUs`
      );
    }

    async function resolveVendorClientContactId(vc) {
      const plain = vc.get ? vc.get({ plain: true }) : vc;
      const code = plain.entity_code != null ? String(plain.entity_code).trim() : '';
      if (!cachedContacts) return null;
      const { byContactNumber, byEmailLower } = buildContactLookup(cachedContacts);
      if (code && byContactNumber.has(code)) return byContactNumber.get(code) || null;
      const em = plain.email != null ? String(plain.email).trim().toLowerCase() : '';
      if (em && byEmailLower.has(em)) return byEmailLower.get(em) || null;
      return null;
    }

    async function resolveUserContactId(user) {
      const plain = user.get ? user.get({ plain: true }) : user;
      const num = `EI-${plain.userid}`;
      if (!cachedContacts) return null;
      const { byContactNumber, byEmailLower } = buildContactLookup(cachedContacts);
      if (byContactNumber.has(num)) return byContactNumber.get(num) || null;
      const em = plain.email != null ? String(plain.email).trim().toLowerCase() : '';
      if (em && byEmailLower.has(em)) return byEmailLower.get(em) || null;
      return null;
    }

    async function resolveItemIdBySku(sku) {
      if (!sku || !cachedSkuToItemId) return null;
      return cachedSkuToItemId.get(String(sku).trim()) || null;
    }

    if (!flags.patchSeedOnly) {
      await refreshZohoCaches();
    }

    if (flags.forceReupload && !flags.patchSeedOnly && !flags.dryRun) {
      console.log(
        '[zoho-seed-upload] --force-reupload: POSTing new Books rows and overwriting local zoho_* (duplicate → suffix retry).'
      );
    }

    // --- Vendor / client contacts ---
    const vcs = await VendorClient.findAll({ order: [['id', 'ASC']] });
    for (const vc of vcs) {
      const z = vc.zoho_id;
      const needsVc = flags.forceReupload || !hasZohoId(z);
      if (!needsVc) {
        console.log(`[zoho-seed-upload] vendor_client ${vc.entity_code}: already has zoho_id`);
        continue;
      }
      if (flags.forceReupload && hasZohoId(z)) {
        console.log(
          `[zoho-seed-upload] FORCE vendor_client ${vc.entity_code}: re-upload (previous zoho_id=${z})`
        );
      }
      if (flags.patchSeedOnly) continue;
      if (flags.dryRun) {
        console.log(`[zoho-seed-upload] DRY vendor_client → Zoho: ${vc.entity_code}`);
        continue;
      }

      let contactId = null;

      if (flags.forceReupload) {
        try {
          const payload = buildZohoContactPayloadFromVendorClient(vc);
          const r = await createContact(payload);
          contactId = r.contactId;
        } catch (e) {
          if (isZohoDuplicateContactError(e)) {
            try {
              const payload = buildZohoContactPayloadFromVendorClient(vc);
              const base = String(payload.contact_number || 'EI-VC').slice(0, 72);
              payload.contact_number = `${base}-fr${Date.now()}`.slice(0, 100);
              const r = await createContact(payload);
              contactId = r.contactId;
            } catch (e2) {
              console.error(
                `[zoho-seed-upload] vendor_client ${vc.entity_code} force create (dedupe) failed:`,
                e2.message
              );
            }
          } else {
            console.error(`[zoho-seed-upload] vendor_client ${vc.entity_code} force create failed:`, e.message);
          }
        }
      } else {
        contactId = await resolveVendorClientContactId(vc);
        if (!contactId) {
          const syncRes = await syncZohoContactForVendorClient(vc);
          if (syncRes.synced && syncRes.contactId) {
            contactId = syncRes.contactId;
          } else if (syncRes.error) {
            console.warn(`[zoho-seed-upload] vendor_client ${vc.entity_code} sync:`, syncRes.error);
          }
        }

        if (!contactId) {
          try {
            const payload = buildZohoContactPayloadFromVendorClient(vc);
            const { contactId: cid } = await createContact(payload);
            contactId = cid;
          } catch (e) {
            if (isZohoDuplicateContactError(e)) {
              await refreshZohoCaches();
              contactId = await resolveVendorClientContactId(vc);
            } else {
              console.error(`[zoho-seed-upload] vendor_client ${vc.entity_code} create failed:`, e.message);
            }
          }
        }
      }

      if (contactId) {
        await vc.update({ zoho_id: contactId });
        console.log(`[zoho-seed-upload] vendor_client ${vc.entity_code} → zoho_id=${contactId}`);
      }
    }

    // --- User contacts (ZOHO_SYNC_USERTYPES) ---
    const users = await User.findAll({ order: [['userid', 'ASC']] });
    for (const user of users) {
      const uz = user.zoho_contact_id;
      const needsUser = flags.forceReupload || !hasZohoId(uz);
      if (!needsUser) {
        console.log(`[zoho-seed-upload] user ${user.email}: already has zoho_contact_id`);
        continue;
      }
      if (flags.forceReupload && hasZohoId(uz)) {
        console.log(
          `[zoho-seed-upload] FORCE user ${user.email}: re-upload (previous zoho_contact_id=${uz})`
        );
      }
      if (flags.patchSeedOnly) continue;
      if (flags.dryRun) {
        console.log(`[zoho-seed-upload] DRY user → Zoho: ${user.email}`);
        continue;
      }

      let contactId = null;

      if (flags.forceReupload) {
        if (!shouldSyncZohoForUsertype(user.usertype)) {
          continue;
        }
        try {
          const payload = buildZohoContactPayload(user, {});
          const r = await createContact(payload);
          contactId = r.contactId;
        } catch (e) {
          if (isZohoDuplicateContactError(e)) {
            try {
              const payload = buildZohoContactPayload(user, {});
              const base = String(payload.contact_number || `EI-${user.userid}`).slice(0, 72);
              payload.contact_number = `${base}-fr${Date.now()}`.slice(0, 100);
              const r = await createContact(payload);
              contactId = r.contactId;
            } catch (e2) {
              console.error(`[zoho-seed-upload] user ${user.email} force create (dedupe) failed:`, e2.message);
            }
          } else {
            console.error(`[zoho-seed-upload] user ${user.email} force create failed:`, e.message);
          }
        }
      } else {
        contactId = await resolveUserContactId(user);
        /** @type {{ synced?: boolean, contactId?: string, error?: string }} */
        let syncRes = {};
        if (!contactId) {
          syncRes = await syncZohoContactForNewUser(user, {});
          if (syncRes.error === 'usertype_not_configured_for_zoho') {
            continue;
          }
          if (syncRes.synced && syncRes.contactId) {
            contactId = syncRes.contactId;
          } else if (syncRes.error && syncRes.error !== 'zoho_disabled') {
            console.warn(`[zoho-seed-upload] user ${user.email} sync:`, syncRes.error);
          }
        }

        if (!contactId) {
          try {
            const payload = buildZohoContactPayload(user, {});
            const { contactId: cid } = await createContact(payload);
            contactId = cid;
          } catch (e) {
            if (isZohoDuplicateContactError(e)) {
              await refreshZohoCaches();
              contactId = await resolveUserContactId(user);
            } else {
              console.error(`[zoho-seed-upload] user ${user.email} create failed:`, e.message);
            }
          }
        }
      }

      if (contactId) {
        await user.update({ zoho_contact_id: contactId });
        console.log(`[zoho-seed-upload] user ${user.email} → zoho_contact_id=${contactId}`);
      }
    }

    // --- Products (PR) ---
    const products = await Product.findAll({ order: [['product_id', 'ASC']] });
    for (const p of products) {
      const pz = p.zoho_item_id;
      const needsPr = flags.forceReupload || !hasZohoId(pz);
      if (!needsPr) {
        console.log(`[zoho-seed-upload] product ${p.product_code}: already has zoho_item_id`);
        continue;
      }
      if (flags.forceReupload && hasZohoId(pz)) {
        console.log(
          `[zoho-seed-upload] FORCE product ${p.product_code}: re-upload (previous zoho_item_id=${pz})`
        );
      }
      if (flags.patchSeedOnly) continue;
      if (flags.dryRun) {
        console.log(`[zoho-seed-upload] DRY product → Zoho: ${p.product_code}`);
        continue;
      }

      const sku =
        (p.zoho_sku_code && String(p.zoho_sku_code).trim()) ||
        (p.product_code && String(p.product_code).trim()) ||
        '';
      let itemId = null;

      if (flags.forceReupload) {
        if (!sku) {
          console.warn(`[zoho-seed-upload] product ${p.product_code}: no sku/code for Zoho item`);
        } else {
          try {
            const payload = buildZohoItemPayload(p, {});
            const r = await createItem(payload);
            itemId = r.itemId;
          } catch (e) {
            if (isZohoDuplicateItemError(e)) {
              try {
                const payload = buildZohoItemPayload(p, {});
                const base = String(payload.sku || sku).slice(0, 78);
                payload.sku = `${base}-fr${Date.now()}`.slice(0, 100);
                const r = await createItem(payload);
                itemId = r.itemId;
              } catch (e2) {
                console.error(
                  `[zoho-seed-upload] product ${p.product_code} force create (dedupe) failed:`,
                  e2.message
                );
              }
            } else {
              console.error(`[zoho-seed-upload] product ${p.product_code} force create failed:`, e.message);
            }
          }
        }
      } else {
        itemId = sku ? await resolveItemIdBySku(sku) : null;

        if (!itemId) {
          const z = await syncZohoItemForNewProduct(p, {});
          if (z.synced && z.itemId) itemId = z.itemId;
          else if (z.duplicate || (z.error && isZohoDuplicateItemError({ message: z.error }))) {
            await refreshZohoCaches();
            itemId = sku ? await resolveItemIdBySku(sku) : null;
          } else if (z.error && z.error !== 'item_sync_disabled' && z.error !== 'zoho_disabled') {
            console.warn(`[zoho-seed-upload] product ${p.product_code}:`, z.error);
          }
        }

        if (!itemId && sku) {
          try {
            const payload = buildZohoItemPayload(p, {});
            const r = await createItem(payload);
            itemId = r.itemId;
          } catch (e) {
            if (isZohoDuplicateItemError(e)) {
              await refreshZohoCaches();
              itemId = await resolveItemIdBySku(sku);
            } else {
              console.error(`[zoho-seed-upload] product ${p.product_code} create failed:`, e.message);
            }
          }
        }
      }

      if (itemId) {
        await p.update({ zoho_item_id: itemId });
        console.log(`[zoho-seed-upload] product ${p.product_code} → zoho_item_id=${itemId}`);
      }
    }

    // --- Raw materials (RM) ---
    const rms = await RawMaterial.findAll({ order: [['id', 'ASC']] });
    for (const rm of rms) {
      const rz = rm.zoho_id;
      const needsRm = flags.forceReupload || !hasZohoId(rz);
      if (!needsRm) {
        console.log(`[zoho-seed-upload] RM ${rm.code}: already has zoho_id`);
        continue;
      }
      if (flags.forceReupload && hasZohoId(rz)) {
        console.log(`[zoho-seed-upload] FORCE RM ${rm.code}: re-upload (previous zoho_id=${rz})`);
      }
      if (flags.patchSeedOnly) continue;
      if (flags.dryRun) {
        console.log(`[zoho-seed-upload] DRY RM → Zoho: ${rm.code}`);
        continue;
      }

      const sku =
        (rm.sku && String(rm.sku).trim()) ||
        (rm.code && String(rm.code).trim()) ||
        '';
      let itemId = null;

      if (flags.forceReupload) {
        if (!sku) {
          console.warn(`[zoho-seed-upload] RM ${rm.code}: no sku/code for Zoho item`);
        } else {
          try {
            const payload = buildRawMaterialZohoPayload(rm, {});
            const r = await createItem(payload);
            itemId = r.itemId;
          } catch (e) {
            if (isZohoDuplicateItemError(e)) {
              try {
                const payload = buildRawMaterialZohoPayload(rm, {});
                const base = String(payload.sku || sku).slice(0, 78);
                payload.sku = `${base}-fr${Date.now()}`.slice(0, 100);
                const r = await createItem(payload);
                itemId = r.itemId;
              } catch (e2) {
                console.error(`[zoho-seed-upload] RM ${rm.code} force create (dedupe) failed:`, e2.message);
              }
            } else {
              console.error(`[zoho-seed-upload] RM ${rm.code} force create failed:`, e.message);
            }
          }
        }
      } else {
        itemId = sku ? await resolveItemIdBySku(sku) : null;

        if (!itemId) {
          const z = await syncZohoItemForNewRawMaterial(rm, {});
          if (z.synced && z.itemId) itemId = z.itemId;
          else if (z.duplicate || (z.error && isZohoDuplicateItemError({ message: z.error }))) {
            await refreshZohoCaches();
            itemId = sku ? await resolveItemIdBySku(sku) : null;
          } else if (z.error && z.error !== 'item_sync_disabled' && z.error !== 'zoho_disabled') {
            console.warn(`[zoho-seed-upload] RM ${rm.code}:`, z.error);
          }
        }

        if (!itemId && sku) {
          try {
            const payload = buildRawMaterialZohoPayload(rm, {});
            const r = await createItem(payload);
            itemId = r.itemId;
          } catch (e) {
            if (isZohoDuplicateItemError(e)) {
              await refreshZohoCaches();
              itemId = await resolveItemIdBySku(sku);
            } else {
              console.error(`[zoho-seed-upload] RM ${rm.code} create failed:`, e.message);
            }
          }
        }
      }

      if (itemId) {
        await rm.update({ zoho_id: itemId });
        console.log(`[zoho-seed-upload] RM ${rm.code} → zoho_id=${itemId}`);
      }
    }

    // --- Pack materials (PM) ---
    const pms = await PackMaterial.findAll({ order: [['id', 'ASC']] });
    for (const pm of pms) {
      const pmz = pm.zoho_id;
      const needsPm = flags.forceReupload || !hasZohoId(pmz);
      if (!needsPm) {
        console.log(`[zoho-seed-upload] PM ${pm.code}: already has zoho_id`);
        continue;
      }
      if (flags.forceReupload && hasZohoId(pmz)) {
        console.log(`[zoho-seed-upload] FORCE PM ${pm.code}: re-upload (previous zoho_id=${pmz})`);
      }
      if (flags.patchSeedOnly) continue;
      if (flags.dryRun) {
        console.log(`[zoho-seed-upload] DRY PM → Zoho: ${pm.code}`);
        continue;
      }

      const sku =
        (pm.sku && String(pm.sku).trim()) ||
        (pm.code && String(pm.code).trim()) ||
        '';
      let itemId = null;

      if (flags.forceReupload) {
        if (!sku) {
          console.warn(`[zoho-seed-upload] PM ${pm.code}: no sku/code for Zoho item`);
        } else {
          try {
            const payload = buildPackMaterialZohoPayload(pm, {});
            const r = await createItem(payload);
            itemId = r.itemId;
          } catch (e) {
            if (isZohoDuplicateItemError(e)) {
              try {
                const payload = buildPackMaterialZohoPayload(pm, {});
                const base = String(payload.sku || sku).slice(0, 78);
                payload.sku = `${base}-fr${Date.now()}`.slice(0, 100);
                const r = await createItem(payload);
                itemId = r.itemId;
              } catch (e2) {
                console.error(`[zoho-seed-upload] PM ${pm.code} force create (dedupe) failed:`, e2.message);
              }
            } else {
              console.error(`[zoho-seed-upload] PM ${pm.code} force create failed:`, e.message);
            }
          }
        }
      } else {
        itemId = sku ? await resolveItemIdBySku(sku) : null;

        if (!itemId) {
          const z = await syncZohoItemForNewPackMaterial(pm, {});
          if (z.synced && z.itemId) itemId = z.itemId;
          else if (z.duplicate || (z.error && isZohoDuplicateItemError({ message: z.error }))) {
            await refreshZohoCaches();
            itemId = sku ? await resolveItemIdBySku(sku) : null;
          } else if (z.error && z.error !== 'item_sync_disabled' && z.error !== 'zoho_disabled') {
            console.warn(`[zoho-seed-upload] PM ${pm.code}:`, z.error);
          }
        }

        if (!itemId && sku) {
          try {
            const payload = buildPackMaterialZohoPayload(pm, {});
            const r = await createItem(payload);
            itemId = r.itemId;
          } catch (e) {
            if (isZohoDuplicateItemError(e)) {
              await refreshZohoCaches();
              itemId = await resolveItemIdBySku(sku);
            } else {
              console.error(`[zoho-seed-upload] PM ${pm.code} create failed:`, e.message);
            }
          }
        }
      }

      if (itemId) {
        await pm.update({ zoho_id: itemId });
        console.log(`[zoho-seed-upload] PM ${pm.code} → zoho_id=${itemId}`);
      }
    }

    // --- Build maps from DB for seed.js ---
    const vendorClientByEntity = {};
    const vcsFinal = await VendorClient.findAll({ attributes: ['entity_code', 'zoho_id'], raw: true });
    for (const row of vcsFinal) {
      const code = row.entity_code != null ? String(row.entity_code).trim() : '';
      const zid = normalizeZohoId(row.zoho_id);
      if (code && zid) vendorClientByEntity[code] = zid;
    }

    const userByEmail = {};
    const usersFinal = await User.findAll({ attributes: ['email', 'zoho_contact_id'], raw: true });
    for (const row of usersFinal) {
      const em = row.email != null ? String(row.email).trim().toLowerCase() : '';
      const zid = normalizeZohoId(row.zoho_contact_id);
      if (em && zid) userByEmail[em] = zid;
    }

    const productByCode = {};
    const prFinal = await Product.findAll({ attributes: ['product_code', 'zoho_item_id'], raw: true });
    for (const row of prFinal) {
      const code = row.product_code != null ? String(row.product_code).trim() : '';
      const zid = normalizeZohoId(row.zoho_item_id);
      if (code && zid) productByCode[code] = zid;
    }

    const rmByCode = {};
    const rmFinal = await RawMaterial.findAll({ attributes: ['code', 'zoho_id'], raw: true });
    for (const row of rmFinal) {
      const code = row.code != null ? String(row.code).trim() : '';
      const zid = normalizeZohoId(row.zoho_id);
      if (code && zid) rmByCode[code] = zid;
    }

    const pmByCode = {};
    const pmFinal = await PackMaterial.findAll({ attributes: ['code', 'zoho_id'], raw: true });
    for (const row of pmFinal) {
      const code = row.code != null ? String(row.code).trim() : '';
      const zid = normalizeZohoId(row.zoho_id);
      if (code && zid) pmByCode[code] = zid;
    }

    console.log('[zoho-seed-upload] Summary from DB:', {
      vendor_clients: Object.keys(vendorClientByEntity).length,
      users: Object.keys(userByEmail).length,
      products: Object.keys(productByCode).length,
      raw_materials: Object.keys(rmByCode).length,
      pack_materials: Object.keys(pmByCode).length,
    });

    if (!flags.noWriteSeed && !flags.dryRun) {
      await writeSeedJs(seedPath, {
        vendorClientByEntity,
        userByEmail,
        productByCode,
        rmByCode,
        pmByCode,
      });
      console.log(`[zoho-seed-upload] Updated ${seedPath}`);
    } else if (flags.dryRun) {
      console.log('[zoho-seed-upload] Dry run: skipped seed.js write');
    } else {
      console.log('[zoho-seed-upload] --no-write-seed: skipped seed.js write');
    }

    await db.close();
    console.log('[zoho-seed-upload] Done.');
  } catch (e) {
    console.error('[zoho-seed-upload] Fatal:', e);
    try {
      await db.close();
    } catch (_e) {
      /* ignore */
    }
    process.exitCode = 1;
  }
}

main();

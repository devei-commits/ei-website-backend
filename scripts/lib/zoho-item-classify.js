/**
 * Classify Zoho Books items → local master table (products / raw_materials / pack_materials).
 * Shared by zoho-pull-items-to-products.js and zoho-fetch-master-map.js
 */

function compileKindRegex(envKey, fallbackPattern) {
  const raw = process.env[envKey];
  if (raw != null && String(raw).trim() !== '') {
    try {
      const s = String(raw).trim();
      if (s.length >= 2 && s[0] === '/' && s.lastIndexOf('/') > 0) {
        const last = s.lastIndexOf('/');
        const body = s.slice(1, last);
        const flags = s.slice(last + 1) || 'i';
        return new RegExp(body, flags);
      }
      return new RegExp(s, 'i');
    } catch (e) {
      console.warn(`[zoho-item-classify] invalid ${envKey}, using default:`, e.message);
    }
  }
  return new RegExp(fallbackPattern, 'i');
}

function normalizeCategoryKey(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function getZohoCfCategory(item) {
  const direct = item.cf_category != null ? String(item.cf_category).trim() : '';
  if (direct) return direct;
  const alt = item.cf_category_unformatted != null ? String(item.cf_category_unformatted).trim() : '';
  if (alt) return alt;
  const h = item.custom_field_hash && typeof item.custom_field_hash === 'object' ? item.custom_field_hash : null;
  if (h && h.cf_category != null && String(h.cf_category).trim()) return String(h.cf_category).trim();
  if (h && h.cf_category_unformatted != null && String(h.cf_category_unformatted).trim()) {
    return String(h.cf_category_unformatted).trim();
  }
  return '';
}

/**
 * @param {Record<string, unknown>} item
 * @returns {{ kind: 'pr' | 'rm' | 'pm' | 'skip', bucket: string, cfCategory: string | null }}
 */
function classifyZohoMasterItem(item) {
  const sku = item.sku != null ? String(item.sku).trim() : '';
  const name = item.name != null ? String(item.name).trim() : '';
  const cfCategory = getZohoCfCategory(item);
  const cfKey = normalizeCategoryKey(cfCategory);

  const byCfCategory = {
    'fg- ongoing': { kind: 'pr', bucket: 'Product' },
    fragrance: { kind: 'rm', bucket: 'Raw Material' },
    'raw material': { kind: 'rm', bucket: 'Raw Material' },
    'rm- active': { kind: 'rm', bucket: 'Raw Material' },
    'rm- base': { kind: 'rm', bucket: 'Raw Material' },
    'rm- exceipient': { kind: 'rm', bucket: 'Raw Material' },
    'packaging material': { kind: 'pm', bucket: 'Packaging Material' },
    ppm: { kind: 'pm', bucket: 'Packaging Material' },
    'ppm - bottle': { kind: 'pm', bucket: 'Packaging Material' },
    'ppm - closure': { kind: 'pm', bucket: 'Packaging Material' },
    'spm - label': { kind: 'pm', bucket: 'Packaging Material' },
    'spm - others': { kind: 'pm', bucket: 'Packaging Material' },
    'spm-carton and kit': { kind: 'pm', bucket: 'Packaging Material' },
    'terminated composites': { kind: 'pr', bucket: 'Composite' },
    'temporary composites': { kind: 'pr', bucket: 'Composite' },
    'permenant composites': { kind: 'pr', bucket: 'Composite' },
    'inhouse composites': { kind: 'pr', bucket: 'Composite' },
    'equipment and accessories': { kind: 'pr', bucket: 'Other' },
    consumables: { kind: 'pr', bucket: 'Other' },
    'other expense': { kind: 'pr', bucket: 'Other' },
  };

  if (cfKey && byCfCategory[cfKey]) {
    const mapped = byCfCategory[cfKey];
    return { kind: mapped.kind, bucket: mapped.bucket, cfCategory: cfCategory || null };
  }

  const rePr = compileKindRegex('ZOHO_PULL_KIND_PR_REGEX', '^EI-PR[-_]');
  const rePm = compileKindRegex('ZOHO_PULL_KIND_PM_REGEX', '^EI-PM[-_]');
  const reRm = compileKindRegex('ZOHO_PULL_KIND_RM_REGEX', '^EI-RM[-_]');
  const map = { pr: rePr, pm: rePm, rm: reRm };
  const orderRaw = process.env.ZOHO_PULL_KIND_ORDER || 'pr,pm,rm';
  const order = orderRaw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((k) => map[k]);

  const test = (re) => re.test(sku) || re.test(name);
  for (const k of order) {
    if (test(map[k])) {
      const bucket = k === 'rm' ? 'Raw Material' : k === 'pm' ? 'Packaging Material' : 'Product';
      return { kind: k, bucket, cfCategory: cfCategory || null };
    }
  }

  const u = String(process.env.ZOHO_PULL_UNMATCHED || 'skip').toLowerCase();
  if (u === 'pr' || u === 'rm' || u === 'pm') {
    const bucket = u === 'rm' ? 'Raw Material' : u === 'pm' ? 'Packaging Material' : 'Product';
    return { kind: u, bucket, cfCategory: cfCategory || null };
  }
  return { kind: 'skip', bucket: 'Unclassified', cfCategory: cfCategory || null };
}

function dbTargetForKind(kind) {
  if (kind === 'pr') return { table: 'products', zohoField: 'zoho_item_id', kind: 'pr' };
  if (kind === 'rm') return { table: 'raw_materials', zohoField: 'zoho_id', kind: 'rm' };
  if (kind === 'pm') return { table: 'pack_materials', zohoField: 'zoho_id', kind: 'pm' };
  return { table: null, zohoField: null, kind: 'skip' };
}

module.exports = {
  classifyZohoMasterItem,
  dbTargetForKind,
};

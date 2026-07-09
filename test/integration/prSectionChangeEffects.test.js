/**
 * Integration: applyPrSectionChangeEffects (src/products/controller.js) — auto-claims an open
 * RM/Pack slot for whoever edits that section, admin or not, then locks it to that owner.
 *
 * This is the actual code path updateProduct() calls on every PR edit. The prTrackApproval.js
 * unit tests only cover the pure classification helper and the separate send/approve state
 * machine — neither exercises this function, which is why the "admins don't grab it" exemption
 * bug shipped without a failing test.
 */
const db = require('../../db');
require('../../app');
const { Product } = require('../../src/products/models');
const { applyPrSectionChangeEffects } = require('../../src/products/controller');
const { isDbAvailable } = require('../helpers/dbAvailability');

describe('applyPrSectionChangeEffects', () => {
  let dbAvailable = true;
  const createdIds = [];

  beforeAll(async () => {
    dbAvailable = await isDbAvailable(db);
  });

  afterAll(async () => {
    if (dbAvailable && createdIds.length) {
      await Product.destroy({ where: { product_id: createdIds }, force: true });
    }
  });

  test('admin editor claims an open RM slot (no longer exempted) and it locks to them', async () => {
    if (!dbAvailable) return;
    const product = await Product.create({
      zoho_sku_code: 'SKU-PRTRACK-ADMIN-001',
      product_name: 'Test PR Track Product (admin claim)',
      status: 'Draft',
      approval_stage_assignees: { rm_team: null, pack_team: null },
    });
    createdIds.push(product.product_id);

    const adminReq = { user: { id: 579, role: 'super_admin', email: 'superadmin@example.com' } };
    await applyPrSectionChangeEffects(adminReq, product, { rm: true, pm: false });
    await product.reload();

    expect(product.approval_stage_assignees.rm_team).toBeTruthy();
    expect(product.approval_stage_assignees.rm_team.user_id).toBe(579);
    expect(product.approval_stage_assignees.pack_team).toBeFalsy();

    // Slot is now owned by 579 — a different admin editing RM again must NOT steal it.
    const otherAdminReq = { user: { id: 999, role: 'super_admin', email: 'other-admin@example.com' } };
    await applyPrSectionChangeEffects(otherAdminReq, product, { rm: true, pm: false });
    await product.reload();
    expect(product.approval_stage_assignees.rm_team.user_id).toBe(579);
  });

  test('non-admin editor claims an open Pack slot; RM slot untouched by a pm-only change', async () => {
    if (!dbAvailable) return;
    const product = await Product.create({
      zoho_sku_code: 'SKU-PRTRACK-USER-001',
      product_name: 'Test PR Track Product (non-admin claim)',
      status: 'Draft',
      approval_stage_assignees: { rm_team: null, pack_team: null },
    });
    createdIds.push(product.product_id);

    const req = { user: { id: 42, role: 'user', email: 'packuser@example.com' } };
    await applyPrSectionChangeEffects(req, product, { rm: false, pm: true });
    await product.reload();

    expect(product.approval_stage_assignees.pack_team).toBeTruthy();
    expect(product.approval_stage_assignees.pack_team.user_id).toBe(42);
    expect(product.approval_stage_assignees.rm_team).toBeFalsy();
  });

  test('touching both sections in one edit claims both open slots for the same editor', async () => {
    if (!dbAvailable) return;
    const product = await Product.create({
      zoho_sku_code: 'SKU-PRTRACK-BOTH-001',
      product_name: 'Test PR Track Product (both sections)',
      status: 'Draft',
      approval_stage_assignees: { rm_team: null, pack_team: null },
    });
    createdIds.push(product.product_id);

    const req = { user: { id: 7, role: 'user', email: 'both@example.com' } };
    await applyPrSectionChangeEffects(req, product, { rm: true, pm: true });
    await product.reload();

    expect(product.approval_stage_assignees.rm_team.user_id).toBe(7);
    expect(product.approval_stage_assignees.pack_team.user_id).toBe(7);
  });
});

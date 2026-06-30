/**
 * BD Management routes — mounted at `${apiPrefix}/bd` (see app.js).
 * `isAuthenticated` is also applied at the mount; kept here for explicitness and
 * parity with sibling routers. Literal paths precede the `:code` param route.
 *
 * NOTE: a `requireModule('bd', …)` guard can be added once the BD module key is
 * registered in the permission system (see BD_BUILD_PLAN.md open items).
 */
const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middleware/security');
const ctrl = require('./controller');
const txn = require('./txnController');

router.get('/customers', isAuthenticated, ctrl.listCustomers);
router.get('/customers/:code/timeline', isAuthenticated, ctrl.getTimeline);
router.post('/customers/:code/events', isAuthenticated, ctrl.addEvent);
router.put('/customers/:code/profile', isAuthenticated, ctrl.updateProfile);

/* ── Phase 2: per-customer create endpoints (literal segments, before :code) ─ */
router.post('/customers/:code/queries', isAuthenticated, txn.createQuery);
router.post('/customers/:code/grievances', isAuthenticated, txn.createGrievance);
router.post('/customers/:code/meetings', isAuthenticated, txn.createMeeting);
router.get('/customers/:code', isAuthenticated, ctrl.getCustomer);

/* ── Phase 2: cross-client queues (§3F / §3G / §3H, §8) ─────────────────── */
// Queries
router.get('/queries', isAuthenticated, txn.listQueries);
router.post('/queries', isAuthenticated, txn.createQuery);
router.get('/queries/:id', isAuthenticated, txn.getQuery);
router.post('/queries/:id/transition', isAuthenticated, txn.transitionQuery);

// Grievances
router.get('/grievances', isAuthenticated, txn.listGrievances);
router.post('/grievances', isAuthenticated, txn.createGrievance);
router.get('/grievances/:id', isAuthenticated, txn.getGrievance);
router.post('/grievances/:id/transition', isAuthenticated, txn.transitionGrievance);

// Meetings
router.get('/meetings', isAuthenticated, txn.listMeetings);
router.post('/meetings', isAuthenticated, txn.createMeeting);
router.get('/meetings/:id', isAuthenticated, txn.getMeeting);
router.post('/meetings/:id/transition', isAuthenticated, txn.transitionMeeting);
router.post('/meetings/:id/initiate-followup', isAuthenticated, txn.initiateFollowup);

module.exports = router;

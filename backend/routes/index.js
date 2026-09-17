/**
 * Central route aggregator.
 * Convention: /api/v1/<actor>/<resource>
 * Mount each module's router here after verifyToken + role() guards.
 *
 * Example:
 *   const userRoutes = require('../modules/user/routes/userRoutes');
 *   router.use('/admin/users', verifyToken, role('admin'), userRoutes);
 */
const express     = require('express');
const router      = express.Router();
const verifyToken = require('../middleware/verifyToken');
const role        = require('../middleware/role');

// ── Auth (public endpoints — no verifyToken) ───────────────────────────────────
const authRoutes = require('../modules/auth/routes/authRoutes');
router.use('/common/auth', authRoutes);

// ── Organizations / multi-tenancy (authenticated; tenant guard is per-route) ──
const organizationRoutes = require('../modules/organizations/routes/organizationRoutes');
router.use('/orgs', verifyToken, organizationRoutes);

// ── Files (tenant-owned object storage; org-scoped) ────────────────────────────
const fileRoutes = require('../modules/files/routes/fileRoutes');
router.use('/orgs/:orgId/files', verifyToken, fileRoutes);

// ── Notifications (user-scoped — verifyToken only, no tenantContext) ──────────
const notificationRoutes = require('../modules/notifications/routes/notificationRoutes');
router.use('/common/notifications', verifyToken, notificationRoutes);

// ── Billing (org-scoped; /orgs/:orgId/billing/*) ──────────────────────────────
// Mounted at the same '/orgs' prefix as organizationRoutes rather than inside
// it: two routers on one path is how Express is meant to be used, and it keeps
// the billing module from editing the organizations module's files.
// The Stripe webhook is NOT here — it needs the raw body and is mounted in
// server.js ahead of express.json().
const billingRoutes = require('../modules/billing/routes/billingRoutes');
router.use('/orgs', verifyToken, billingRoutes);

// ── Platform administration (NOT tenant-scoped) ───────────────────────────────
// Account suspension disables a human across every organization, so it is guarded
// by the global User.role and restricted to superAdmin — self-serve signups get
// role 'admin' (AuthService.SIGNUP_ROLE), which must NOT be able to suspend anyone.
const userRoutes = require('../modules/users/routes/userRoutes');
router.use('/admin/users', verifyToken, role('superAdmin'), userRoutes);

// ── Add your product's modules below ──────────────────────────────────────────
// const exampleRoutes = require('../modules/example/routes/exampleRoutes');
// router.use('/admin/example', verifyToken, role('admin'), exampleRoutes);

module.exports = router;

/**
 * Billing routes. Mounted at /api/v1/orgs behind verifyToken (routes/index.js),
 * alongside — not inside — organizationRoutes, so the two modules never edit the
 * same file.
 *
 * GET  /orgs/:orgId/billing           current plan + catalogue   (any member)
 * POST /orgs/:orgId/billing/checkout  start an upgrade           (owner/admin)
 * POST /orgs/:orgId/billing/portal    manage/cancel at Stripe    (owner/admin)
 * GET  /orgs/:orgId/billing/invoices  recent invoices            (owner/admin)
 *
 * The Stripe webhook is NOT here: it is not org-scoped and not authenticated by
 * a JWT — see routes/stripeWebhookRoutes.js, mounted in server.js.
 *
 * PERMISSIONS — reading the plan is `org:access` (a viewer must be able to see
 * why a feature is locked). Everything that touches money or opens a session
 * that can change money is `billing:manage` = owner/admin, deliberately the same
 * set as members:manage. Invoices are owner/admin too: amounts billed are not
 * information every viewer needs.
 */
const express = require('express');
const router  = express.Router();
const tenantContext = require('../../../middleware/tenantContext');
const { requireOrgRole } = require('../../../middleware/requireOrgRole');
const { validateBody, z } = require('../../../middleware/validate');
const {
  getBilling,
  createCheckout,
  createPortal,
  listInvoices,
} = require('../services/BillingService');

const BILLING_MANAGE = ['owner', 'admin'];

// The plan is named by its stable key; the price and the Stripe price id are
// read server-side from the Plan row. A client can never influence an amount.
const checkoutSchema = z.object({
  planKey: z.string().trim().min(1).max(50),
});

router.get('/:orgId/billing',
  tenantContext, requireOrgRole('owner', 'admin', 'member', 'viewer'),
  getBilling);

router.post('/:orgId/billing/checkout',
  tenantContext, requireOrgRole(...BILLING_MANAGE),
  validateBody(checkoutSchema), createCheckout);

router.post('/:orgId/billing/portal',
  tenantContext, requireOrgRole(...BILLING_MANAGE),
  createPortal);

router.get('/:orgId/billing/invoices',
  tenantContext, requireOrgRole(...BILLING_MANAGE),
  listInvoices);

module.exports = router;

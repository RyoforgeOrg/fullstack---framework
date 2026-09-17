/**
 * Billing service — the org-facing half of billing (read plan, start checkout,
 * open the portal, list invoices). The Stripe-facing half (webhooks) lives in
 * StripeWebhookService.js.
 *
 * Tenant boundary: every handler here runs behind verifyToken + tenantContext,
 * so req.organizationId is already proven. Subscription is tenant-owned but is
 * keyed 1:1 on organizationId, so `findUnique({ where: { organizationId } })` IS
 * the tenant filter — scopedWhere() adds nothing to a lookup whose only key is
 * the tenant id. Any future multi-row billing table (usage records, credits)
 * must go through scopedWhere().
 *
 * NOTHING here trusts the client for money. The plan is chosen by its `key` and
 * the price id is read from the Plan row — a caller cannot pass a stripePriceId,
 * an amount, or a currency.
 */
const prisma      = require('../../../config/dbConnect');
const apiResponse = require('../../../helpers/apiResponse');
const { auditLogger } = require('../../../helpers/auditLogger');
const { getBillingProvider } = require('../../../helpers/billingProvider');
const { ENTITLED_STATUSES, FREE_PLAN_KEY } = require('../../../helpers/entitlements');

const publicPlan = (plan) => ({
  key:               plan.key,
  name:              plan.name,
  priceMonthlyCents: plan.priceMonthlyCents,
  features:          plan.features || {},
});

const publicSubscription = (sub) => ({
  status:           sub.status,
  currentPeriodEnd: sub.currentPeriodEnd,
  trialEndsAt:      sub.trialEndsAt,
  // Whether the org is currently entitled to its plan, as opposed to merely
  // pointing at it — the UI renders "past due, access reduced" off this.
  entitled:         ENTITLED_STATUSES.has(sub.status),
  // Only whether a Stripe customer exists, never the id itself: the portal and
  // checkout endpoints resolve it server-side, and leaking cus_* ids to the
  // browser buys nothing.
  hasPaymentAccount: !!sub.stripeCustomerId,
  plan:             publicPlan(sub.plan),
});

function appUrl(path) {
  const base = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim();
  return `${base}${path}`;
}

async function loadSubscription(organizationId) {
  return prisma.subscription.findUnique({
    where:   { organizationId },
    include: { plan: true },
  });
}

// ── GET /orgs/:orgId/billing — any active member ─────────────────────────────
// Readable by viewers too: "which plan are we on / why is this feature locked"
// is information every member needs. Nothing here is a payment detail.
async function getBilling(req, res) {
  const subscription = await loadSubscription(req.organizationId);
  if (!subscription) {
    return apiResponse.send(res, 'NOT_FOUND', { message: 'This organization has no subscription record.' });
  }

  const plans = await prisma.plan.findMany({ orderBy: { priceMonthlyCents: 'asc' } });

  return apiResponse.send(res, 'SUCCESS', {
    subscription:    publicSubscription(subscription),
    availablePlans:  plans.map(publicPlan),
  });
}

// ── POST /orgs/:orgId/billing/checkout — owner/admin ─────────────────────────
async function createCheckout(req, res) {
  const { planKey } = req.body;

  if (planKey === FREE_PLAN_KEY) {
    return apiResponse.send(res, 'INVALID_REQUEST', {
      message: 'The free plan has nothing to check out. Cancel the paid plan in the billing portal instead.',
    });
  }

  const plan = await prisma.plan.findUnique({ where: { key: planKey } });
  if (!plan) return apiResponse.send(res, 'NOT_FOUND', { message: 'Unknown plan.' });
  if (!plan.stripePriceId) {
    // A paid plan with no price id is a deployment that has not been pointed at
    // its Stripe products yet — an operator error, not a client error.
    return apiResponse.send(res, 'SERVICE_UNAVAILABLE', {
      message: 'That plan is not available for purchase yet.',
    });
  }

  const subscription = await loadSubscription(req.organizationId);
  if (subscription.planId === plan.id && ENTITLED_STATUSES.has(subscription.status)) {
    return apiResponse.send(res, 'CONFLICT', { message: 'Your organization is already on that plan.' });
  }

  const session = await getBillingProvider().createCheckoutSession({
    organizationId: req.organizationId,
    planKey:        plan.key,
    priceId:        plan.stripePriceId,
    customerId:     subscription.stripeCustomerId || null,
    customerEmail:  req.user.email,
    successUrl:     appUrl('/billing?checkout=success'),
    cancelUrl:      appUrl('/billing?checkout=cancelled'),
  });

  // NOT marked active here. The redirect only means the user reached Stripe;
  // the subscription becomes real when checkout.session.completed arrives. A
  // client that never finishes paying must not end up entitled.
  await auditLogger('BILLING_CHECKOUT_STARTED', req.user, req);
  return apiResponse.send(res, 'CREATED', { checkout: { id: session.id, url: session.url } });
}

// ── POST /orgs/:orgId/billing/portal — owner/admin ───────────────────────────
async function createPortal(req, res) {
  const subscription = await loadSubscription(req.organizationId);
  if (!subscription?.stripeCustomerId) {
    return apiResponse.send(res, 'INVALID_REQUEST', {
      message: 'This organization has never been billed — there is nothing to manage yet.',
    });
  }

  const session = await getBillingProvider().createPortalSession({
    customerId: subscription.stripeCustomerId,
    returnUrl:  appUrl('/billing'),
  });

  await auditLogger('BILLING_PORTAL_OPENED', req.user, req);
  return apiResponse.send(res, 'CREATED', { portal: { id: session.id, url: session.url } });
}

// ── GET /orgs/:orgId/billing/invoices — owner/admin ──────────────────────────
// Reads straight through to Stripe rather than mirroring invoices locally: an
// invoice's amount, status and PDF are Stripe's record, and a stale local copy
// of a financial document is worse than one extra API call on a page nobody
// loads in a hot path.
async function listInvoices(req, res) {
  const subscription = await loadSubscription(req.organizationId);
  if (!subscription?.stripeCustomerId) {
    return apiResponse.send(res, 'SUCCESS', { invoices: [] });
  }

  const invoices = await getBillingProvider().listInvoices({ customerId: subscription.stripeCustomerId });
  return apiResponse.send(res, 'SUCCESS', { invoices });
}

// ── Org-creation hook ────────────────────────────────────────────────────────
/**
 * Give a brand-new organization its free-plan subscription.
 *
 * Called from OrganizationService.createOrganization as a SINGLE line inside its
 * existing transaction, so an org can never exist without a subscription row and
 * every entitlement lookup has something to read.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx  the caller's
 *        transaction client — NOT the global prisma. Passing it in keeps this a
 *        one-line call site and makes the two writes atomic together.
 * @param {string} organizationId
 */
async function createFreeSubscription(tx, organizationId) {
  const free = await tx.plan.findUnique({ where: { key: FREE_PLAN_KEY } });
  // The free plan is seeded by migration; if it is missing the database is
  // mis-migrated and failing the org creation loudly beats creating an org that
  // silently has no entitlements at all.
  if (!free) throw new Error('Plan "free" is missing — run the billing migration (seeds the plan catalogue)');

  return tx.subscription.create({
    data: { organizationId, planId: free.id, status: 'active' },
  });
}

module.exports = {
  getBilling,
  createCheckout,
  createPortal,
  listInvoices,
  createFreeSubscription,
};

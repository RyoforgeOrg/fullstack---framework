/**
 * Stripe webhook processing — the Stripe-facing half of billing.
 *
 * processStripeEvent(event) takes an ALREADY-VERIFIED event object and is pure
 * database logic: no SDK, no network, no request object. That separation is
 * what makes the hard part testable offline — signature verification is proven
 * once in helpers/billingProvider.js, and every ordering/replay scenario below
 * is driven by handing this function plain JSON.
 *
 * ── DELIVERY GUARANTEES STRIPE ACTUALLY GIVES ────────────────────────────────
 * At-least-once, in no particular order. Both must be defended against, and
 * they need DIFFERENT defences:
 *
 *   1. REPLAY (same event, twice) → ProcessedWebhookEvent, primary-keyed on
 *      Stripe's event id. The INSERT *is* the claim: the second delivery hits
 *      the PK conflict and returns before any state is touched. It runs in the
 *      SAME transaction as the state change, so a handler that throws rolls the
 *      claim back too and Stripe's retry is free to try again — a claim
 *      committed separately from its effect would swallow the event forever.
 *      Chosen over a Redis SET because exactly-once must survive a Redis flush
 *      and must be transactional with the write it guards.
 *
 *   2. OUT-OF-ORDER (older event, delivered later) → a per-subscription
 *      watermark, Subscription.lastEventAt, holding the `created` timestamp of
 *      the newest event already applied. An event older than the watermark is
 *      CLAIMED (so it stops being retried) but does not mutate state. Without
 *      it, a redelivered `invoice.payment_failed` from Tuesday would knock a
 *      subscription the org fixed on Wednesday back to past_due — "last write
 *      wins" is precisely the wrong rule for money.
 *
 *      `customer.subscription.deleted` is the ONE exception: cancellation is
 *      terminal, so it applies regardless of the watermark. There is no later
 *      event that un-deletes a subscription — a re-subscribe arrives as a new
 *      subscription id — so honouring a stale `active` over a delete would leave
 *      a cancelled org entitled.
 *
 * Unrecognised event types are claimed and ignored: Stripe sends many more types
 * than any app subscribes to, and answering 200 stops it retrying them.
 */
const prisma = require('../../../config/dbConnect');
const logger = require('../../../config/logger');
const { FREE_PLAN_KEY } = require('../../../helpers/entitlements');
const { getBillingProvider } = require('../../../helpers/billingProvider');

const HANDLED_TYPES = new Set([
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
]);

const unixToDate = (seconds) => (seconds ? new Date(seconds * 1000) : null);

/**
 * Locate the tenant an event belongs to, cheapest and most reliable key first.
 *
 *   1. stripeSubscriptionId — set once checkout completes; the strongest link.
 *   2. metadata.organizationId / client_reference_id — the only key available on
 *      the very first checkout.session.completed, before any local id exists.
 *   3. stripeCustomerId — the fallback for invoice events, which name a customer
 *      but may reference a subscription this app has not recorded yet.
 */
async function resolveSubscription(tx, object) {
  const subscriptionId =
    typeof object.subscription === 'string' ? object.subscription
      : (object.object === 'subscription' ? object.id : null);

  if (subscriptionId) {
    const bySubscription = await tx.subscription.findUnique({ where: { stripeSubscriptionId: subscriptionId } });
    if (bySubscription) return bySubscription;
  }

  const organizationId = object.metadata?.organizationId || object.client_reference_id;
  if (organizationId) {
    const byOrg = await tx.subscription.findUnique({ where: { organizationId } });
    if (byOrg) return byOrg;
  }

  const customerId = typeof object.customer === 'string' ? object.customer : object.customer?.id;
  if (customerId) {
    // findFirst, not findUnique: stripeCustomerId is indexed but NOT unique —
    // re-creating a customer for the same org is a normal Stripe support action.
    return tx.subscription.findFirst({ where: { stripeCustomerId: customerId } });
  }

  return null;
}

async function resolvePlanId(tx, { planKey, priceId, fallbackPlanId }) {
  if (planKey) {
    const byKey = await tx.plan.findUnique({ where: { key: planKey } });
    if (byKey) return byKey.id;
  }
  if (priceId) {
    const byPrice = await tx.plan.findFirst({ where: { stripePriceId: priceId } });
    if (byPrice) return byPrice.id;
  }
  // Neither key resolved — keep the org where it is rather than guessing a plan.
  // A status sync is still worth applying even when the plan cannot be named.
  return fallbackPlanId;
}

const priceIdFrom = (subscriptionObject) => subscriptionObject.items?.data?.[0]?.price?.id || null;

/**
 * @param {object} event  a verified Stripe event
 * @returns {Promise<{status: string, reason?: string, organizationId?: string}>}
 *   status is one of: 'processed' | 'duplicate' | 'ignored' | 'stale' | 'unmatched'
 *   — returned rather than thrown so the route can answer 200 to every one of
 *   them (they are all "do not retry this") and log the difference.
 */
async function processStripeEvent(event) {
  const eventAt = unixToDate(event.created) || new Date();
  const object  = event.data?.object || {};

  return prisma.$transaction(async (tx) => {
    try {
      await tx.processedWebhookEvent.create({ data: { eventId: event.id, type: event.type } });
    } catch (error) {
      if (error.code === 'P2002') return { status: 'duplicate' };
      throw error;
    }

    if (!HANDLED_TYPES.has(event.type)) return { status: 'ignored' };

    const subscription = await resolveSubscription(tx, object);
    if (!subscription) {
      // Claimed anyway: retrying will not make a tenant appear, and an event for
      // an organization that has since been deleted is expected, not an error.
      return { status: 'unmatched' };
    }

    const isTerminalCancel = event.type === 'customer.subscription.deleted';
    if (!isTerminalCancel && subscription.lastEventAt && eventAt < subscription.lastEventAt) {
      return { status: 'stale', organizationId: subscription.organizationId };
    }

    const data = await buildUpdate(tx, event, object, subscription);
    await tx.subscription.update({
      where: { id: subscription.id },
      // The watermark advances only to the newest timestamp seen. A terminal
      // cancel applied out of order must not drag it backwards and re-open the
      // door for the older events it just overtook.
      data:  { ...data, lastEventAt: maxDate(subscription.lastEventAt, eventAt) },
    });

    return { status: 'processed', organizationId: subscription.organizationId };
  });
}

function maxDate(a, b) {
  if (!a) return b;
  return a > b ? a : b;
}

async function buildUpdate(tx, event, object, subscription) {
  switch (event.type) {
    // Payment succeeded and the subscription exists at Stripe. This is the only
    // place a paid plan is ever granted — never the checkout endpoint, which
    // only knows the user reached the payment page.
    case 'checkout.session.completed': {
      const planId = await resolvePlanId(tx, {
        planKey:        object.metadata?.planKey,
        fallbackPlanId: subscription.planId,
      });
      return {
        planId,
        status:               'active',
        stripeCustomerId:     typeof object.customer === 'string' ? object.customer : subscription.stripeCustomerId,
        stripeSubscriptionId: typeof object.subscription === 'string' ? object.subscription : subscription.stripeSubscriptionId,
      };
    }

    // Status/period/plan sync — renewals, upgrades, downgrades, trial expiry,
    // recovery from past_due. object.status is copied verbatim, which is why the
    // local enum mirrors Stripe's vocabulary.
    case 'customer.subscription.updated': {
      const planId = await resolvePlanId(tx, {
        planKey:        object.metadata?.planKey,
        priceId:        priceIdFrom(object),
        fallbackPlanId: subscription.planId,
      });
      return {
        planId,
        status:           object.status,
        currentPeriodEnd: unixToDate(object.current_period_end) ?? subscription.currentPeriodEnd,
        trialEndsAt:      unixToDate(object.trial_end),
        stripeCustomerId: typeof object.customer === 'string' ? object.customer : subscription.stripeCustomerId,
        stripeSubscriptionId: object.id || subscription.stripeSubscriptionId,
      };
    }

    // Downgrade to free. stripeCustomerId is KEPT so the billing portal still
    // opens (past invoices, re-subscribe); stripeSubscriptionId is cleared
    // because that subscription no longer exists and holding it would make the
    // unique index collide with a future re-subscribe.
    case 'customer.subscription.deleted': {
      const free = await tx.plan.findUnique({ where: { key: FREE_PLAN_KEY } });
      return {
        planId:               free ? free.id : subscription.planId,
        status:               'canceled',
        stripeSubscriptionId: null,
        currentPeriodEnd:     null,
        trialEndsAt:          null,
      };
    }

    // Dunning has begun. Entitlements degrade to free immediately (see
    // helpers/entitlements.js) while the row keeps pointing at the paid plan, so
    // the UI can say what is at risk and a later successful retry arrives as
    // customer.subscription.updated → active and restores access with no
    // further action.
    case 'invoice.payment_failed':
      return { status: 'past_due' };

    default:
      return {};
  }
}

/**
 * Route handler. Mounted in server.js BEFORE express.json() with
 * express.raw({ type: 'application/json' }) — req.body must be the exact bytes
 * Stripe signed or the HMAC cannot match.
 *
 * Responses are bare JSON, NOT the apiResponse envelope: this endpoint answers
 * Stripe's retry machinery, not a client of this API, and Stripe reads only the
 * HTTP status. 400 = never retry (bad signature). 500 = please retry.
 */
async function handleStripeWebhook(req, res) {
  let event;
  try {
    event = getBillingProvider().verifyWebhookSignature(req.body, req.headers['stripe-signature']);
  } catch (error) {
    logger.warn({ err: error.message }, 'stripe webhook: signature verification failed');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Deliberately NOT wrapped in try/catch: a genuine failure (database down)
  // must surface as a 500 through the Express error handler so Stripe retries.
  // Swallowing it and answering 200 would lose the event permanently.
  const result = await processStripeEvent(event);

  logger.info({ eventId: event.id, type: event.type, result: result.status }, 'stripe webhook');
  return res.status(200).json({ received: true, status: result.status });
}

module.exports = { processStripeEvent, handleStripeWebhook, HANDLED_TYPES };

/**
 * Plan entitlements — "is this organization allowed to do X, and up to what
 * limit?" Answered from the org's Subscription → Plan.features JSON.
 *
 * Usage in a route (mirrors requireOrgRole's position in the chain):
 *   router.post('/:orgId/files',
 *     verifyToken, tenantContext, requireEntitlement('apiAccess'), handler);
 *
 * And imperatively, for a numeric limit you have to compare a count against:
 *   const max = await checkEntitlement(req.organizationId, 'maxMembers');
 *   if (max !== UNLIMITED && currentCount >= max) return send(res, 'FORBIDDEN', …);
 *
 * ── CONVENTIONS ──────────────────────────────────────────────────────────────
 * - A feature key ABSENT from the plan's features map is DENIED (false / 0), not
 *   allowed. Fail closed: adding a new gated feature must not silently grant it
 *   to every existing plan row until someone remembers to edit the JSON.
 * - A numeric limit of -1 (UNLIMITED) means no cap. Chosen over null/Infinity
 *   because it survives JSON and Postgres jsonb round-tripping unambiguously.
 * - A subscription in a non-paying status (past_due / canceled / incomplete)
 *   is entitled to the FREE plan's features, not to the plan it stopped paying
 *   for. The Subscription row keeps pointing at the paid plan (so the UI can say
 *   "your Pro subscription is past due" and Stripe's dunning can recover it),
 *   but access degrades immediately. `trialing` counts as paying — that is the
 *   entire point of a trial.
 */
const prisma = require('../config/dbConnect');
const apiResponse = require('./apiResponse');

const UNLIMITED = -1;

const ENTITLED_STATUSES = new Set(['active', 'trialing']);

const FREE_PLAN_KEY = 'free';

/**
 * @param {string} organizationId
 * @param {string} featureKey
 * @returns {Promise<boolean|number>} the boolean capability or numeric limit;
 *          false / 0-style denial when the plan does not carry the key.
 */
async function checkEntitlement(organizationId, featureKey) {
  const features = await effectiveFeatures(organizationId);
  const value = features[featureKey];
  // Absent → denied. `undefined` is the only "not configured" signal; a plan that
  // means "no" states it as false or 0.
  return value === undefined ? false : value;
}

/**
 * The feature map actually in force for an org right now, after the
 * non-paying-status downgrade. Exported because a settings/billing screen wants
 * the whole map, not one key at a time.
 */
async function effectiveFeatures(organizationId) {
  const subscription = await prisma.subscription.findUnique({
    where:   { organizationId },
    include: { plan: true },
  });

  // No subscription row at all should be impossible (every org gets one at
  // creation), but an org created by a parallel path or restored from an old
  // backup must degrade to free rather than throw inside a request.
  if (!subscription) return freePlanFeatures();
  if (!ENTITLED_STATUSES.has(subscription.status)) return freePlanFeatures();

  return subscription.plan.features || {};
}

let cachedFreeFeatures = null;
async function freePlanFeatures() {
  // The free plan's contents are seeded by migration and effectively immutable
  // at runtime, so caching the row for the process lifetime avoids a DB hit on
  // every downgraded entitlement check. Restart the process after editing it.
  if (!cachedFreeFeatures) {
    const free = await prisma.plan.findUnique({ where: { key: FREE_PLAN_KEY } });
    cachedFreeFeatures = free?.features || {};
  }
  return cachedFreeFeatures;
}

/**
 * Route guard. Runs AFTER tenantContext (needs req.organizationId).
 * Passes when the feature is `true`, or a numeric limit that is non-zero
 * (UNLIMITED included) — i.e. the org may use the feature at all. A guard cannot
 * know the org's current usage, so enforcing "you have 25 of 25 members" stays
 * the handler's job via checkEntitlement().
 */
function requireEntitlement(featureKey) {
  return async (req, res, next) => {
    const value = await checkEntitlement(req.organizationId, featureKey);
    const allowed = value === true || (typeof value === 'number' && value !== 0);
    if (!allowed) {
      return apiResponse.send(res, 'FORBIDDEN', {
        message: 'Your organization\'s plan does not include this feature.',
        feature: featureKey,
        upgradeRequired: true,
      });
    }
    req.entitlement = value;
    return next();
  };
}

module.exports = {
  checkEntitlement,
  effectiveFeatures,
  requireEntitlement,
  UNLIMITED,
  ENTITLED_STATUSES,
  FREE_PLAN_KEY,
  // Tests seed plans after the process starts; without this the memoised free
  // features would be captured from a database state that no longer exists.
  _resetFreePlanCache: () => { cachedFreeFeatures = null; },
};

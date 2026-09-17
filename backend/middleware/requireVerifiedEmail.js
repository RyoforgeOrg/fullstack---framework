/**
 * Email-verification gate. Runs AFTER verifyToken (reads req.user.emailVerifiedAt,
 * which verifyToken populates from the CURRENT DB row, never from the JWT — so
 * verifying takes effect on the very next request).
 *
 * ── PRODUCT DECISION (flip it here, in one place) ────────────────────────────
 * An unverified email does NOT block login. It blocks the first action that
 * assumes a real, reachable human behind the account: creating an organization.
 *
 * Why not block login:
 *   - Login is where an invited user lands, and an invitee must be able to sign
 *     in and accept their invitation; the inviter already vouched for the address.
 *   - A hard login block strands anyone whose verification email bounced behind a
 *     screen with no way forward, and turns a mail-delivery outage into a total
 *     outage.
 *   - The existing integration suite seeds users straight into Postgres. Gating
 *     login would mean every seeded fixture in every suite needs an
 *     emailVerifiedAt, which is exactly the kind of coupling a scaffold should
 *     not impose on the products built on it.
 *
 * Why organization creation IS gated: an org is a durable, shareable, invite-
 * sending tenant. An unverified account creating one is how a throwaway address
 * turns into a spam relay (invitations are sent from it).
 *
 * To make this product stricter, add the middleware to more routes. To make it
 * block login instead, add the same emailVerifiedAt check to AuthService.login —
 * nothing else in the codebase depends on this middleware's placement.
 */
const apiResponse = require('../helpers/apiResponse');

function requireVerifiedEmail(req, res, next) {
  if (!req.user.emailVerifiedAt) {
    return apiResponse.send(res, 'FORBIDDEN', {
      message: 'Confirm your email address before performing this action.',
      emailVerificationRequired: true,
    });
  }
  return next();
}

module.exports = requireVerifiedEmail;

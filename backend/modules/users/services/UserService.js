/**
 * Platform user administration.
 *
 * SCOPE — this is a PLATFORM-level surface, not a tenant one. Suspending an
 * account disables the human everywhere, across every organization they belong
 * to, so it is guarded by middleware/role.js (the global User.role) and NOT by
 * requireOrgRole / tenantContext. An organization owner who wants to cut off
 * someone's access to THEIR org removes the membership instead
 * (PATCH /orgs/:orgId/members/:membershipId).
 */
const prisma      = require('../../../config/dbConnect');
const apiResponse = require('../../../helpers/apiResponse');
const { auditLogger } = require('../../../helpers/auditLogger');

const publicUser = (user) => ({
  id:              user.id,
  name:            user.name,
  email:           user.email,
  userName:        user.userName,
  role:            user.role,
  active:          user.active,
  emailVerifiedAt: user.emailVerifiedAt,
  lastLoginAt:     user.lastLoginAt,
  createdAt:       user.createdAt,
});

// ── PATCH /admin/users/:userId/status ─────────────────────────────────────────
// Suspension has to bite IMMEDIATELY, not when the victim's 24h JWT expires, so
// it does three things in one transaction:
//   1. active = false            — verifyToken rejects on the very next request,
//                                  and helpers/ws/hub.js validateIdentity rejects
//                                  the same way on connect / subscribe / its
//                                  periodic re-check, closing live sockets.
//   2. tokenVersion bump         — belt and braces: every issued access token is
//                                  invalid even if a future code path stops
//                                  checking `active`.
//   3. revoke all refresh tokens — so nothing can be traded for a new access
//                                  token, and reactivation does not silently
//                                  resurrect week-old sessions.
// lockUserRow's transaction discipline is not repeated here: revoking inside the
// same transaction as the tokenVersion bump is enough, because a concurrent
// /refresh re-reads the user row inside ITS transaction and rejects on !active.
async function setUserStatus(req, res) {
  const { active } = req.body;
  const { userId } = req.params;

  if (userId === req.user.id) {
    return apiResponse.send(res, 'FORBIDDEN', { message: 'You cannot change your own account status.' });
  }

  const target = await prisma.user.findFirst({ where: { id: userId, isDeleted: false } });
  if (!target) return apiResponse.send(res, 'NOT_FOUND', { message: 'User not found.' });

  const updated = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: userId },
      data:  { active, tokenVersion: { increment: 1 } },
    });
    await tx.refreshToken.updateMany({ where: { userId, revoked: false }, data: { revoked: true } });
    return user;
  });

  await auditLogger(active ? 'USER_REACTIVATED' : 'USER_SUSPENDED', req.user, req);
  return apiResponse.send(res, 'SUCCESS', { user: publicUser(updated) });
}

module.exports = { setUserStatus };

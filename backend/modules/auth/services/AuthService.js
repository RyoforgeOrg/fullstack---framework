/**
 * Authentication service — login, token refresh, logout, /me, profile update,
 * forgot-password, reset-password.
 *
 * Implements: refresh-token rotation, tokenVersion invalidation,
 * account lockout after 5 failed attempts, hashed refresh token storage.
 *
 * To add product-specific fields to the JWT or /me payload, extend buildUserPayload().
 * To add product-level checks in login (e.g. tenant status, plan limits), extend login().
 */
const prisma      = require('../../../config/dbConnect');
const { client }  = require('../../../config/redisConfig');
const apiResponse = require('../../../helpers/apiResponse');
const { generateToken, generateRefreshToken } = require('../../../helpers/generateToken');
const { auditLogger } = require('../../../helpers/auditLogger');
const { sendPasswordResetOtp, sendEmailVerification } = require('../../../helpers/emailService');
const { notify }  = require('../../notifications/services/NotificationService'); // A08
const bcrypt      = require('bcrypt');
const crypto      = require('crypto');
const otpGenerator = require('otp-generator');

const MAX_FAILED_ATTEMPTS   = 5;
const LOCK_DURATION_MINS    = 15;
const REFRESH_TTL_DAYS      = 7;
const RESET_OTP_TTL_MINS    = 10;
const MAX_OTP_ATTEMPTS      = 5;
const RESEND_COOLDOWN_SECS  = 60;
const VERIFY_TTL_HOURS      = 24;

// Platform role handed to a self-serve signup. This is the PLATFORM role
// (middleware/role.js), deliberately NOT 'superAdmin': what a signed-up user can
// do inside a tenant is governed by their Membership role (requireOrgRole), and
// platform-admin actions (see modules/users) are reserved for accounts created by
// scripts/createSuperAdmin.js.
const SIGNUP_ROLE = 'admin';

// Email is the Redis key material AND the DB lookup field — normalize once,
// everywhere, so key generation and lookup can never diverge (e.g. " A@B.com"
// hashing an OTP under a different key than the "a@b.com" lookup uses).
const normalizeEmail = (email) => String(email).trim().toLowerCase();

const RESET_OTP_KEY      = (email) => `auth:reset:otp:${email}`;
const RESET_ATTEMPTS_KEY = (email) => `auth:reset:attempts:${email}`;
const RESET_RESEND_KEY   = (email) => `auth:reset:resend:${email}`;
// Email-verification tokens follow the Redis/TTL pattern the reset OTP uses, not
// the Invitation table pattern: like an OTP they are short-lived, single-purpose
// and worthless once consumed, so there is nothing to audit afterwards (the
// emailVerifiedAt column IS the durable record) and the TTL does the cleanup that
// an Invitation row would need a sweeper for. Keyed BY THE TOKEN HASH so the
// emailed link is the whole lookup key — the raw token is never stored, exactly
// like RefreshToken.tokenHash and Invitation.tokenHash.
const VERIFY_TOKEN_KEY   = (tokenHash) => `auth:verify:${tokenHash}`;
const VERIFY_RESEND_KEY  = (email) => `auth:verify:resend:${email}`;

const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

// Atomic GET+compare+DEL: only the first of two concurrent submissions of the
// same OTP can ever see it match, because Redis executes EVAL single-threaded —
// the second invocation runs entirely after the first's DEL has landed.
const CONSUME_OTP_SCRIPT = `
local stored = redis.call('GET', KEYS[1])
if not stored then return 0 end
if stored == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

async function consumeOtp(key, expectedHash) {
  const result = await client.eval(CONSUME_OTP_SCRIPT, { keys: [key], arguments: [expectedHash] });
  return result === 1;
}

// httpOnly refresh-token cookie (F11). SameSite is configurable because whether
// the frontend/backend share a parent domain is a per-deployment decision — set
// REFRESH_COOKIE_SAMESITE=strict in prod when frontend/API share a parent domain,
// or 'none' when they're fully cross-site (requires Secure, which is forced below
// outside development anyway).
const REFRESH_COOKIE_NAME = 'refreshToken';
const refreshCookieOptions = () => ({
  httpOnly:  true,
  secure:    process.env.NODE_ENV === 'production',
  sameSite:  process.env.REFRESH_COOKIE_SAMESITE || 'lax',
  path:      '/api/v1/common/auth',
  maxAge:    REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
});

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions());
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE_NAME, { ...refreshCookieOptions(), maxAge: undefined });
}

// Burn a real bcrypt compare when the user doesn't exist so response timing does
// not leak whether an account exists (unknown-user vs wrong-password must be ~equal).
const DUMMY_HASH = bcrypt.hashSync('framework-dummy-password', 12);

// ── Payload builder — extend this in your product ─────────────────────────────
function buildUserPayload(user) {
  return {
    id:          user.id,
    name:        user.name,
    email:       user.email,
    phone:       user.phone || null,
    role:        user.role,
    accessLevel: user.accessLevel,
    // Exposed (rather than gating login) so the UI can prompt for verification —
    // see middleware/requireVerifiedEmail.js for the full product decision.
    emailVerifiedAt: user.emailVerifiedAt || null,
  };
}

async function storeRefreshToken(userId, token, req, db = prisma, lastUsedAt = null) {
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.refreshToken.create({
    data: {
      userId,
      tokenHash:  hashToken(token),
      deviceInfo: req.headers['user-agent']?.slice(0, 255) || null,
      ipAddress:  req.ip || null,
      expiredAt:  expiresAt,
      lastUsedAt,
    },
  });
}

// ── Login ─────────────────────────────────────────────────────────────────────
async function login(req, res) {
  try {
    const { userName, password } = req.body;

    if (!userName || !password) {
      return apiResponse.send(res, 'VALIDATION_ERROR', {
        message: 'Both username and password are required.',
      });
    }

    const user = await prisma.user.findFirst({
      where: { userName, isDeleted: false },
    });

    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH); // timing equalization (anti-enumeration)
      return apiResponse.send(res, 'UNAUTHORIZED', { message: 'Invalid credentials.' });
    }

    // Account lockout
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil((user.lockedUntil - Date.now()) / 60000);
      return apiResponse.send(res, 'TOO_MANY_REQUESTS', {
        message: `Account locked. Try again in ${minutesLeft} minute(s).`,
      });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      // Atomic increment (DB-level SET failedLoginAttempts = failedLoginAttempts + 1)
      // instead of read-then-write, so concurrent failed logins from the same
      // account can't race and under-count (F12).
      const updated = await prisma.user.update({
        where: { id: user.id },
        data:  { failedLoginAttempts: { increment: 1 } },
      });

      if (updated.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
        await prisma.user.update({
          where: { id: user.id },
          data:  { lockedUntil: new Date(Date.now() + LOCK_DURATION_MINS * 60 * 1000) },
        });
      }

      await auditLogger('LOGIN_FAILED', { id: user.id, name: user.name, role: user.role }, req);

      return apiResponse.send(res, 'UNAUTHORIZED', { message: 'Invalid credentials.' });
    }

    if (!user.active) {
      return apiResponse.send(res, 'FORBIDDEN', { message: 'Account is deactivated.' });
    }

    // Reset failed attempts on successful login
    await prisma.user.update({
      where: { id: user.id },
      data:  { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    const accessToken      = generateToken(user);
    const refreshTokenVal  = generateRefreshToken();
    await storeRefreshToken(user.id, refreshTokenVal, req);

    await auditLogger('LOGIN_SUCCESS', user, req);

    // Refresh token is the httpOnly cookie (authoritative, F11). Still echoed in
    // the body for any not-yet-migrated caller, but the frontend must not persist
    // it anywhere — the cookie is the sole source of truth for the browser client.
    setRefreshCookie(res, refreshTokenVal);

    return apiResponse.send(res, 'SUCCESS', {
      token:        accessToken,
      refreshToken: refreshTokenVal,
      user:         buildUserPayload(user),
    });
  } catch (error) {
    console.error('[AuthService.login]', error);
    return apiResponse.send(res, 'SERVER_ERROR');
  }
}

// Locks the user's row for the lifetime of the transaction so a rotation can't
// interleave with a concurrent "revoke all sessions" (logout / password reset):
// whichever transaction acquires the lock first fully completes (claim+insert,
// or revoke-all+tokenVersion bump) before the other proceeds, so the loser
// always observes the winner's final state instead of a half-applied one.
async function lockUserRow(tx, userId) {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
}

// ── Refresh ───────────────────────────────────────────────────────────────────
async function refreshToken(req, res) {
  try {
    // Cookie is authoritative; body fallback kept for any caller not yet migrated
    // to cookie-based refresh (F11).
    const token = req.cookies?.[REFRESH_COOKIE_NAME] || req.body?.refreshToken;
    if (!token) return apiResponse.send(res, 'UNAUTHORIZED');
    const tokenHash = hashToken(token);

    // Opaque token — the token IS the lookup key (hashed). No JWT to verify.
    // Rotation must be a single atomic claim: a conditional updateMany that only
    // flips revoked:false → true for THIS request is the single-use guarantee —
    // a concurrent replay sees claim.count === 0 and gets 401, never a second
    // live replacement token.
    const rotated = await prisma.$transaction(async (tx) => {
      const existing = await tx.refreshToken.findUnique({ where: { tokenHash } });
      if (!existing) return null;

      await lockUserRow(tx, existing.userId);

      const claim = await tx.refreshToken.updateMany({
        where: { id: existing.id, revoked: false, expiredAt: { gt: new Date() } },
        data:  { revoked: true },
      });
      if (claim.count === 0) return null;

      const user = await tx.user.findUnique({ where: { id: existing.userId } });
      if (!user || user.isDeleted || !user.active) return null;

      const newAccessToken  = generateToken(user);
      const newRefreshToken = generateRefreshToken();
      // The replacement row inherits "this device is live right now" — the row it
      // replaces is revoked, so the session list only ever sees this one.
      await storeRefreshToken(user.id, newRefreshToken, req, tx, new Date());

      return { token: newAccessToken, refreshToken: newRefreshToken };
    });

    if (!rotated) return apiResponse.send(res, 'UNAUTHORIZED');
    setRefreshCookie(res, rotated.refreshToken);
    return apiResponse.send(res, 'SUCCESS', rotated);
  } catch (error) {
    console.error('[AuthService.refreshToken]', error);
    return apiResponse.send(res, 'SERVER_ERROR');
  }
}

// ── Logout ────────────────────────────────────────────────────────────────────
async function logout(req, res) {
  try {
    const token = req.cookies?.[REFRESH_COOKIE_NAME] || req.body?.refreshToken;

    await prisma.$transaction(async (tx) => {
      await lockUserRow(tx, req.user.id);

      if (token) {
        await tx.refreshToken.updateMany({
          where: { userId: req.user.id, tokenHash: hashToken(token) },
          data:  { revoked: true },
        });
      }

      // tokenVersion invalidates ALL access tokens — revoke every refresh token
      // too, so "logout all sessions" is actually enforced end-to-end. The user
      // row lock above means this sees (and revokes) any refresh token a
      // concurrent /refresh had just inserted, or blocks until one finishes.
      await tx.refreshToken.updateMany({
        where: { userId: req.user.id, revoked: false },
        data:  { revoked: true },
      });

      await tx.user.update({
        where: { id: req.user.id },
        data:  { tokenVersion: { increment: 1 } },
      });
    });

    clearRefreshCookie(res);

    await auditLogger('LOGOUT', req.user, req);
    return apiResponse.send(res, 'SUCCESS');
  } catch (error) {
    console.error('[AuthService.logout]', error);
    return apiResponse.send(res, 'SERVER_ERROR');
  }
}

// ── Me ────────────────────────────────────────────────────────────────────────
async function me(req, res) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return apiResponse.send(res, 'NOT_FOUND');
    return apiResponse.send(res, 'SUCCESS', buildUserPayload(user));
  } catch (error) {
    console.error('[AuthService.me]', error);
    return apiResponse.send(res, 'SERVER_ERROR');
  }
}

// ── Update profile ────────────────────────────────────────────────────────────
async function updateProfile(req, res) {
  try {
    const { name, phone } = req.body;
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data:  { ...(name ? { name } : {}), ...(phone ? { phone } : {}) },
    });
    await auditLogger('PROFILE_UPDATED', req.user, req);
    return apiResponse.send(res, 'SUCCESS', buildUserPayload(updated));
  } catch (error) {
    console.error('[AuthService.updateProfile]', error);
    return apiResponse.send(res, 'SERVER_ERROR');
  }
}

// ── Forgot password (OTP via email) ───────────────────────────────────────────
async function forgotPassword(req, res) {
  try {
    if (!req.body.email) return apiResponse.send(res, 'VALIDATION_ERROR', { message: 'Email is required.' });
    const email = normalizeEmail(req.body.email);

    // mode: 'insensitive' guards against a pre-existing row whose email wasn't
    // stored lowercase (no migration backfills historical data) — the Redis
    // OTP key below is always built from the normalized form regardless.
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, isDeleted: false },
    });

    // Always return success to avoid user enumeration. When the email does not
    // exist, burn the same time a full OTP issuance would take so response
    // timing does not leak account existence.
    if (user) {
      // Account-level resend cooldown: without this, an attacker who burns the
      // 5-attempt cap can just call forgot-password again to reset the budget
      // and keep grinding the 6-digit OTP indefinitely. IP-based otpSendLimiter
      // stays as an additional layer — this one can't be defeated by IP rotation.
      const onCooldown = await client.get(RESET_RESEND_KEY(email));
      if (!onCooldown) {
        const otp = otpGenerator.generate(6, {
          upperCaseAlphabets: false, lowerCaseAlphabets: false, specialChars: false,
        });
        await client.set(RESET_OTP_KEY(email), hashToken(otp), { EX: RESET_OTP_TTL_MINS * 60 });
        // Fresh OTP → fresh attempt budget.
        await client.del(RESET_ATTEMPTS_KEY(email));
        await client.set(RESET_RESEND_KEY(email), '1', { EX: RESEND_COOLDOWN_SECS });
        // A failing SMTP send must NOT surface as a 500 here (that would leak that
        // the account exists and broke). Log it; the user can request again.
        try {
          await sendPasswordResetOtp(email, otp, RESET_OTP_TTL_MINS);
        } catch (sendErr) {
          console.error('[AuthService.forgotPassword] OTP email failed:', sendErr.message);
        }
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    return apiResponse.send(res, 'SUCCESS', { message: 'If that email exists, an OTP has been sent.' });
  } catch (error) {
    console.error('[AuthService.forgotPassword]', error);
    return apiResponse.send(res, 'SERVER_ERROR');
  }
}

// ── Reset password ────────────────────────────────────────────────────────────
async function resetPassword(req, res) {
  try {
    const { otp, newPassword } = req.body;
    if (!req.body.email || !otp || !newPassword) {
      return apiResponse.send(res, 'VALIDATION_ERROR', { message: 'email, otp, and newPassword are required.' });
    }
    const email = normalizeEmail(req.body.email);

    // Brute-force guard: cap OTP validation attempts per email (IP rotation
    // defeats the route limiter; this budget is bound to the email itself).
    const attempts = await client.incr(RESET_ATTEMPTS_KEY(email));
    if (attempts === 1) await client.expire(RESET_ATTEMPTS_KEY(email), RESET_OTP_TTL_MINS * 60);
    if (attempts > MAX_OTP_ATTEMPTS) {
      await client.del(RESET_OTP_KEY(email));
      return apiResponse.send(res, 'INVALID_REQUEST', { message: 'Too many attempts. Request a new OTP.' });
    }

    // Atomic get+compare+delete: two concurrent requests submitting the same
    // correct OTP can only both reach here if BOTH win the race, but Redis EVAL
    // is single-threaded so only the first ever observes a match — the second
    // always finds the key already gone.
    const consumed = await consumeOtp(RESET_OTP_KEY(email), hashToken(String(otp).trim()));
    if (!consumed) {
      return apiResponse.send(res, 'INVALID_REQUEST', { message: 'Invalid or expired OTP.' });
    }

    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, isDeleted: false },
    });
    if (!user) return apiResponse.send(res, 'INVALID_REQUEST', { message: 'Invalid or expired OTP.' });

    const hashed = await bcrypt.hash(newPassword, 12);
    await prisma.$transaction(async (tx) => {
      await lockUserRow(tx, user.id);
      await tx.user.update({
        where: { id: user.id },
        data:  { password: hashed, tokenVersion: { increment: 1 } },
      });
      // Kill every existing session: revoke all refresh tokens so a token stolen
      // BEFORE the reset cannot be replayed against /refresh for its full 7d TTL.
      // The row lock means this also catches a refresh token inserted by an
      // in-flight rotation racing this reset — see lockUserRow().
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revoked: false },
        data:  { revoked: true },
      });
    });
    await client.del(RESET_ATTEMPTS_KEY(email));
    await client.del(RESET_RESEND_KEY(email));
    clearRefreshCookie(res);
    await auditLogger('PASSWORD_RESET', user, req);

    return apiResponse.send(res, 'SUCCESS', { message: 'Password reset successful.' });
  } catch (error) {
    console.error('[AuthService.resetPassword]', error);
    return apiResponse.send(res, 'SERVER_ERROR');
  }
}

// ── Registration + email verification (A03) ───────────────────────────────────

function verifyLinkFor(rawToken) {
  const base = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim();
  return `${base}/verify-email/${rawToken}`;
}

// Mints an opaque token, stores ONLY its sha256 (value = the user id) under a TTL,
// and emails the raw token. Consumption is a single atomic Redis GETDEL — the same
// "only the first caller can ever see it" guarantee as the reset OTP's Lua
// consume, which needs Lua only because it also has to compare a submitted value.
// A resend does not invalidate earlier tokens; they simply expire.
async function issueEmailVerification(user) {
  const rawToken = crypto.randomBytes(48).toString('base64url');
  await client.set(VERIFY_TOKEN_KEY(hashToken(rawToken)), user.id, { EX: VERIFY_TTL_HOURS * 60 * 60 });
  // A failing SMTP send must not 500 the caller — the account exists and the link
  // can be re-requested. Mirrors forgotPassword's handling.
  try {
    await sendEmailVerification(user.email, verifyLinkFor(rawToken), VERIFY_TTL_HOURS);
  } catch (sendErr) {
    console.error('[AuthService] verification email failed:', sendErr.message);
  }
}

// ── Register ──────────────────────────────────────────────────────────────────
// ANTI-ENUMERATION STANCE: unlike login and forgot-password, this endpoint DOES
// tell the caller that an email is already registered. That is the normal,
// expected signup UX (GitHub, Stripe, Slack all do it) and hiding it would force
// a "check your email" dead end on a user who simply forgot they have an account.
// What it must NOT leak is anything ABOUT that account — no name, no role, no
// auth provider, no verification state. The message below is the whole disclosure.
async function register(req, res) {
  try {
    const email    = normalizeEmail(req.body.email);
    const { password, name } = req.body;

    // The framework's login identifier is `userName`; a self-serve signup has no
    // separate handle to offer, so the email IS the username (matching the
    // "you@example.com" placeholder on the login form). A product that wants
    // distinct handles should take one in the body and use it here instead.
    const hashed = await bcrypt.hash(password, 12);
    let user;
    try {
      user = await prisma.user.create({
        data: { userName: email, email, name, password: hashed, role: SIGNUP_ROLE },
      });
    } catch (error) {
      // The unique indexes on userName/email are the real guard — a pre-check
      // would be a TOCTOU race between two concurrent signups of the same address.
      if (error.code === 'P2002') {
        return apiResponse.send(res, 'CONFLICT', { message: 'That email is already registered.' });
      }
      throw error;
    }

    await issueEmailVerification(user);
    await auditLogger('USER_REGISTERED', user, req);

    // No session is issued here: the account is created unverified and the user
    // logs in explicitly, so a registration request can never hand out a session
    // for an address whose owner has not been reached yet.
    return apiResponse.send(res, 'CREATED', {
      user:    buildUserPayload(user),
      message: 'Account created. Check your email for a confirmation link.',
    });
  } catch (error) {
    console.error('[AuthService.register]', error);
    return apiResponse.send(res, 'SERVER_ERROR');
  }
}

// ── Verify email ──────────────────────────────────────────────────────────────
// Public (no verifyToken): the link is opened from an email client that carries no
// session. The token itself is the proof.
async function verifyEmail(req, res) {
  try {
    const INVALID = { message: 'This confirmation link is invalid or has expired.' };
    const userId  = await client.getDel(VERIFY_TOKEN_KEY(hashToken(req.params.token)));
    if (!userId) return apiResponse.send(res, 'INVALID_REQUEST', INVALID);

    const user = await prisma.user.findFirst({ where: { id: userId, isDeleted: false } });
    if (!user) return apiResponse.send(res, 'INVALID_REQUEST', INVALID);

    // Idempotent: a second (still-unexpired) token for an already-verified account
    // succeeds rather than erroring, and does not move the original timestamp.
    if (!user.emailVerifiedAt) {
      await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
      await auditLogger('EMAIL_VERIFIED', user, req);
    }

    return apiResponse.send(res, 'SUCCESS', { message: 'Email confirmed. You can sign in now.' });
  } catch (error) {
    console.error('[AuthService.verifyEmail]', error);
    return apiResponse.send(res, 'SERVER_ERROR');
  }
}

// ── Resend verification ───────────────────────────────────────────────────────
// Public and anti-enumerating (always SUCCESS), because unlike /register this one
// is a probe oracle: it takes only an email and would otherwise answer "does an
// unverified account exist for this address?" to anyone who asks.
async function resendVerification(req, res) {
  try {
    const email = normalizeEmail(req.body.email);
    const user  = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, isDeleted: false },
    });

    const onCooldown = await client.get(VERIFY_RESEND_KEY(email));
    if (user && !user.emailVerifiedAt && !onCooldown) {
      await client.set(VERIFY_RESEND_KEY(email), '1', { EX: RESEND_COOLDOWN_SECS });
      await issueEmailVerification(user);
    }

    return apiResponse.send(res, 'SUCCESS', {
      message: 'If that address needs confirming, a new link has been sent.',
    });
  } catch (error) {
    console.error('[AuthService.resendVerification]', error);
    return apiResponse.send(res, 'SERVER_ERROR');
  }
}

// ── Session / account management (A04) ────────────────────────────────────────

const publicSession = (row, currentHash) => ({
  id:         row.id,
  device:     row.deviceInfo,
  ipAddress:  row.ipAddress,
  createdAt:  row.createdAt,
  lastUsedAt: row.lastUsedAt,
  expiredAt:  row.expiredAt,
  // The caller's own session, identified by the refresh cookie on THIS request.
  current:    !!currentHash && row.tokenHash === currentHash,
});

const currentTokenHash = (req) => {
  const token = req.cookies?.[REFRESH_COOKIE_NAME] || req.body?.refreshToken;
  return token ? hashToken(token) : null;
};

// ── GET /sessions ─────────────────────────────────────────────────────────────
// Live sessions == refresh-token rows that are neither revoked nor expired; see
// the RefreshToken model comment for why that set is exactly one row per device.
// tokenHash is used for the `current` comparison and never leaves the server.
async function listSessions(req, res) {
  try {
    const rows = await prisma.refreshToken.findMany({
      where:   { userId: req.user.id, revoked: false, expiredAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    const currentHash = currentTokenHash(req);
    return apiResponse.send(res, 'SUCCESS', { sessions: rows.map(r => publicSession(r, currentHash)) });
  } catch (error) {
    console.error('[AuthService.listSessions]', error);
    return apiResponse.send(res, 'SERVER_ERROR');
  }
}

// ── DELETE /sessions/:sessionId ───────────────────────────────────────────────
// Scoped by userId in the WHERE clause, so another user's session id simply
// matches nothing — 404 without a separate ownership lookup that could leak
// whether the id exists at all.
async function revokeSession(req, res) {
  try {
    const target = await prisma.refreshToken.findFirst({
      where: { id: req.params.sessionId, userId: req.user.id, revoked: false, expiredAt: { gt: new Date() } },
    });
    if (!target) return apiResponse.send(res, 'NOT_FOUND', { message: 'Session not found.' });

    await prisma.refreshToken.updateMany({
      where: { id: target.id, userId: req.user.id },
      data:  { revoked: true },
    });

    // Revoking your own session is "log this device out": the cookie it just sent
    // is now dead, so clear it rather than leaving a stale one to 401 later.
    if (target.tokenHash === currentTokenHash(req)) clearRefreshCookie(res);

    await auditLogger('SESSION_REVOKED', req.user, req);
    return apiResponse.send(res, 'SUCCESS', { message: 'Session revoked.' });
  } catch (error) {
    console.error('[AuthService.revokeSession]', error);
    return apiResponse.send(res, 'SERVER_ERROR');
  }
}

// Revoke EVERY session, bump tokenVersion, then immediately mint a fresh pair for
// the caller — the "all except current" shape, expressed as revoke-all-and-reissue.
//
// Why not "revoke all WHERE tokenHash != mine": that leaves every other device's
// still-unexpired ACCESS token (24h) working, because only a tokenVersion bump
// kills those — and a selective bump is impossible, tokenVersion is per user.
// Bumping and re-issuing gives other devices an immediate hard stop (verifyToken
// and the WS hub's validateIdentity both compare tokenVersion) while the caller
// keeps working, which is the whole point of "except current".
//
// Same lockUserRow() discipline as logout/resetPassword: a concurrent /refresh
// either completes before this transaction or observes its final state, so it can
// never slip a live token past the revoke-all.
async function revokeOthersAndReissue(req, userId, userData = {}) {
  return prisma.$transaction(async (tx) => {
    await lockUserRow(tx, userId);
    await tx.refreshToken.updateMany({ where: { userId, revoked: false }, data: { revoked: true } });
    const user = await tx.user.update({
      where: { id: userId },
      data:  { ...userData, tokenVersion: { increment: 1 } },
    });
    const newRefreshToken = generateRefreshToken();
    await storeRefreshToken(userId, newRefreshToken, req, tx);
    return { user, token: generateToken(user), refreshToken: newRefreshToken };
  });
}

// ── POST /sessions/revoke-all ─────────────────────────────────────────────────
async function revokeAllSessions(req, res) {
  try {
    const reissued = await revokeOthersAndReissue(req, req.user.id);
    setRefreshCookie(res, reissued.refreshToken);
    await auditLogger('SESSIONS_REVOKED_ALL', req.user, req);
    return apiResponse.send(res, 'SUCCESS', {
      token:        reissued.token,
      refreshToken: reissued.refreshToken,
      user:         buildUserPayload(reissued.user),
      message:      'All other sessions have been signed out.',
    });
  } catch (error) {
    console.error('[AuthService.revokeAllSessions]', error);
    return apiResponse.send(res, 'SERVER_ERROR');
  }
}

// ── POST /change-password ─────────────────────────────────────────────────────
// Distinct from resetPassword: the caller is authenticated and proves knowledge of
// the CURRENT password first.
//
// WHY THE SESSION SCOPE DIFFERS FROM A RESET:
//   resetPassword is triggered by whoever holds the mailbox, which is exactly the
//   situation where the account may ALREADY be compromised — so it kills every
//   session unconditionally, including the one that asked, and the user signs in
//   again from scratch.
//   change-password is performed by someone who already holds a live session AND
//   the current password. Signing that tab out proves nothing and just punishes
//   routine password hygiene, so the caller is re-issued a fresh pair while every
//   OTHER device is cut off immediately (tokenVersion bump + revoke-all).
async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body;

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || !(await bcrypt.compare(currentPassword, user.password))) {
      await auditLogger('PASSWORD_CHANGE_FAILED', req.user, req);
      return apiResponse.send(res, 'UNAUTHORIZED', { message: 'Current password is incorrect.' });
    }

    const hashed   = await bcrypt.hash(newPassword, 12);
    const reissued = await revokeOthersAndReissue(req, user.id, { password: hashed });
    setRefreshCookie(res, reissued.refreshToken);

    // Security-category notification — never opted out of (see
    // notificationCategories.js). Best-effort: a failure here must not turn a
    // successful password change into a 500.
    try {
      await notify({
        userId: user.id,
        type: 'password_changed',
        title: 'Your password was changed',
        body: 'If this wasn\'t you, reset your password immediately and review your active sessions.',
        channels: ['in_app', 'email'],
      });
    } catch (notifyErr) {
      console.error('[AuthService.changePassword] notification failed:', notifyErr.message);
    }

    await auditLogger('PASSWORD_CHANGED', req.user, req);
    return apiResponse.send(res, 'SUCCESS', {
      token:        reissued.token,
      refreshToken: reissued.refreshToken,
      user:         buildUserPayload(reissued.user),
      message:      'Password changed. Your other devices have been signed out.',
    });
  } catch (error) {
    console.error('[AuthService.changePassword]', error);
    return apiResponse.send(res, 'SERVER_ERROR');
  }
}

module.exports = {
  login,
  refreshToken,
  logout,
  me,
  updateProfile,
  forgotPassword,
  resetPassword,
  register,
  verifyEmail,
  resendVerification,
  listSessions,
  revokeSession,
  revokeAllSessions,
  changePassword,
};

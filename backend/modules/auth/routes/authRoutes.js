/**
 * Auth routes.
 *
 * POST /common/auth/login
 * POST /common/auth/refresh
 * GET  /common/auth/me
 * POST /common/auth/logout
 * POST /common/auth/forgot-password
 * POST /common/auth/reset-password
 *
 * Onboarding (A03):
 * POST /common/auth/register
 * POST /common/auth/verify-email/:token
 * POST /common/auth/resend-verification
 *
 * Session / account management (A04):
 * GET    /common/auth/sessions
 * DELETE /common/auth/sessions/:sessionId
 * POST   /common/auth/sessions/revoke-all
 * POST   /common/auth/change-password
 */
const express     = require('express');
const router      = express.Router();
const verifyToken = require('../../../middleware/verifyToken');
const { loginLimiter, otpSendLimiter, refreshLimiter } = require('../../../middleware/rateLimit.js');
const { validateBody, z } = require('../../../middleware/validate');
const { validatedUpload } = require('../../../middleware/upload.js');
const {
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
} = require('../services/AuthService');

const loginSchema   = z.object({
  userName: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
});
// Refresh token now travels as an httpOnly cookie (F11); the body field is an
// optional fallback for callers not yet migrated to cookie-based refresh.
const refreshSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});
const forgotSchema  = z.object({
  email: z.string().trim().email().max(255),
});
const resetSchema   = z.object({
  email:        z.string().trim().email().max(255),
  otp:          z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
  newPassword:  z.string().min(8).max(200),
});
const registerSchema = z.object({
  email:    z.string().trim().email().max(255),
  password: z.string().min(8).max(200),
  name:     z.string().trim().min(1).max(100),
});
const resendSchema = z.object({
  email: z.string().trim().email().max(255),
});
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword:     z.string().min(8).max(200),
}).refine((v) => v.currentPassword !== v.newPassword, {
  message: 'The new password must differ from the current one',
  path:    ['newPassword'],
});
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

router.post('/login',            loginLimiter,  validateBody(loginSchema),   login);
router.post('/refresh',          refreshLimiter, validateBody(refreshSchema), refreshToken);
router.get( '/me',               verifyToken,   me);
router.post('/logout',           verifyToken,   logout);
router.post('/profile/update',   verifyToken,   validatedUpload.single('photo', PHOTO_TYPES), updateProfile);
router.post('/forgot-password',  otpSendLimiter, validateBody(forgotSchema), forgotPassword);
router.post('/reset-password',   otpSendLimiter, validateBody(resetSchema),  resetPassword);

// ── Onboarding (public) ───────────────────────────────────────────────────────
// register/resend reuse otpSendLimiter (3/hr per IP): both mint a token and send
// an email, which is exactly the abuse profile that limiter exists for.
// verify-email is NOT otp-limited (a user may legitimately click a stale link a
// few times) but does sit behind the refresh limiter's brute-force budget — the
// token is 48 random bytes, so guessing is not the threat; request floods are.
router.post('/register',              otpSendLimiter, validateBody(registerSchema), register);
router.post('/verify-email/:token',   refreshLimiter, verifyEmail);
router.post('/resend-verification',   otpSendLimiter, validateBody(resendSchema),   resendVerification);

// ── Session / account management (authenticated) ──────────────────────────────
router.get(   '/sessions',              verifyToken, listSessions);
// Declared before /sessions/:sessionId so "revoke-all" is never read as an id.
router.post(  '/sessions/revoke-all',   verifyToken, revokeAllSessions);
router.delete('/sessions/:sessionId',   verifyToken, revokeSession);
router.post(  '/change-password',       verifyToken, validateBody(changePasswordSchema), changePassword);

module.exports = router;

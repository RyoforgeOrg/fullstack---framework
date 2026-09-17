// Email transport helper (nodemailer SMTP).
// Wire: SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / SMTP_SECURE.
// If SMTP_HOST is not configured the service runs in dev mode: the email body is
// printed to the server log instead of being sent. Never fake a send — callers
// get a boolean back so they know what happened.
const nodemailer = require('nodemailer');

const FROM_ADDRESS = process.env.SMTP_FROM || process.env.SUPPORT_EMAIL || 'noreply@localhost';

let transport = null;
function getTransport() {
  if (!process.env.SMTP_HOST) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth:   process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined,
    });
  }
  return transport;
}

/**
 * Send a transactional email.
 * @param {string} to
 * @param {string} subject
 * @param {string} html
 * @param {string} [text]
 * @returns {Promise<{ sent: boolean, dev?: boolean }>}
 */
async function sendMail(to, subject, html, text = '') {
  const t = getTransport();
  if (!t) {
    // Logging email content (OTPs included) is a dev convenience only — server.js's
    // production config guard already refuses to boot without SMTP_HOST, so this
    // is a defense-in-depth failure, not the primary control.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[emailService] SMTP is not configured — refusing to silently log email content in production.');
    }
    console.log(`[emailService] DEV MODE (SMTP_HOST not set) — email to ${to}:\nSubject: ${subject}\n${text || html.replace(/<[^>]+>/g, '')}`);
    return { sent: false, dev: true };
  }
  await t.sendMail({ from: FROM_ADDRESS, to, subject, html, text: text || undefined });
  return { sent: true };
}

/**
 * Send a password-reset OTP.
 * @param {string} to
 * @param {string} otp
 * @param {number} ttlMinutes
 */
async function sendPasswordResetOtp(to, otp, ttlMinutes) {
  const subject = 'Your password reset code';
  const html    = `<p>Your password reset code is <strong>${otp}</strong>.</p>
<p>It expires in ${ttlMinutes} minutes. If you did not request this, ignore this email.</p>`;
  return sendMail(to, subject, html, `Your password reset code is ${otp}. It expires in ${ttlMinutes} minutes.`);
}

/**
 * Send an organization invitation.
 * @param {string} to          invited email address
 * @param {string} orgName     organization display name
 * @param {string} inviteLink  absolute accept URL carrying the raw opaque token
 */
async function sendOrgInvitation(to, orgName, inviteLink) {
  const subject = `You have been invited to join ${orgName}`;
  const html    = `<p>You have been invited to join <strong>${orgName}</strong>.</p>
<p><a href="${inviteLink}">Accept the invitation</a></p>
<p>This link works once and expires in 7 days. If you did not expect this, ignore this email.</p>`;
  return sendMail(to, subject, html, `You have been invited to join ${orgName}. Accept: ${inviteLink}`);
}

/**
 * Send an email-verification link for a newly registered account.
 * @param {string} to          the address being verified
 * @param {string} verifyLink  absolute URL carrying the raw opaque token
 * @param {number} ttlHours
 */
async function sendEmailVerification(to, verifyLink, ttlHours) {
  const subject = 'Confirm your email address';
  const html    = `<p>Welcome! Confirm your email address to finish setting up your account.</p>
<p><a href="${verifyLink}">Confirm my email</a></p>
<p>This link works once and expires in ${ttlHours} hours. If you did not create an account, ignore this email.</p>`;
  return sendMail(to, subject, html, `Confirm your email address: ${verifyLink} (expires in ${ttlHours} hours)`);
}

module.exports = { sendMail, sendPasswordResetOtp, sendOrgInvitation, sendEmailVerification };

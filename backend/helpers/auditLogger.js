/**
 * Audit logger — writes one row to the AuditLog table.
 * @param {string} action   Human-readable label, e.g. "USER_LOGIN", "PASSWORD_RESET"
 * @param {object} user     req.user (must have id, name, role)
 * @param {object} req      Express request (for ip + userAgent)
 * @param {object} extra    Any additional flat key-value pairs to store — must
 *                          match a column on the AuditLog model (prisma/schema.prisma);
 *                          anything else is dropped rather than sent to prisma.create,
 *                          which would otherwise throw on an unknown field and be
 *                          swallowed below, silently losing the whole audit row.
 */
const prisma = require('../config/dbConnect');

// Keep in sync with prisma/schema.prisma's AuditLog model. id/createdAt are
// set by Prisma itself and must not be overridable via `extra`.
const ALLOWED_EXTRA_FIELDS = new Set(['action', 'userId', 'userName', 'userRole', 'ipAddress', 'userAgent', 'organizationId']);

async function auditLogger(action, user, req, extra = {}) {
  const filteredExtra = {};
  for (const [key, value] of Object.entries(extra)) {
    if (ALLOWED_EXTRA_FIELDS.has(key)) {
      filteredExtra[key] = value;
    } else {
      console.warn(`[AuditLogger] Dropping unsupported field "${key}" — not on the AuditLog schema.`);
    }
  }

  try {
    await prisma.auditLog.create({
      data: {
        action,
        userId:    user.id,
        userName:  user.name,
        userRole:  user.role,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent']?.slice(0, 255),
        ...filteredExtra,
      },
    });
  } catch (error) {
    // Never let an audit-log failure break the calling request path — just
    // make it visible in logs/metrics so it doesn't fail silently.
    console.error('[AuditLogger] Failed to write audit log:', { action, userId: user?.id, error: error.message });
  }
}

module.exports = { auditLogger };

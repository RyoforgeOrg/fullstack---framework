/**
 * Notification service.
 *
 * `notify()` is the entry point OTHER MODULES call to raise a notification. It:
 *   1. writes the Notification row (the in-app inbox record),
 *   2. pushes it live over the existing WS hub on channel `user:<userId>`
 *      (same convention documented in backend/helpers/ws/hub.js and used by
 *      job progress via `job:<jobId>`),
 *   3. if 'email' is a requested channel and the recipient hasn't opted out
 *      of that type's category, ENQUEUES delivery via the job queue rather
 *      than calling emailService inline — a slow/down SMTP server must never
 *      block the request that triggered the notification. The worker handler
 *      (backend/workers/notificationEmailJobHandler.js) does the actual send
 *      and updates emailDeliveredAt/emailDeliveryError; jobQueue's own
 *      retry-on-failure covers transient SMTP errors for free.
 *
 * Intended call sites not wired in this pass (neither exists yet in this
 * worktree, and both are owned by other in-flight agents per the task scope —
 * wiring into files that don't exist, or that another agent is actively
 * building, risks a broken merge):
 *   - OrganizationService.js invite flow: after creating an Invitation for an
 *     email that already matches a User, call
 *     notify({ userId, organizationId, type: 'org_invitation', channels: ['in_app','email'], ... })
 *     alongside (not instead of) the existing direct sendOrgInvitation() email.
 *   - AuthService.js password change: call
 *     notify({ userId, type: 'password_changed', channels: ['in_app','email'], ... })
 *     right after the tokenVersion bump that revokes existing sessions.
 */
const prisma = require('../../../config/dbConnect');
const { emitToChannel } = require('../../../helpers/ws/hub');
const { enqueueJob } = require('../../../helpers/queue/jobQueue');
const { CATEGORIES, categoryForType } = require('../notificationCategories');

const NOTIFICATION_EMAIL_QUEUE = 'queue:notification-email';

function defaultPreferences() {
  const out = {};
  for (const [category, def] of Object.entries(CATEGORIES)) {
    if (def.optOutable !== false) out[category] = true; // opted IN by default
  }
  return out;
}

function isOptedOutOfEmail(preferences, type) {
  const category = CATEGORIES[categoryForType(type)];
  if (!category || category.optOutable === false) return false; // security: never opt-out-able
  return preferences?.[categoryForType(type)] === false;
}

/**
 * Create a notification, push it live, and (maybe) queue its email leg.
 *
 * @param {object} params
 * @param {string} params.userId          recipient (required)
 * @param {string} [params.organizationId] optional org context
 * @param {string} params.type            e.g. 'org_invitation', 'password_changed'
 * @param {string} params.title
 * @param {string} params.body
 * @param {object} [params.data]          arbitrary structured payload for the frontend
 * @param {string[]} [params.channels]    defaults to ['in_app']; include 'email' to also email
 */
async function notify({ userId, organizationId = null, type, title, body, data = {}, channels = ['in_app'] }) {
  if (!userId || !type || !title || !body) {
    throw new Error('notify() requires userId, type, title, and body');
  }

  const notification = await prisma.notification.create({
    data: { userId, organizationId, type, title, body, data, channels },
  });

  await emitToChannel(`user:${userId}`, { event: 'notification', notification });

  if (channels.includes('email')) {
    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: { email: true, notificationPreferences: true },
    });

    if (user?.email && !isOptedOutOfEmail(user.notificationPreferences, type)) {
      await enqueueJob(
        NOTIFICATION_EMAIL_QUEUE,
        { notificationId: notification.id, to: user.email, title, body },
        { userId }
      );
    }
  }

  return notification;
}

async function listNotifications({ userId, skip, take }) {
  const [rows, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.notification.count({ where: { userId } }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  return { rows, total, unreadCount };
}

async function markRead({ userId, id }) {
  const result = await prisma.notification.updateMany({
    where: { id, userId, readAt: null },
    data:  { readAt: new Date() },
  });
  return result.count > 0;
}

async function markAllRead({ userId }) {
  const result = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data:  { readAt: new Date() },
  });
  return result.count;
}

async function getPreferences({ userId }) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { notificationPreferences: true } });
  return { ...defaultPreferences(), ...(user?.notificationPreferences || {}) };
}

async function updatePreferences({ userId, preferences }) {
  const patch = {};
  for (const [category, def] of Object.entries(CATEGORIES)) {
    if (def.optOutable === false) continue; // security ignores any override
    if (typeof preferences[category] === 'boolean') patch[category] = preferences[category];
  }

  const current = await getPreferences({ userId });
  const merged  = { ...current, ...patch };
  await prisma.user.update({ where: { id: userId }, data: { notificationPreferences: merged } });
  return merged;
}

module.exports = {
  notify,
  listNotifications,
  markRead,
  markAllRead,
  getPreferences,
  updatePreferences,
  NOTIFICATION_EMAIL_QUEUE,
};

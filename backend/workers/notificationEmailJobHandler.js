/**
 * Delivers the email leg of a notification created by
 * backend/modules/notifications/services/NotificationService.js#notify().
 * Registered in worker.js under the 'queue:notification-email' queue.
 *
 * Retries (transient SMTP failures) are handled by jobQueue.js itself — this
 * handler just needs to throw on failure so the job gets re-queued.
 */
const prisma = require('../config/dbConnect');
const { sendMail } = require('../helpers/emailService');

/**
 * @param {object} payload
 * @param {string} payload.notificationId
 * @param {string} payload.to
 * @param {string} payload.title
 * @param {string} payload.body
 * @param {object} ctx
 * @param {Function} ctx.reportProgress
 */
async function handleNotificationEmail({ notificationId, to, title, body }, { reportProgress }) {
  await reportProgress(0, 'Sending notification email…');

  try {
    await sendMail(to, title, `<p>${body}</p>`, body);
  } catch (err) {
    await prisma.notification.update({
      where: { id: notificationId },
      data:  { emailDeliveryError: err.message || 'Unknown error' },
    });
    throw err; // jobQueue retries transient failures (3 total attempts)
  }

  await prisma.notification.update({
    where: { id: notificationId },
    data:  { emailDeliveredAt: new Date(), emailDeliveryError: null },
  });

  await reportProgress(100, 'Sent.');
  return { success: true };
}

module.exports = { handleNotificationEmail };

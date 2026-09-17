/**
 * Notification routes — USER-scoped, not org-scoped: verifyToken only (no
 * tenantContext), mounted at /api/v1/common/notifications (see routes/index.js).
 *
 * GET   /                    paginated list of the caller's own notifications,
 *                             newest first, with unreadCount in the response.
 * PATCH /:id/read             mark one as read (must belong to the caller).
 * POST  /read-all             mark all as read.
 * GET   /preferences          read the caller's per-category email opt-outs.
 * PATCH /preferences          update them.
 */
const express      = require('express');
const router       = express.Router();
const apiResponse  = require('../../../helpers/apiResponse');
const paginate      = require('../../../helpers/paginate');
const { validateBody, z } = require('../../../middleware/validate');
const {
  listNotifications,
  markRead,
  markAllRead,
  getPreferences,
  updatePreferences,
} = require('../services/NotificationService');
const { CATEGORIES } = require('../notificationCategories');

const OPT_OUTABLE_CATEGORIES = Object.entries(CATEGORIES)
  .filter(([, def]) => def.optOutable !== false)
  .map(([key]) => key);

const preferencesSchema = z
  .object(Object.fromEntries(OPT_OUTABLE_CATEGORIES.map((key) => [key, z.boolean()])))
  .partial();

router.get('/', async (req, res) => {
  const { skip, take, meta } = paginate(req.query);
  const { rows, total, unreadCount } = await listNotifications({ userId: req.user.id, skip, take });
  apiResponse.send(res, 'SUCCESS', {
    notifications: rows,
    pagination:    meta(total),
    unreadCount,
  });
});

router.patch('/:id/read', async (req, res) => {
  const updated = await markRead({ userId: req.user.id, id: req.params.id });
  if (!updated) return apiResponse.send(res, 'NOT_FOUND');
  apiResponse.send(res, 'SUCCESS', {});
});

router.post('/read-all', async (req, res) => {
  const updated = await markAllRead({ userId: req.user.id });
  apiResponse.send(res, 'SUCCESS', { updated });
});

router.get('/preferences', async (req, res) => {
  const preferences = await getPreferences({ userId: req.user.id });
  apiResponse.send(res, 'SUCCESS', { preferences, categories: CATEGORIES });
});

router.patch('/preferences', validateBody(preferencesSchema), async (req, res) => {
  const preferences = await updatePreferences({ userId: req.user.id, preferences: req.body });
  apiResponse.send(res, 'SUCCESS', { preferences });
});

module.exports = router;

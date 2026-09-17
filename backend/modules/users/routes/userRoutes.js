/**
 * Platform user administration routes.
 * Mounted at /api/v1/admin/users behind verifyToken + role('superAdmin')
 * (routes/index.js) — the guard lives at the mount, following this project's
 * convention for admin surfaces.
 *
 * PATCH /admin/users/:userId/status   suspend / reactivate an account
 */
const express = require('express');
const router  = express.Router();
const { validateBody, z } = require('../../../middleware/validate');
const { setUserStatus } = require('../services/UserService');

const statusSchema = z.object({
  active: z.boolean(),
});

router.patch('/:userId/status', validateBody(statusSchema), setUserStatus);

module.exports = router;

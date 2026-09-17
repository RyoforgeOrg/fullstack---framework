/**
 * Organization routes. Mounted at /api/v1/orgs behind verifyToken (routes/index.js).
 *
 * POST   /orgs                               create (creator becomes owner)
 * GET    /orgs                               list the caller's organizations
 * POST   /orgs/invitations/:token/accept     accept an invitation
 * POST   /orgs/:orgId/invitations            invite by email        (owner/admin)
 * GET    /orgs/:orgId/members                list members           (any member)
 * PATCH  /orgs/:orgId/members/:membershipId  change role / remove   (owner/admin)
 * PATCH  /orgs/:orgId                        update name/settings/branding (owner/admin)
 * GET    /orgs/:orgId/usage                  usage summary          (any member)
 * GET    /orgs/:orgId/audit-log              paginated audit log    (owner/admin)
 * DELETE /orgs/:orgId                        delete org             (owner)
 *
 * The first three are USER-scoped (no organization in play yet, or the token is
 * the org reference) so they skip tenantContext. Everything under /:orgId is
 * org-scoped: tenantContext resolves + authorizes the tenant, then requireOrgRole
 * checks the caller's role within it.
 */
const express     = require('express');
const router      = express.Router();
const tenantContext = require('../../../middleware/tenantContext');
const requireVerifiedEmail = require('../../../middleware/requireVerifiedEmail');
const { requireOrgRole, ORG_PERMISSIONS } = require('../../../middleware/requireOrgRole');
const { validateBody, z } = require('../../../middleware/validate');
const {
  createOrganization,
  listOrganizations,
  inviteMember,
  acceptInvitation,
  listMembers,
  updateMember,
  updateOrganization,
  getUsageSummary,
  getAuditLog,
  deleteOrganization,
} = require('../services/OrganizationService');

const ROLES = ['owner', 'admin', 'member', 'viewer'];

const createSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z.string().trim().toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase alphanumeric with single hyphens')
    .min(2).max(63).optional(),
});

const inviteSchema = z.object({
  email: z.string().trim().email().max(255),
  role:  z.enum(ROLES),
});

const updateMemberSchema = z.object({
  role:   z.enum(ROLES).optional(),
  status: z.literal('removed').optional(),
}).refine((v) => v.role || v.status, { message: 'Provide role or status' });

const updateOrgSchema = z.object({
  name:         z.string().trim().min(2).max(100).optional(),
  logoUrl:      z.string().trim().url().max(2048).nullable().optional(),
  primaryColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'primaryColor must be a hex color like #A1B2C3').nullable().optional(),
  // Ad-hoc product config — deliberately unstructured, see prisma/schema.prisma.
  settings:     z.record(z.string(), z.any()).nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

// ── User-scoped ───────────────────────────────────────────────────────────────
// Creating an org is the ONE action gated on a confirmed email address — it is the
// first thing a new account does that becomes durable and can send invitations.
// Accepting an invitation deliberately is NOT gated: the inviter already vouched
// for the address. See middleware/requireVerifiedEmail.js.
router.post('/', requireVerifiedEmail, validateBody(createSchema), createOrganization);
router.get('/',  listOrganizations);
// Declared before the /:orgId block so "invitations" is never read as an org id.
router.post('/invitations/:token/accept', acceptInvitation);

// ── Org-scoped ────────────────────────────────────────────────────────────────
router.post('/:orgId/invitations',
  tenantContext, requireOrgRole(...ORG_PERMISSIONS['members:invite']),
  validateBody(inviteSchema), inviteMember);

router.get('/:orgId/members',
  tenantContext, requireOrgRole(...ORG_PERMISSIONS['members:view']),
  listMembers);

router.patch('/:orgId/members/:membershipId',
  tenantContext, requireOrgRole(...ORG_PERMISSIONS['members:manage']),
  validateBody(updateMemberSchema), updateMember);

router.patch('/:orgId',
  tenantContext, requireOrgRole(...ORG_PERMISSIONS['org:settings:view']),
  validateBody(updateOrgSchema), updateOrganization);

router.get('/:orgId/usage',
  tenantContext, requireOrgRole(...ORG_PERMISSIONS['org:access']),
  getUsageSummary);

router.get('/:orgId/audit-log',
  tenantContext, requireOrgRole(...ORG_PERMISSIONS['org:settings:view']),
  getAuditLog);

router.delete('/:orgId',
  tenantContext, requireOrgRole(...ORG_PERMISSIONS['org:delete']),
  deleteOrganization);

module.exports = router;

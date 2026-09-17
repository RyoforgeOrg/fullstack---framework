/**
 * Organization service — org CRUD, membership management, invitations.
 *
 * Tenant boundary: every org-scoped handler here runs behind
 * middleware/tenantContext, so req.organizationId / req.membership are already
 * proven to belong to the caller. Queries against tenant-owned rows go through
 * scopedWhere() — see helpers/tenantScope.js.
 *
 * Invitation tokens are opaque randomBytes(48), stored sha256-hashed, exactly
 * like RefreshToken. Acceptance is a single-use atomic claim (conditional
 * updateMany inside a transaction), the same pattern AuthService.refreshToken
 * uses to rotate a refresh token exactly once under concurrency.
 */
const crypto      = require('crypto');
const prisma      = require('../../../config/dbConnect');
const apiResponse = require('../../../helpers/apiResponse');
const { auditLogger }     = require('../../../helpers/auditLogger');
const { scopedWhere }     = require('../../../helpers/tenantScope');
const { sendOrgInvitation } = require('../../../helpers/emailService');
const paginate     = require('../../../helpers/paginate');
const { createFreeSubscription } = require('../../billing/services/BillingService'); // A05

const INVITE_TTL_DAYS = 7;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const publicOrg = (org) => ({
  id:           org.id,
  name:         org.name,
  slug:         org.slug,
  status:       org.status,
  logoUrl:      org.logoUrl,
  primaryColor: org.primaryColor,
  settings:     org.settings,
  createdAt:    org.createdAt,
});

const publicMember = (m) => ({
  id:        m.id,
  userId:    m.userId,
  role:      m.role,
  status:    m.status,
  invitedAt: m.invitedAt,
  joinedAt:  m.joinedAt,
  user:      m.user ? { id: m.user.id, name: m.user.name, email: m.user.email, userName: m.user.userName } : null,
});

function slugify(name) {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

function inviteLinkFor(rawToken) {
  const base = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim();
  return `${base}/invitations/${rawToken}/accept`;
}

// ── POST /orgs — create (any authenticated user; creator becomes owner) ────────
async function createOrganization(req, res) {
  const { name, slug } = req.body;
  const finalSlug = slug || slugify(name);

  if (!finalSlug) {
    return apiResponse.send(res, 'VALIDATION_ERROR', {
      message: 'Could not derive a URL-safe slug from that name — provide one explicitly.',
    });
  }

  let organization;
  try {
    organization = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({ data: { name, slug: finalSlug } });
      await tx.membership.create({
        data: {
          userId:         req.user.id,
          organizationId: org.id,
          role:           'owner',
          status:         'active',
          joinedAt:       new Date(),
        },
      });
      // ── billing (A05) ── every org starts on the free plan. Inside this
      // transaction on purpose: an org must never exist without a subscription
      // row, or entitlement lookups have nothing to read.
      await createFreeSubscription(tx, org.id);
      return org;
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return apiResponse.send(res, 'CONFLICT', { message: 'That organization slug is already taken.' });
    }
    throw error;
  }

  await auditLogger('ORG_CREATED', req.user, req, { organizationId: organization.id });
  return apiResponse.send(res, 'CREATED', { organization: publicOrg(organization) });
}

// ── GET /orgs — the caller's organizations ────────────────────────────────────
// User-scoped, NOT org-scoped: no tenantContext. Suspended orgs are listed (with
// their status) so the UI can show why they are unusable; every org-scoped route
// still rejects them.
async function listOrganizations(req, res) {
  const memberships = await prisma.membership.findMany({
    where:   { userId: req.user.id, status: 'active' },
    include: { organization: true },
    orderBy: { createdAt: 'asc' },
  });

  return apiResponse.send(res, 'SUCCESS', {
    organizations: memberships.map((m) => ({
      ...publicOrg(m.organization),
      role:         m.role,
      membershipId: m.id,
    })),
  });
}

// ── POST /orgs/:orgId/invitations — invite by email (owner/admin) ─────────────
async function inviteMember(req, res) {
  const { email, role } = req.body;
  const normalizedEmail = email.trim().toLowerCase();

  if (role === 'owner' && req.membership.role !== 'owner') {
    return apiResponse.send(res, 'FORBIDDEN', { message: 'Only an owner can grant ownership.' });
  }

  const alreadyMember = await prisma.membership.findFirst({
    where: scopedWhere(req, { status: 'active', user: { email: normalizedEmail } }),
  });
  if (alreadyMember) {
    return apiResponse.send(res, 'CONFLICT', { message: 'That email is already an active member.' });
  }

  const rawToken = crypto.randomBytes(48).toString('base64url');

  let invitation;
  try {
    invitation = await prisma.invitation.create({
      data: {
        organizationId:  req.organizationId,
        email:           normalizedEmail,
        role,
        tokenHash:       hashToken(rawToken),
        invitedByUserId: req.user.id,
        expiresAt:       new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    });
  } catch (error) {
    // Partial unique index Invitation_org_email_pending_key — a pending
    // invitation for this email already exists.
    if (error.code === 'P2002') {
      return apiResponse.send(res, 'CONFLICT', {
        message: 'A pending invitation for that email already exists.',
      });
    }
    throw error;
  }

  // A failing SMTP send must not 500 the invite — the row exists and the invite
  // can be re-sent. Mirrors forgotPassword's handling.
  try {
    await sendOrgInvitation(normalizedEmail, req.organization.name, inviteLinkFor(rawToken));
  } catch (sendErr) {
    console.error('[OrganizationService.inviteMember] invitation email failed:', sendErr.message);
  }

  await auditLogger('ORG_MEMBER_INVITED', req.user, req, { organizationId: req.organizationId });
  return apiResponse.send(res, 'CREATED', {
    invitation: {
      id:        invitation.id,
      email:     invitation.email,
      role:      invitation.role,
      expiresAt: invitation.expiresAt,
    },
  });
}

// ── POST /orgs/invitations/:token/accept ──────────────────────────────────────
// Authenticated, user-scoped (the token IS the org reference), so no
// tenantContext. SCOPE: the accepting account must already exist and its email
// must match the invitation's, case-insensitively. Inviting an address with no
// account yet ("invite → signup → auto-accept") is a deliberate follow-up and is
// out of scope here.
async function acceptInvitation(req, res) {
  const now        = new Date();
  const invitation = await prisma.invitation.findUnique({
    where:   { tokenHash: hashToken(req.params.token) },
    include: { organization: true },
  });

  const INVALID = { message: 'Invalid or expired invitation.' };
  if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt < now) {
    return apiResponse.send(res, 'INVALID_REQUEST', INVALID);
  }
  if (invitation.organization.status !== 'active') {
    return apiResponse.send(res, 'FORBIDDEN', { message: 'That organization is suspended.' });
  }
  if (!req.user.email || req.user.email.toLowerCase() !== invitation.email) {
    return apiResponse.send(res, 'FORBIDDEN', {
      message: 'This invitation was issued to a different email address.',
    });
  }

  const membership = await prisma.$transaction(async (tx) => {
    // Single-use atomic claim: under concurrent accepts the second transaction
    // blocks on the row lock, re-reads acceptedAt as non-null and matches zero
    // rows. Same conditional-claim shape as refresh-token rotation.
    const claimed = await tx.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data:  { acceptedAt: now },
    });
    if (claimed.count !== 1) return null;

    // upsert, not create: a previously removed member keeps their original row
    // (unique on userId+organizationId) and is reactivated in place.
    return tx.membership.upsert({
      where:  { userId_organizationId: { userId: req.user.id, organizationId: invitation.organizationId } },
      create: {
        userId:         req.user.id,
        organizationId: invitation.organizationId,
        role:           invitation.role,
        status:         'active',
        invitedAt:      invitation.createdAt,
        joinedAt:       now,
      },
      update: { role: invitation.role, status: 'active', joinedAt: now },
    });
  });

  if (!membership) return apiResponse.send(res, 'INVALID_REQUEST', INVALID);

  await auditLogger('ORG_INVITATION_ACCEPTED', req.user, req, { organizationId: invitation.organizationId });
  return apiResponse.send(res, 'SUCCESS', {
    organization: publicOrg(invitation.organization),
    membership:   publicMember(membership),
  });
}

// ── GET /orgs/:orgId/members — any active member (viewer included) ────────────
async function listMembers(req, res) {
  const members = await prisma.membership.findMany({
    where:   scopedWhere(req, { status: { not: 'removed' } }),
    include: { user: { select: { id: true, name: true, email: true, userName: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return apiResponse.send(res, 'SUCCESS', { members: members.map(publicMember) });
}

// ── PATCH /orgs/:orgId/members/:membershipId — change role or remove ──────────
async function updateMember(req, res) {
  const { role, status } = req.body;
  const actorRole = req.membership.role;

  // Tenant-scoped lookup: a membershipId belonging to another organization is
  // simply not found here, so this can safely be a 404 without leaking anything.
  const target = await prisma.membership.findFirst({
    where:   scopedWhere(req, { id: req.params.membershipId }),
    include: { user: { select: { id: true, name: true, email: true, userName: true } } },
  });
  if (!target) return apiResponse.send(res, 'NOT_FOUND', { message: 'Membership not found.' });

  if (target.id === req.membership.id) {
    return apiResponse.send(res, 'FORBIDDEN', { message: 'You cannot change your own membership.' });
  }
  if (target.role === 'owner' && actorRole !== 'owner') {
    return apiResponse.send(res, 'FORBIDDEN', { message: 'Only an owner can modify another owner.' });
  }
  if (role === 'owner' && actorRole !== 'owner') {
    return apiResponse.send(res, 'FORBIDDEN', { message: 'Only an owner can grant ownership.' });
  }

  const updated = await prisma.membership.update({
    where: { id: target.id },
    data:  {
      ...(role ? { role } : {}),
      // Soft removal — the row survives for audit/history and is reactivated by
      // a future invitation rather than re-created.
      ...(status === 'removed' ? { status: 'removed' } : {}),
    },
    include: { user: { select: { id: true, name: true, email: true, userName: true } } },
  });

  await auditLogger(status === 'removed' ? 'ORG_MEMBER_REMOVED' : 'ORG_MEMBER_ROLE_CHANGED', req.user, req,
    { organizationId: req.organizationId });
  return apiResponse.send(res, 'SUCCESS', { member: publicMember(updated) });
}

// ── DELETE /orgs/:orgId — owner only ──────────────────────────────────────────
// Hard delete. Memberships and invitations are FK ON DELETE CASCADE: once the
// tenant is gone there is no tenant left to scope them to, and keeping orphaned
// membership rows would defeat the unique(userId, organizationId) reactivation
// path. The AuditLog row is the surviving record of the deletion.
async function deleteOrganization(req, res) {
  const organizationId = req.organizationId;
  // Audit BEFORE delete, not after: AuditLog.organizationId is a real FK, so a
  // row written once the organization is gone would have nothing to point at
  // and fail to insert (auditLogger swallows that, silently losing the very
  // row meant to record the deletion). Logging first means the FK still
  // resolves; the existing SET NULL behavior takes over for this row (and
  // every earlier one on this org) the moment the delete below commits.
  await auditLogger('ORG_DELETED', req.user, req, { organizationId });
  await prisma.organization.delete({ where: { id: organizationId } });
  return apiResponse.send(res, 'SUCCESS', { message: 'Organization deleted.' });
}

// ── PATCH /orgs/:orgId — update name/settings/branding (owner/admin) ──────────
async function updateOrganization(req, res) {
  const { name, settings, logoUrl, primaryColor } = req.body;

  const updated = await prisma.organization.update({
    where: { id: req.organizationId },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(settings !== undefined ? { settings } : {}),
      ...(logoUrl !== undefined ? { logoUrl } : {}),
      ...(primaryColor !== undefined ? { primaryColor } : {}),
    },
  });

  await auditLogger('ORG_UPDATED', req.user, req, { organizationId: req.organizationId });
  return apiResponse.send(res, 'SUCCESS', { organization: publicOrg(updated) });
}

// ── GET /orgs/:orgId/usage — any active member ─────────────────────────────────
// Extensible registry: each producer returns { key, count } for one tenant-owned
// resource, scoped via scopedWhere so it can never leak across tenants. No other
// tenant-owned models exist in this codebase yet (files/billing/notifications are
// being built in parallel), so this starts with just members + invitations.
//
// HOW A FUTURE MODULE REGISTERS ITS OWN COUNT (e.g. backend/modules/files):
//   USAGE_PRODUCERS.push({
//     key: 'files',
//     count: (req) => require('../../files/services/FileService')
//       .prisma.file.count({ where: scopedWhere(req) }),
//   });
// — or, to avoid a require cycle, just add a line to this array once the model
// exists. Nothing else in this file needs to change.
const USAGE_PRODUCERS = [
  {
    key:   'members',
    count: (req) => prisma.membership.count({ where: scopedWhere(req, { status: 'active' }) }),
  },
  {
    key:   'pendingInvitations',
    count: (req) => prisma.invitation.count({
      where: scopedWhere(req, { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }),
    }),
  },
];

async function getUsageSummary(req, res) {
  const usage = await Promise.all(
    USAGE_PRODUCERS.map(async ({ key, count }) => ({ key, count: await count(req) }))
  );
  return apiResponse.send(res, 'SUCCESS', { usage });
}

// ── GET /orgs/:orgId/audit-log — owner/admin, paginated ────────────────────────
async function getAuditLog(req, res) {
  const { skip, take, meta } = paginate(req.query);
  const where = scopedWhere(req);

  const [entries, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.auditLog.count({ where }),
  ]);

  return apiResponse.send(res, 'SUCCESS', {
    entries: entries.map((e) => ({
      id:        e.id,
      action:    e.action,
      userId:    e.userId,
      userName:  e.userName,
      userRole:  e.userRole,
      ipAddress: e.ipAddress,
      createdAt: e.createdAt,
    })),
    pagination: meta(total),
  });
}

module.exports = {
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
};

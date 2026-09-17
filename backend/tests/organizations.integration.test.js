// Multi-tenancy integration tests (supertest) — run against a REAL Postgres + Redis.
// Covers the tenant isolation bar: cross-tenant access, single-use invitations
// under concurrency, the org permission matrix, suspended orgs, and per-request
// (non-sticky) tenant resolution.
//
// Enable with:  RUN_INTEGRATION=1 npm run test:integration
// (or set TEST_DATABASE_URL). Skips cleanly when infra is absent so plain
// `npm test` still passes without a database.
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const ENABLED = process.env.RUN_INTEGRATION === '1' || !!process.env.TEST_DATABASE_URL;
const skip    = ENABLED ? false : 'integration infra not configured (set RUN_INTEGRATION=1)';

if (ENABLED) {
  // ── Env must be set BEFORE any infra module is required ─────────────────────
  process.env.DATABASE_URL   = process.env.TEST_DATABASE_URL || 'postgresql://postgres:test@localhost:55432/framework?schema=public';
  process.env.REDIS_HOST     = process.env.TEST_REDIS_HOST || '127.0.0.1';
  process.env.REDIS_PORT     = process.env.TEST_REDIS_PORT || '56379';
  process.env.JWT_SECRET     = process.env.TEST_JWT_SECRET || 'itest-jwt-secret-itest-jwt-secret-0000000000';
  process.env.REFRESH_SECRET = process.env.TEST_REFRESH_SECRET || 'itest-refresh-secret-itest-refresh-0000000000';
  process.env.REFRESH_EXPIRY = '7d';
  process.env.SMTP_HOST      = ''; // dev email mode (logs the invite, doesn't send)
  process.env.TRUST_PROXY    = '1';
}

// Infra modules are required LAZILY inside before() — see auth.integration.test.js.
let express, supertest, bcrypt, multer, crypto;
let prisma, client, redisReady, routes, apiResponse;
let request;

function buildApp() {
  const app = express();
  app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1', routes);
  app.use('/api/v1', (req, res) => apiResponse.send(res, 'NOT_FOUND'));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof multer.MulterError || err.type === 'entity.too.large') {
      return apiResponse.send(res, 'INVALID_REQUEST', { message: err.message });
    }
    console.error('[test app]', err);
    return apiResponse.send(res, 'SERVER_ERROR');
  });
  return app;
}

const PREFIX      = 'otest_';
const SLUG_PREFIX = 'otest-'; // slugs are hyphen-only by validation
const uniq     = (p) => `${PREFIX}${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const uniqSlug = (p) => `${SLUG_PREFIX}${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Every actor gets a real login so the tests exercise the whole verifyToken chain.
async function makeUser(prefix) {
  const userName = uniq(prefix);
  const email    = `${userName}@test.local`;
  const password = 'Str0ng!Passw0rd';
  // emailVerifiedAt is seeded because creating an organization is gated on a
  // confirmed address (middleware/requireVerifiedEmail.js). These actors model
  // real, onboarded users; the unverified path is covered in
  // tests/onboardingSessions.integration.test.js.
  const user = await prisma.user.create({
    data: {
      userName, email, name: 'Org Test', password: bcrypt.hashSync(password, 12),
      role: 'admin', emailVerifiedAt: new Date(),
    },
  });
  const login = await request.post('/api/v1/common/auth/login').send({ userName, password });
  assert.strictEqual(login.status, 200, 'seed user should be able to log in');
  return { id: user.id, userName, email, token: login.body.responseData.result.token };
}

const result = (res) => res.body.responseData.result;

const auth   = (actor) => ({ Authorization: `Bearer ${actor.token}` });

// Create an org through the API so the owner membership is created the real way.
async function createOrg(actor, name) {
  const res = await request.post('/api/v1/orgs').set(auth(actor)).send({ name, slug: uniqSlug('slug') });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return result(res).organization;
}

async function inviteAndAccept(inviter, org, invitee, role) {
  const inv = await request.post(`/api/v1/orgs/${org.id}/invitations`)
    .set(auth(inviter)).send({ email: invitee.email, role });
  assert.strictEqual(inv.status, 201, JSON.stringify(inv.body));

  const raw = await rawTokenFor(org.id, invitee.email);
  const acc = await request.post(`/api/v1/orgs/invitations/${raw}/accept`).set(auth(invitee));
  assert.strictEqual(acc.status, 200, JSON.stringify(acc.body));
  return acc;
}

// The API never returns the raw invitation token — correctly: it is emailed once
// and only its sha256 is persisted, so a test cannot read it back. To drive the
// accept path end-to-end, the test mints its OWN token and overwrites the pending
// row's tokenHash with that token's hash. Everything after this point (lookup,
// expiry/revocation checks, email match, atomic single-use claim, membership
// upsert) is the production code path, unmodified.
async function rawTokenFor(organizationId, email) {
  const raw  = crypto.randomBytes(48).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const pending = await prisma.invitation.findFirst({
    where: { organizationId, email: email.toLowerCase(), acceptedAt: null, revokedAt: null },
  });
  assert.ok(pending, 'a pending invitation row should exist');
  await prisma.invitation.update({ where: { id: pending.id }, data: { tokenHash: hash } });
  return raw;
}

before(async () => {
  if (!ENABLED) return;
  express     = require('express');
  supertest   = require('supertest');
  bcrypt      = require('bcrypt');
  multer      = require('multer');
  crypto      = require('node:crypto');
  prisma      = require('../config/dbConnect');
  ({ client, redisReady } = require('../config/redisConfig'));
  routes      = require('../routes');
  apiResponse = require('../helpers/apiResponse');

  await redisReady;
  request = supertest(buildApp());
});

after(async () => {
  if (!ENABLED) return;
  try {
    // Organization delete cascades memberships + invitations; users cascade their
    // refresh tokens. AuditLog.userId is SET NULL, so those rows survive — drop
    // the ones this suite wrote so the table does not grow unbounded.
    await prisma.organization.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
    await prisma.auditLog.deleteMany({ where: { user: { userName: { startsWith: PREFIX } } } });
    await prisma.refreshToken.deleteMany({ where: { user: { userName: { startsWith: PREFIX } } } });
    await prisma.user.deleteMany({ where: { userName: { startsWith: PREFIX } } });
  } catch (err) {
    console.error('[otest after] cleanup failed:', err.message);
  } finally {
    await prisma.$disconnect();
    client.quit().catch(() => {});
  }
});

// ── Happy path: full lifecycle ────────────────────────────────────────────────

test('lifecycle: create → invite → accept → list → change role → remove → delete', { skip }, async () => {
  const owner  = await makeUser('owner');
  const invitee = await makeUser('invitee');
  const org    = await createOrg(owner, 'Lifecycle Inc');

  // Creator is owner.
  const mine = await request.get('/api/v1/orgs').set(auth(owner));
  assert.strictEqual(mine.status, 200);
  const listed = result(mine).organizations.find(o => o.id === org.id);
  assert.strictEqual(listed.role, 'owner');

  await inviteAndAccept(owner, org, invitee, 'member');

  const members = await request.get(`/api/v1/orgs/${org.id}/members`).set(auth(owner));
  assert.strictEqual(members.status, 200);
  assert.strictEqual(result(members).members.length, 2);
  const target = result(members).members.find(m => m.userId === invitee.id);
  assert.strictEqual(target.role, 'member');
  assert.strictEqual(target.status, 'active');

  // Promote to admin.
  const promoted = await request.patch(`/api/v1/orgs/${org.id}/members/${target.id}`)
    .set(auth(owner)).send({ role: 'admin' });
  assert.strictEqual(promoted.status, 200);
  assert.strictEqual(result(promoted).member.role, 'admin');

  // Soft-remove: the row survives with status 'removed'.
  const removed = await request.patch(`/api/v1/orgs/${org.id}/members/${target.id}`)
    .set(auth(owner)).send({ status: 'removed' });
  assert.strictEqual(removed.status, 200);
  assert.strictEqual(result(removed).member.status, 'removed');
  const stillThere = await prisma.membership.findFirst({ where: { id: target.id } });
  assert.strictEqual(stillThere.status, 'removed', 'membership must be soft-deleted, not dropped');

  // A removed member is no longer in tenant context.
  const afterRemoval = await request.get(`/api/v1/orgs/${org.id}/members`).set(auth(invitee));
  assert.strictEqual(afterRemoval.status, 403);

  // Owner deletes the org.
  const del = await request.delete(`/api/v1/orgs/${org.id}`).set(auth(owner));
  assert.strictEqual(del.status, 200);
  assert.strictEqual(await prisma.organization.findUnique({ where: { id: org.id } }), null);
  assert.strictEqual(await prisma.membership.count({ where: { organizationId: org.id } }), 0,
    'org delete cascades memberships');
});

// ── Cross-tenant isolation ────────────────────────────────────────────────────

test('isolation: user A cannot touch user B\'s organization by any org-scoped route', { skip }, async () => {
  const a = await makeUser('a');
  const b = await makeUser('b');
  const c = await makeUser('c');
  const org1 = await createOrg(a, 'Org One');
  const org2 = await createOrg(b, 'Org Two');

  // A's own org still works — proving the 403s below are about tenancy, not auth.
  assert.strictEqual((await request.get(`/api/v1/orgs/${org1.id}/members`).set(auth(a))).status, 200);

  // CONVENTION: a non-member always gets 403, never 404 — a real org id and a
  // fabricated one must be indistinguishable (no tenant enumeration).
  const readOther = await request.get(`/api/v1/orgs/${org2.id}/members`).set(auth(a));
  assert.strictEqual(readOther.status, 403);
  assert.strictEqual(readOther.body.responseCode, 1003);

  const inviteOther = await request.post(`/api/v1/orgs/${org2.id}/invitations`)
    .set(auth(a)).send({ email: c.email, role: 'admin' });
  assert.strictEqual(inviteOther.status, 403);

  const deleteOther = await request.delete(`/api/v1/orgs/${org2.id}`).set(auth(a));
  assert.strictEqual(deleteOther.status, 403);

  // A syntactically valid but nonexistent org id gets the SAME 403 + same body.
  const ghost = await request.get('/api/v1/orgs/clzzzzzzzzzzzzzzzzzzzzzzzz/members').set(auth(a));
  assert.strictEqual(ghost.status, 403);
  assert.deepStrictEqual(ghost.body, readOther.body, 'nonexistent and forbidden orgs must be indistinguishable');

  // A's org listing must not mention org 2.
  const mine = result(await request.get('/api/v1/orgs').set(auth(a))).organizations;
  assert.ok(mine.every(o => o.id !== org2.id));

  // And the member list of org 2 never contains A.
  const b2 = result(await request.get(`/api/v1/orgs/${org2.id}/members`).set(auth(b))).members;
  assert.ok(b2.every(m => m.userId !== a.id));
});

test('isolation: header and URL org must agree (no stale-tab cross-tenant writes)', { skip }, async () => {
  const a = await makeUser('hdr');
  const org1 = await createOrg(a, 'Header One');
  const org2 = await createOrg(a, 'Header Two');

  const mismatch = await request.get(`/api/v1/orgs/${org1.id}/members`)
    .set(auth(a)).set('X-Organization-Id', org2.id);
  assert.strictEqual(mismatch.status, 400);
});

// ── Per-request tenant resolution (not sticky server state) ───────────────────

test('context is per-request: same user, two orgs, two different answers', { skip }, async () => {
  const u    = await makeUser('multi');
  const mate = await makeUser('mate');
  const org1 = await createOrg(u, 'Multi One');
  const org2 = await createOrg(u, 'Multi Two');

  // Give org 2 an extra member so the two member lists differ in content.
  await inviteAndAccept(u, org2, mate, 'viewer');

  // Interleave the requests: if tenancy were sticky server state, the second
  // call in each pair would answer for the previously-seen org.
  for (let i = 0; i < 3; i += 1) {
    const one = await request.get(`/api/v1/orgs/${org1.id}/members`)
      .set(auth(u)).set('X-Organization-Id', org1.id);
    const two = await request.get(`/api/v1/orgs/${org2.id}/members`)
      .set(auth(u)).set('X-Organization-Id', org2.id);

    assert.strictEqual(result(one).members.length, 1, 'org 1 has only the owner');
    assert.strictEqual(result(two).members.length, 2, 'org 2 has the owner + viewer');
    assert.ok(result(one).members.every(m => m.userId !== mate.id));
    assert.ok(result(two).members.some(m => m.userId === mate.id));
  }
});

// ── Invitations: single use under concurrency ─────────────────────────────────

test('invitation: concurrent accepts — exactly one wins', { skip }, async () => {
  const owner   = await makeUser('cowner');
  const invitee = await makeUser('cinvitee');
  const org     = await createOrg(owner, 'Concurrent Inc');

  const inv = await request.post(`/api/v1/orgs/${org.id}/invitations`)
    .set(auth(owner)).send({ email: invitee.email, role: 'member' });
  assert.strictEqual(inv.status, 201);
  const raw = await rawTokenFor(org.id, invitee.email);

  const attempts = await Promise.all(
    Array.from({ length: 5 }, () =>
      request.post(`/api/v1/orgs/invitations/${raw}/accept`).set(auth(invitee))
    )
  );
  const ok = attempts.filter(r => r.status === 200);
  assert.strictEqual(ok.length, 1, `exactly one accept should succeed, got ${ok.length}`);
  assert.ok(attempts.filter(r => r.status === 400).length === 4);

  // Exactly one membership row, and the invitation is consumed.
  assert.strictEqual(
    await prisma.membership.count({ where: { organizationId: org.id, userId: invitee.id } }), 1);
  const row = await prisma.invitation.findFirst({ where: { organizationId: org.id, email: invitee.email } });
  assert.ok(row.acceptedAt, 'invitation must be marked accepted');

  // Replay after the fact is dead too.
  const replay = await request.post(`/api/v1/orgs/invitations/${raw}/accept`).set(auth(invitee));
  assert.strictEqual(replay.status, 400);
});

test('invitation: a mismatched account email cannot accept', { skip }, async () => {
  const owner   = await makeUser('mowner');
  const invitee = await makeUser('minvitee');
  const stranger = await makeUser('mstranger');
  const org     = await createOrg(owner, 'Mismatch Inc');

  await request.post(`/api/v1/orgs/${org.id}/invitations`)
    .set(auth(owner)).send({ email: invitee.email, role: 'member' });
  const raw = await rawTokenFor(org.id, invitee.email);

  const stolen = await request.post(`/api/v1/orgs/invitations/${raw}/accept`).set(auth(stranger));
  assert.strictEqual(stolen.status, 403);
  assert.strictEqual(await prisma.membership.count({ where: { organizationId: org.id, userId: stranger.id } }), 0);

  // The rightful invitee still can.
  const ok = await request.post(`/api/v1/orgs/invitations/${raw}/accept`).set(auth(invitee));
  assert.strictEqual(ok.status, 200);
});

test('invitation: a garbage token → 400, and duplicate pending invites → 409', { skip }, async () => {
  const owner   = await makeUser('downer');
  const invitee = await makeUser('dinvitee');
  const org     = await createOrg(owner, 'Duplicate Inc');

  const bad = await request.post('/api/v1/orgs/invitations/not-a-real-token/accept').set(auth(owner));
  assert.strictEqual(bad.status, 400);

  const first = await request.post(`/api/v1/orgs/${org.id}/invitations`)
    .set(auth(owner)).send({ email: invitee.email, role: 'member' });
  assert.strictEqual(first.status, 201);

  // Partial unique index Invitation_org_email_pending_key.
  const second = await request.post(`/api/v1/orgs/${org.id}/invitations`)
    .set(auth(owner)).send({ email: invitee.email, role: 'admin' });
  assert.strictEqual(second.status, 409);
});

// ── Permission matrix ─────────────────────────────────────────────────────────

test('permissions: member and viewer cannot invite, remove, change roles, or delete', { skip }, async () => {
  const owner   = await makeUser('powner');
  const member  = await makeUser('pmember');
  const viewer  = await makeUser('pviewer');
  const outsider = await makeUser('poutsider');
  const org     = await createOrg(owner, 'Permissions Inc');

  await inviteAndAccept(owner, org, member, 'member');
  await inviteAndAccept(owner, org, viewer, 'viewer');

  const members = result(await request.get(`/api/v1/orgs/${org.id}/members`).set(auth(owner))).members;
  const memberRow = members.find(m => m.userId === member.id);

  for (const actor of [member, viewer]) {
    // Reading IS allowed for every active member, viewer included.
    assert.strictEqual((await request.get(`/api/v1/orgs/${org.id}/members`).set(auth(actor))).status, 200);

    assert.strictEqual((await request.post(`/api/v1/orgs/${org.id}/invitations`)
      .set(auth(actor)).send({ email: outsider.email, role: 'member' })).status, 403);

    assert.strictEqual((await request.patch(`/api/v1/orgs/${org.id}/members/${memberRow.id}`)
      .set(auth(actor)).send({ role: 'admin' })).status, 403);

    assert.strictEqual((await request.patch(`/api/v1/orgs/${org.id}/members/${memberRow.id}`)
      .set(auth(actor)).send({ status: 'removed' })).status, 403);

    assert.strictEqual((await request.delete(`/api/v1/orgs/${org.id}`).set(auth(actor))).status, 403);
  }
});

test('permissions: an admin cannot mint owners, touch the owner, or self-promote', { skip }, async () => {
  const owner  = await makeUser('aowner');
  const admin  = await makeUser('aadmin');
  const member = await makeUser('amember');
  const guest  = await makeUser('aguest');
  const org    = await createOrg(owner, 'Admin Guards Inc');

  await inviteAndAccept(owner, org, admin, 'admin');
  await inviteAndAccept(owner, org, member, 'member');

  const members   = result(await request.get(`/api/v1/orgs/${org.id}/members`).set(auth(admin))).members;
  const ownerRow  = members.find(m => m.userId === owner.id);
  const adminRow  = members.find(m => m.userId === admin.id);
  const memberRow = members.find(m => m.userId === member.id);

  // Cannot promote anyone to owner…
  assert.strictEqual((await request.patch(`/api/v1/orgs/${org.id}/members/${memberRow.id}`)
    .set(auth(admin)).send({ role: 'owner' })).status, 403);
  // …nor invite one.
  assert.strictEqual((await request.post(`/api/v1/orgs/${org.id}/invitations`)
    .set(auth(admin)).send({ email: guest.email, role: 'owner' })).status, 403);
  // …nor themselves (self-modification is blocked outright).
  assert.strictEqual((await request.patch(`/api/v1/orgs/${org.id}/members/${adminRow.id}`)
    .set(auth(admin)).send({ role: 'owner' })).status, 403);

  // Cannot demote or remove the owner.
  assert.strictEqual((await request.patch(`/api/v1/orgs/${org.id}/members/${ownerRow.id}`)
    .set(auth(admin)).send({ role: 'member' })).status, 403);
  assert.strictEqual((await request.patch(`/api/v1/orgs/${org.id}/members/${ownerRow.id}`)
    .set(auth(admin)).send({ status: 'removed' })).status, 403);

  // The owner is still an owner and the admin is still an admin.
  const after = result(await request.get(`/api/v1/orgs/${org.id}/members`).set(auth(owner))).members;
  assert.strictEqual(after.find(m => m.userId === owner.id).role, 'owner');
  assert.strictEqual(after.find(m => m.userId === admin.id).role, 'admin');

  // What an admin CAN do: manage a non-owner.
  assert.strictEqual((await request.patch(`/api/v1/orgs/${org.id}/members/${memberRow.id}`)
    .set(auth(admin)).send({ role: 'viewer' })).status, 200);
  // But not delete the org.
  assert.strictEqual((await request.delete(`/api/v1/orgs/${org.id}`).set(auth(admin))).status, 403);
});

test('permissions: a membershipId from another org is not found (tenant-scoped lookup)', { skip }, async () => {
  const a = await makeUser('xowner');
  const b = await makeUser('yowner');
  const orgA = await createOrg(a, 'Scoped A');
  const orgB = await createOrg(b, 'Scoped B');

  const bRow = result(await request.get(`/api/v1/orgs/${orgB.id}/members`).set(auth(b))).members[0];

  // A is an owner of orgA, so authorization passes — the tenant-scoped lookup is
  // what stops the write, and it cannot confirm the foreign row exists.
  const res = await request.patch(`/api/v1/orgs/${orgA.id}/members/${bRow.id}`)
    .set(auth(a)).send({ role: 'viewer' });
  assert.strictEqual(res.status, 404);
  const untouched = await prisma.membership.findUnique({ where: { id: bRow.id } });
  assert.strictEqual(untouched.role, 'owner');
});

// ── Suspended organization ────────────────────────────────────────────────────

test('suspended org: every member is rejected from org-scoped routes', { skip }, async () => {
  const owner  = await makeUser('sowner');
  const member = await makeUser('smember');
  const org    = await createOrg(owner, 'Suspended Inc');
  await inviteAndAccept(owner, org, member, 'member');

  await prisma.organization.update({ where: { id: org.id }, data: { status: 'suspended' } });

  for (const actor of [owner, member]) {
    assert.strictEqual((await request.get(`/api/v1/orgs/${org.id}/members`).set(auth(actor))).status, 403);
  }
  // Even the owner cannot delete a suspended org — tenantContext runs first.
  assert.strictEqual((await request.delete(`/api/v1/orgs/${org.id}`).set(auth(owner))).status, 403);

  // It still LISTS (with its status) so the UI can explain why it is unusable.
  const listed = result(await request.get('/api/v1/orgs').set(auth(owner))).organizations
    .find(o => o.id === org.id);
  assert.strictEqual(listed.status, 'suspended');

  // Reinstating restores access — proving the block was the org status, nothing else.
  await prisma.organization.update({ where: { id: org.id }, data: { status: 'active' } });
  assert.strictEqual((await request.get(`/api/v1/orgs/${org.id}/members`).set(auth(owner))).status, 200);
});

// ── Auth + validation boundaries ──────────────────────────────────────────────

test('org routes require authentication', { skip }, async () => {
  assert.strictEqual((await request.get('/api/v1/orgs')).status, 401);
  assert.strictEqual((await request.post('/api/v1/orgs').send({ name: 'Nope' })).status, 401);
});

test('validation: bad slug / short name / unknown role → 400, duplicate slug → 409', { skip }, async () => {
  const u = await makeUser('vowner');

  assert.strictEqual((await request.post('/api/v1/orgs').set(auth(u))
    .send({ name: 'X' })).status, 400);
  assert.strictEqual((await request.post('/api/v1/orgs').set(auth(u))
    .send({ name: 'Valid Name', slug: 'Not A Slug!' })).status, 400);

  const slug = uniqSlug('dupslug');
  assert.strictEqual((await request.post('/api/v1/orgs').set(auth(u))
    .send({ name: 'First', slug })).status, 201);
  assert.strictEqual((await request.post('/api/v1/orgs').set(auth(u))
    .send({ name: 'Second', slug })).status, 409);

  const org = await createOrg(u, 'Validation Inc');
  assert.strictEqual((await request.post(`/api/v1/orgs/${org.id}/invitations`).set(auth(u))
    .send({ email: 'someone@test.local', role: 'sysadmin' })).status, 400);
  assert.strictEqual((await request.post(`/api/v1/orgs/${org.id}/invitations`).set(auth(u))
    .send({ email: 'not-an-email', role: 'member' })).status, 400);
});

// File module integration tests (supertest) — run against a REAL Postgres +
// Redis, but a FAKE in-memory object store (fileStorage's exported functions
// are swapped with node:test's built-in mock.method — no AWS credentials
// needed). Real Prisma queries, real tenant-scoping, real upload validation.
//
// Enable with:  RUN_INTEGRATION=1 npm run test:integration
// (or set TEST_DATABASE_URL). Skips cleanly when infra is absent so plain
// `npm test` still passes without a database.
const { test, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const path   = require('node:path');
const fs     = require('node:fs');

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
  process.env.SMTP_HOST      = '';
  process.env.TRUST_PROXY    = '1';
  // Tiny quota so the enforcement test doesn't need hundreds of real uploads.
  process.env.FILES_STORAGE_QUOTA_FILE_COUNT = '3';
  process.env.FILES_STORAGE_QUOTA_BYTES      = '1000000';
}

const FIXTURES = path.join(__dirname, 'fixtures');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name));

let express, supertest, bcrypt, multer, crypto;
let prisma, client, redisReady, routes, apiResponse, fileStorage;
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

const PREFIX      = 'ftest_';
const SLUG_PREFIX = 'ftest-';
const uniq     = (p) => `${PREFIX}${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const uniqSlug = (p) => `${SLUG_PREFIX}${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function makeUser(prefix) {
  const userName = uniq(prefix);
  const email    = `${userName}@test.local`;
  const password = 'Str0ng!Passw0rd';
  const user = await prisma.user.create({
    data: { userName, email, name: 'File Test', password: bcrypt.hashSync(password, 12), role: 'admin' },
  });
  const login = await request.post('/api/v1/common/auth/login').send({ userName, password });
  assert.strictEqual(login.status, 200, 'seed user should be able to log in');
  return { id: user.id, userName, email, token: login.body.responseData.result.token };
}

const result = (res) => res.body.responseData.result;
const auth   = (actor) => ({ Authorization: `Bearer ${actor.token}` });

async function createOrg(actor, name) {
  const res = await request.post('/api/v1/orgs').set(auth(actor)).send({ name, slug: uniqSlug('slug') });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return result(res).organization;
}

async function addMember(inviter, org, invitee, role) {
  const inv = await request.post(`/api/v1/orgs/${org.id}/invitations`)
    .set(auth(inviter)).send({ email: invitee.email, role });
  assert.strictEqual(inv.status, 201, JSON.stringify(inv.body));

  const raw = crypto.randomBytes(48).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const pending = await prisma.invitation.findFirst({
    where: { organizationId: org.id, email: invitee.email.toLowerCase(), acceptedAt: null, revokedAt: null },
  });
  assert.ok(pending, 'a pending invitation row should exist');
  await prisma.invitation.update({ where: { id: pending.id }, data: { tokenHash: hash } });

  const acc = await request.post(`/api/v1/orgs/invitations/${raw}/accept`).set(auth(invitee));
  assert.strictEqual(acc.status, 200, JSON.stringify(acc.body));
}

// ── Fake in-memory object store ────────────────────────────────────────────────
// Swaps fileStorage's exported functions so no real AWS call is ever made.
// Routes/services still call fileStorage.uploadObject/getSignedDownloadUrl/
// deleteObject exactly as in production — only the implementation differs.
const fakeBucket = new Map();

function armFakeStorage() {
  mock.method(fileStorage, 'uploadObject', async (buffer, key) => {
    fakeBucket.set(key, buffer);
    return { key };
  });
  mock.method(fileStorage, 'getSignedDownloadUrl', async (key, expirySeconds = 300) => {
    return `https://fake-bucket.test/${encodeURIComponent(key)}?expires=${expirySeconds}`;
  });
  mock.method(fileStorage, 'deleteObject', async (key) => {
    fakeBucket.delete(key);
  });
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
  fileStorage = require('../helpers/fileStorage');

  await redisReady;
  request = supertest(buildApp());
});

beforeEach(() => {
  if (!ENABLED) return;
  armFakeStorage();
});

afterEach(() => {
  if (!ENABLED) return;
  mock.restoreAll();
  fakeBucket.clear();
});

after(async () => {
  if (!ENABLED) return;
  try {
    await prisma.file.deleteMany({ where: { organization: { slug: { startsWith: SLUG_PREFIX } } } });
    await prisma.organization.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
    await prisma.auditLog.deleteMany({ where: { user: { userName: { startsWith: PREFIX } } } });
    await prisma.refreshToken.deleteMany({ where: { user: { userName: { startsWith: PREFIX } } } });
    await prisma.user.deleteMany({ where: { userName: { startsWith: PREFIX } } });
  } catch (err) {
    console.error('[ftest after] cleanup failed:', err.message);
  } finally {
    await prisma.$disconnect();
    client.quit().catch(() => {});
  }
});

// ── Happy path: full lifecycle ────────────────────────────────────────────────

test('lifecycle: upload → list → get metadata → get signed download URL → delete', { skip }, async () => {
  const owner = await makeUser('owner');
  const org   = await createOrg(owner, 'Files Inc');

  const upload = await request.post(`/api/v1/orgs/${org.id}/files`)
    .set(auth(owner))
    .attach('file', read('tiny.png'), { filename: 'logo.png', contentType: 'image/png' });
  assert.strictEqual(upload.status, 201, JSON.stringify(upload.body));
  const file = result(upload).file;
  assert.strictEqual(file.filename, 'logo.png');
  assert.strictEqual(file.mimeType, 'image/png');
  assert.strictEqual(file.status, 'active');
  assert.strictEqual(file.storageKey, undefined, 'storageKey must never be exposed to the client');

  // The fake bucket actually received the object, namespaced by org + file id.
  const storedKeys = [...fakeBucket.keys()];
  assert.ok(storedKeys.some((k) => k.startsWith(`orgs/${org.id}/${file.id}/`)),
    'storage key must be namespaced by organization and file id');

  const list = await request.get(`/api/v1/orgs/${org.id}/files`).set(auth(owner));
  assert.strictEqual(list.status, 200);
  assert.ok(result(list).files.some((f) => f.id === file.id));
  assert.ok(result(list).pagination);

  const meta = await request.get(`/api/v1/orgs/${org.id}/files/${file.id}`).set(auth(owner));
  assert.strictEqual(meta.status, 200);
  assert.strictEqual(result(meta).file.id, file.id);
  assert.strictEqual(result(meta).file.storageKey, undefined);

  const download = await request.get(`/api/v1/orgs/${org.id}/files/${file.id}/download`).set(auth(owner));
  assert.strictEqual(download.status, 200);
  assert.ok(result(download).url.startsWith('https://fake-bucket.test/'));
  assert.strictEqual(result(download).expiresIn, 300);

  const del = await request.delete(`/api/v1/orgs/${org.id}/files/${file.id}`).set(auth(owner));
  assert.strictEqual(del.status, 200);

  const row = await prisma.file.findUnique({ where: { id: file.id } });
  assert.strictEqual(row.status, 'deleted', 'DB row is soft-deleted, not removed');
  assert.ok(row.deletedAt);
  assert.strictEqual(fakeBucket.has(row.storageKey), false, 'underlying object must actually be removed from storage');

  // Soft-deleted files are not listed / not found by id anymore.
  const afterDelete = await request.get(`/api/v1/orgs/${org.id}/files/${file.id}`).set(auth(owner));
  assert.strictEqual(afterDelete.status, 404);
});

// ── Cross-tenant isolation ────────────────────────────────────────────────────

test('isolation: org A cannot see/download/delete org B\'s files, including a fabricated fileId', { skip }, async () => {
  const a = await makeUser('a');
  const b = await makeUser('b');
  const orgA = await createOrg(a, 'Org A');
  const orgB = await createOrg(b, 'Org B');

  const upload = await request.post(`/api/v1/orgs/${orgB.id}/files`)
    .set(auth(b))
    .attach('file', read('tiny.pdf'), { filename: 'secret.pdf', contentType: 'application/pdf' });
  assert.strictEqual(upload.status, 201);
  const bFile = result(upload).file;

  // A is not a member of org B at all → tenantContext denies before the file lookup.
  const getOther = await request.get(`/api/v1/orgs/${orgB.id}/files/${bFile.id}`).set(auth(a));
  assert.strictEqual(getOther.status, 403);

  const downloadOther = await request.get(`/api/v1/orgs/${orgB.id}/files/${bFile.id}/download`).set(auth(a));
  assert.strictEqual(downloadOther.status, 403);

  const deleteOther = await request.delete(`/api/v1/orgs/${orgB.id}/files/${bFile.id}`).set(auth(a));
  assert.strictEqual(deleteOther.status, 403);

  // Even a member of org A cannot reach org B's file by pointing org A's id at
  // B's fileId — scopedWhere means the row simply isn't found under org A.
  const wrongOrgLookup = await request.get(`/api/v1/orgs/${orgA.id}/files/${bFile.id}`).set(auth(a));
  assert.strictEqual(wrongOrgLookup.status, 404);

  // A syntactically valid but fabricated fileId under A's own (real) org: 404,
  // not a leak, not a 500.
  const fabricated = await request.get(`/api/v1/orgs/${orgA.id}/files/clzzzzzzzzzzzzzzzzzzzzzzzz`).set(auth(a));
  assert.strictEqual(fabricated.status, 404);

  // Org A's listing never contains org B's file.
  const listA = result(await request.get(`/api/v1/orgs/${orgA.id}/files`).set(auth(a))).files;
  assert.ok(listA.every((f) => f.id !== bFile.id));

  // The object is still in the fake bucket — none of the above should have deleted it.
  assert.ok([...fakeBucket.keys()].some((k) => k.includes(bFile.id)));
});

// ── Non-member cannot upload ────────────────────────────────────────────────────

test('a non-member cannot upload to an organization they do not belong to', { skip }, async () => {
  const owner   = await makeUser('owner2');
  const outsider = await makeUser('outsider');
  const org = await createOrg(owner, 'Members Only');

  const upload = await request.post(`/api/v1/orgs/${org.id}/files`)
    .set(auth(outsider))
    .attach('file', read('tiny.png'), { filename: 'x.png', contentType: 'image/png' });
  assert.strictEqual(upload.status, 403);
  assert.strictEqual(fakeBucket.size, 0, 'nothing should have reached storage');
});

// ── Disguised file type ──────────────────────────────────────────────────────────

test('a PNG relabeled as a PDF (wrong magic bytes for the declared mimetype) is rejected', { skip }, async () => {
  const owner = await makeUser('owner3');
  const org = await createOrg(owner, 'Disguise Co');

  const upload = await request.post(`/api/v1/orgs/${org.id}/files`)
    .set(auth(owner))
    .attach('file', read('tiny.png'), { filename: 'fake.pdf', contentType: 'application/pdf' });
  assert.strictEqual(upload.status, 400);
  assert.strictEqual(await prisma.file.count({ where: { organizationId: org.id } }), 0);
  assert.strictEqual(fakeBucket.size, 0);
});

// ── Storage quota enforcement ────────────────────────────────────────────────────

test('storage quota: file-count limit rejects the next upload with a clear error, not a 500', { skip }, async () => {
  const owner = await makeUser('owner4');
  const org = await createOrg(owner, 'Quota Co');

  // FILES_STORAGE_QUOTA_FILE_COUNT=3 for this suite (set at the top of this file).
  for (let i = 0; i < 3; i += 1) {
    const res = await request.post(`/api/v1/orgs/${org.id}/files`)
      .set(auth(owner))
      .attach('file', read('tiny.csv'), { filename: `f${i}.csv`, contentType: 'text/csv' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  }

  const over = await request.post(`/api/v1/orgs/${org.id}/files`)
    .set(auth(owner))
    .attach('file', read('tiny.csv'), { filename: 'over.csv', contentType: 'text/csv' });
  assert.strictEqual(over.status, 409, 'quota-exceeded must be a clean 4xx, not a 500');
  assert.match(result(over).message, /quota/i);
  assert.strictEqual(await prisma.file.count({ where: { organizationId: org.id, status: 'active' } }), 3);
});

// ── Permission: uploader vs owner/admin delete ──────────────────────────────────

test('delete: the uploader can delete their own file; a plain member cannot delete someone else\'s', { skip }, async () => {
  const owner  = await makeUser('owner5');
  const member = await makeUser('member5');
  const org = await createOrg(owner, 'Delete Perms Co');
  await addMember(owner, org, member, 'member');

  const upload = await request.post(`/api/v1/orgs/${org.id}/files`)
    .set(auth(owner))
    .attach('file', read('tiny.csv'), { filename: 'owner-file.csv', contentType: 'text/csv' });
  assert.strictEqual(upload.status, 201);
  const file = result(upload).file;

  // A different plain member did not upload this file and is not owner/admin.
  const denied = await request.delete(`/api/v1/orgs/${org.id}/files/${file.id}`).set(auth(member));
  assert.strictEqual(denied.status, 403);

  // The owner (not the uploader here, but owner role) can still delete it.
  const allowed = await request.delete(`/api/v1/orgs/${org.id}/files/${file.id}`).set(auth(owner));
  assert.strictEqual(allowed.status, 200);
});

// Onboarding (A03) + session/account management (A04) integration tests.
// Run against a REAL Postgres + Redis, plus a real http.Server with the WS hub
// attached (the suspension test has to prove a LIVE socket dies, which a
// supertest-only harness cannot show).
//
// Enable with:  RUN_INTEGRATION=1 npm run test:integration
// (or set TEST_DATABASE_URL). Skips cleanly when infra is absent so plain
// `npm test` still passes without a database.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http   = require('node:http');

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
  process.env.SMTP_HOST      = ''; // dev email mode (logs the link, doesn't send)
  process.env.TRUST_PROXY    = '1';
}

// Infra modules are required LAZILY inside before() — see auth.integration.test.js.
let express, supertest, bcrypt, multer, cookieParser, crypto, WebSocket;
let prisma, client, redisReady, routes, apiResponse;
let attachWsHub, _closeRelayForTests;
let request, wsServer, wsPort;

function buildApp() {
  const app = express();
  app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
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

const PREFIX = 'ostest_';
const uniq   = (p) => `${PREFIX}${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const result = (res) => res.body.responseData.result;
const auth   = (token) => ({ Authorization: `Bearer ${token}` });

// Every email-sending route sits behind otpSendLimiter (3/hr/IP). Give each such
// call its own X-Forwarded-For so the limiter never becomes the thing under test —
// same technique auth.integration.test.js uses for the OTP flow.
let ipCounter = 0;
const nextIp  = () => `203.0.113.${(ipCounter += 1) % 250}`;
const withIp  = (ip) => ({
  post: (path) => request.post(path).set('X-Forwarded-For', ip),
});

const hashOf = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

// The raw verification token is emailed once and only its sha256 is stored, so a
// test cannot read it back. Assert that registration DID mint a Redis entry for
// this user, then re-key that entry under a token the test knows. Everything
// after this point (lookup, atomic GETDEL consume, emailVerifiedAt write) is the
// production path, unmodified. Mirrors rawTokenFor() in organizations.integration.
async function verificationTokenFor(userId) {
  const keys = [];
  for await (const key of client.scanIterator({ MATCH: 'auth:verify:*', COUNT: 500 })) {
    keys.push(...(Array.isArray(key) ? key : [key]));
  }
  const owned = [];
  for (const key of keys) {
    if (key.startsWith('auth:verify:resend:')) continue;
    if (await client.get(key) === userId) owned.push(key);
  }
  assert.strictEqual(owned.length, 1, 'registration should mint exactly one verification token');

  const raw = crypto.randomBytes(48).toString('base64url');
  await client.del(owned[0]);
  await client.set(`auth:verify:${hashOf(raw)}`, userId, { EX: 3600 });
  return raw;
}

function refreshCookieFrom(res) {
  const cookie = (res.headers['set-cookie'] || []).find(c => c.startsWith('refreshToken='));
  return cookie ? cookie.split(';')[0] : null;
}

// A full login, returning everything a "device" needs: access token AND the
// refresh cookie that identifies this session server-side.
async function loginAs(user, device) {
  const res = await request.post('/api/v1/common/auth/login')
    .set('User-Agent', device || 'itest-device')
    .send({ userName: user.userName, password: user.password });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  return {
    token:        result(res).token,
    refreshToken: result(res).refreshToken,
    cookie:       refreshCookieFrom(res),
  };
}

// Seeds a user straight into Postgres (verified by default) — the same shortcut
// every other suite uses. Registration itself is exercised separately.
async function seedUser(prefix, overrides = {}) {
  const userName = uniq(prefix);
  const password = 'Str0ng!Passw0rd';
  const user = await prisma.user.create({
    data: {
      userName,
      email:           `${userName}@test.local`,
      name:            'Onboarding Test',
      password:        bcrypt.hashSync(password, 12),
      role:            'admin',
      emailVerifiedAt: new Date(),
      ...overrides,
    },
  });
  return { ...user, password };
}

function waitForClose(ws, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not close')), timeoutMs);
    ws.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });
}

function waitForMessage(ws, predicate, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const seen = [];
    const timer = setTimeout(() => reject(new Error(`timed out. Seen: ${JSON.stringify(seen)}`)), timeoutMs);
    ws.on('message', function onMsg(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      seen.push(msg);
      if (predicate(msg)) { clearTimeout(timer); ws.removeListener('message', onMsg); resolve(msg); }
    });
  });
}

before(async () => {
  if (!ENABLED) return;
  express      = require('express');
  supertest    = require('supertest');
  bcrypt       = require('bcrypt');
  multer       = require('multer');
  cookieParser = require('cookie-parser');
  crypto       = require('node:crypto');
  WebSocket    = require('ws');
  prisma       = require('../config/dbConnect');
  ({ client, redisReady } = require('../config/redisConfig'));
  routes       = require('../routes');
  apiResponse  = require('../helpers/apiResponse');
  ({ attachWsHub, _closeRelayForTests } = require('../helpers/ws/hub'));

  await redisReady;
  request = supertest(buildApp());

  // Real production WS wiring on its own http.Server, so the suspension test can
  // drive an actual live socket rather than calling validateIdentity directly.
  wsServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  wsServer.__sockets = [];
  attachWsHub(wsServer);
  await new Promise((resolve) => wsServer.listen(0, '127.0.0.1', resolve));
  wsPort = wsServer.address().port;
});

after(async () => {
  if (!ENABLED) return;
  try {
    for (const ws of wsServer?.__sockets || []) {
      try { ws.terminate(); } catch { /* already gone */ }
    }
    await prisma.auditLog.deleteMany({ where: { user: { userName: { startsWith: PREFIX } } } });
    await prisma.user.deleteMany({ where: { userName: { startsWith: PREFIX } } });
    // Registration writes users keyed by email; those use the same prefix.
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  } catch (err) {
    console.error('[ostest after] cleanup failed:', err.message);
  } finally {
    await _closeRelayForTests();
    await new Promise((resolve) => wsServer.close(resolve));
    await prisma.$disconnect();
    client.quit().catch(() => {});
  }
});

// ── A03: registration → verification → first useful action ───────────────────

test('register → login (unverified) → org creation blocked → verify → org creation works',
  { skip }, async () => {
    const email = `${uniq('signup')}@test.local`;

    const reg = await withIp(nextIp()).post('/api/v1/common/auth/register')
      .send({ email, password: 'Str0ng!Passw0rd', name: 'New Signup' });
    assert.strictEqual(reg.status, 201, JSON.stringify(reg.body));
    assert.strictEqual(result(reg).user.email, email);
    assert.strictEqual(result(reg).user.emailVerifiedAt, null, 'registration must NOT auto-verify');

    const created = await prisma.user.findUnique({ where: { email } });
    assert.ok(created, 'the User row should exist');
    assert.strictEqual(created.emailVerifiedAt, null);
    assert.notStrictEqual(created.password, 'Str0ng!Passw0rd', 'password must be hashed');
    assert.strictEqual(created.userName, email, 'email is the login username for a self-serve signup');

    // Duplicate registration is a plain CONFLICT — deliberately NOT anti-enumerating
    // (see the stance comment on AuthService.register) but it leaks nothing about
    // the existing account beyond "taken".
    const dup = await withIp(nextIp()).post('/api/v1/common/auth/register')
      .send({ email, password: 'An0ther!Passw0rd', name: 'Impostor' });
    assert.strictEqual(dup.status, 409, JSON.stringify(dup.body));
    assert.match(dup.body.responseData.result.message, /already registered/i);
    assert.doesNotMatch(JSON.stringify(dup.body), /New Signup/, 'must not leak the existing account');

    // PRODUCT DECISION: login is NOT blocked on an unverified email.
    const session = await loginAs({ userName: email, password: 'Str0ng!Passw0rd' });

    const me = await request.get('/api/v1/common/auth/me').set(auth(session.token));
    assert.strictEqual(me.status, 200);
    assert.strictEqual(result(me).emailVerifiedAt, null, '/me must expose verification state');

    // ...but creating an organization IS blocked.
    const blocked = await request.post('/api/v1/orgs').set(auth(session.token))
      .send({ name: 'Premature Inc', slug: uniq('slug').replace(/_/g, '-') });
    assert.strictEqual(blocked.status, 403, JSON.stringify(blocked.body));
    assert.strictEqual(blocked.body.responseData.result.emailVerificationRequired, true);

    // Consume the emailed link.
    const raw    = await verificationTokenFor(created.id);
    const verify = await request.post(`/api/v1/common/auth/verify-email/${raw}`);
    assert.strictEqual(verify.status, 200, JSON.stringify(verify.body));

    const verified = await prisma.user.findUnique({ where: { id: created.id } });
    assert.ok(verified.emailVerifiedAt, 'emailVerifiedAt should now be set');

    // Single-use: the token is gone from Redis after the first consume.
    const replay = await request.post(`/api/v1/common/auth/verify-email/${raw}`);
    assert.strictEqual(replay.status, 400, 'a verification token must not be replayable');

    // verifyToken reads the CURRENT row, so the SAME access token now passes the gate.
    const allowed = await request.post('/api/v1/orgs').set(auth(session.token))
      .send({ name: 'Verified Inc', slug: uniq('slug').replace(/_/g, '-') });
    assert.strictEqual(allowed.status, 201, JSON.stringify(allowed.body));

    await prisma.organization.deleteMany({ where: { id: result(allowed).organization.id } });
  });

test('verify-email rejects a fabricated token', { skip }, async () => {
  const res = await request.post(`/api/v1/common/auth/verify-email/${crypto.randomBytes(48).toString('base64url')}`);
  assert.strictEqual(res.status, 400);
});

test('resend-verification is anti-enumerating (unknown address still succeeds)', { skip }, async () => {
  const res = await withIp(nextIp()).post('/api/v1/common/auth/resend-verification')
    .send({ email: `${uniq('nobody')}@test.local` });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
});

// ── A04: device sessions ─────────────────────────────────────────────────────

test('sessions: list shows one row per live device, flags the caller, and revoke is scoped', { skip }, async () => {
  const user   = await seedUser('sessions');
  const laptop = await loginAs(user, 'itest-laptop');
  const phone  = await loginAs(user, 'itest-phone');

  const listed = await request.get('/api/v1/common/auth/sessions')
    .set(auth(laptop.token)).set('Cookie', laptop.cookie);
  assert.strictEqual(listed.status, 200, JSON.stringify(listed.body));

  const sessions = result(listed).sessions;
  assert.strictEqual(sessions.length, 2, 'two logins => two live sessions');
  assert.deepStrictEqual(
    sessions.filter(s => s.current).length, 1,
    'exactly the session whose refresh cookie is on this request is `current`');
  assert.strictEqual(sessions.find(s => s.current).device, 'itest-laptop');
  assert.ok(sessions.every(s => !('tokenHash' in s)), 'the token hash must never be serialized');
  assert.ok(sessions.every(s => s.ipAddress && s.createdAt), 'device metadata is captured at login');

  // A session's lastUsedAt starts null and is stamped by rotation.
  assert.strictEqual(sessions.find(s => s.current).lastUsedAt, null);
  const rotated = await request.post('/api/v1/common/auth/refresh').set('Cookie', laptop.cookie).send({});
  assert.strictEqual(rotated.status, 200);
  const laptopAfter = { token: result(rotated).token, cookie: refreshCookieFrom(rotated) };
  const relisted = await request.get('/api/v1/common/auth/sessions')
    .set(auth(laptopAfter.token)).set('Cookie', laptopAfter.cookie);
  assert.strictEqual(result(relisted).sessions.length, 2, 'rotation replaces a session, never adds one');
  assert.ok(result(relisted).sessions.find(s => s.current).lastUsedAt, 'rotation stamps lastUsedAt');

  // Another user cannot revoke this user's session.
  const stranger        = await seedUser('stranger');
  const strangerSession = await loginAs(stranger);
  const phoneId = result(relisted).sessions.find(s => !s.current).id;
  const cross   = await request.delete(`/api/v1/common/auth/sessions/${phoneId}`)
    .set(auth(strangerSession.token));
  assert.strictEqual(cross.status, 404, 'another user\'s session id must not be revocable');

  // The owner can.
  const revoked = await request.delete(`/api/v1/common/auth/sessions/${phoneId}`)
    .set(auth(laptopAfter.token)).set('Cookie', laptopAfter.cookie);
  assert.strictEqual(revoked.status, 200, JSON.stringify(revoked.body));

  // The revoked device's refresh token is dead...
  const phoneRefresh = await request.post('/api/v1/common/auth/refresh')
    .set('Cookie', phone.cookie).send({});
  assert.strictEqual(phoneRefresh.status, 401, 'a revoked session cannot be refreshed');

  // ...and the caller's own session survived.
  const after = await request.get('/api/v1/common/auth/sessions')
    .set(auth(laptopAfter.token)).set('Cookie', laptopAfter.cookie);
  assert.strictEqual(result(after).sessions.length, 1);
});

test('revoke-all signs out other devices immediately but keeps the caller working', { skip }, async () => {
  const user   = await seedUser('revokeall');
  const laptop = await loginAs(user, 'itest-laptop');
  const phone  = await loginAs(user, 'itest-phone');

  const res = await request.post('/api/v1/common/auth/sessions/revoke-all')
    .set(auth(laptop.token)).set('Cookie', laptop.cookie);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));

  const reissued = { token: result(res).token, cookie: refreshCookieFrom(res) };
  assert.ok(reissued.token && reissued.cookie, 'caller is re-issued a fresh pair');
  assert.notStrictEqual(reissued.token, laptop.token);

  // The other device's ACCESS token is dead right now — not in 24h when its JWT
  // would have expired. That is the tokenVersion bump doing its job.
  const phoneMe = await request.get('/api/v1/common/auth/me').set(auth(phone.token));
  assert.strictEqual(phoneMe.status, 401, 'other devices lose their access token immediately');

  const phoneRefresh = await request.post('/api/v1/common/auth/refresh').set('Cookie', phone.cookie).send({});
  assert.strictEqual(phoneRefresh.status, 401, 'other devices lose their refresh token too');

  // The caller keeps working on the re-issued pair, and sees exactly one session.
  const mine = await request.get('/api/v1/common/auth/sessions')
    .set(auth(reissued.token)).set('Cookie', reissued.cookie);
  assert.strictEqual(mine.status, 200, JSON.stringify(mine.body));
  assert.strictEqual(result(mine).sessions.length, 1);
  assert.strictEqual(result(mine).sessions[0].current, true);
});

// ── A04: password change ─────────────────────────────────────────────────────

test('change-password requires the current password, kills other sessions, keeps the current one', { skip }, async () => {
  const user   = await seedUser('changepw');
  const laptop = await loginAs(user, 'itest-laptop');
  const phone  = await loginAs(user, 'itest-phone');

  // Wrong current password → rejected, and nothing changes.
  const wrong = await request.post('/api/v1/common/auth/change-password')
    .set(auth(laptop.token)).set('Cookie', laptop.cookie)
    .send({ currentPassword: 'N0t!TheRightOne', newPassword: 'Brand!NewPassw0rd' });
  assert.strictEqual(wrong.status, 401, JSON.stringify(wrong.body));
  const stillWorks = await request.get('/api/v1/common/auth/me').set(auth(phone.token));
  assert.strictEqual(stillWorks.status, 200, 'a failed attempt must not disturb any session');

  const ok = await request.post('/api/v1/common/auth/change-password')
    .set(auth(laptop.token)).set('Cookie', laptop.cookie)
    .send({ currentPassword: user.password, newPassword: 'Brand!NewPassw0rd' });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));

  const reissued = { token: result(ok).token, cookie: refreshCookieFrom(ok) };

  // PRODUCT DECISION, the half that differs from resetPassword: the tab that did
  // the change stays signed in, on a freshly issued pair.
  const callerMe = await request.get('/api/v1/common/auth/me').set(auth(reissued.token));
  assert.strictEqual(callerMe.status, 200, 'the caller must NOT be signed out by its own change');

  // The half that matches resetPassword: every other device is cut off at once.
  const otherMe = await request.get('/api/v1/common/auth/me').set(auth(phone.token));
  assert.strictEqual(otherMe.status, 401, 'other devices lose their access token');
  const otherRefresh = await request.post('/api/v1/common/auth/refresh').set('Cookie', phone.cookie).send({});
  assert.strictEqual(otherRefresh.status, 401, 'other devices lose their refresh token');

  // The new password is what logs in now.
  const oldPw = await request.post('/api/v1/common/auth/login')
    .send({ userName: user.userName, password: user.password });
  assert.strictEqual(oldPw.status, 401, 'the old password must stop working');
  const newPw = await request.post('/api/v1/common/auth/login')
    .send({ userName: user.userName, password: 'Brand!NewPassw0rd' });
  assert.strictEqual(newPw.status, 200, JSON.stringify(newPw.body));
});

test('change-password rejects reusing the current password', { skip }, async () => {
  const user    = await seedUser('samepw');
  const session = await loginAs(user);
  const res = await request.post('/api/v1/common/auth/change-password')
    .set(auth(session.token)).set('Cookie', session.cookie)
    .send({ currentPassword: user.password, newPassword: user.password });
  assert.strictEqual(res.status, 400, JSON.stringify(res.body));
});

// ── A04: platform-level account suspension ───────────────────────────────────

test('suspension is superAdmin-only — a signup-role account cannot suspend anyone', { skip }, async () => {
  const attacker = await seedUser('attacker');                         // role 'admin' = the signup role
  const victim   = await seedUser('victim');
  const session  = await loginAs(attacker);

  const res = await request.patch(`/api/v1/admin/users/${victim.id}/status`)
    .set(auth(session.token)).send({ active: false });
  assert.strictEqual(res.status, 403, 'the self-serve signup role must not reach a platform-admin route');

  const untouched = await prisma.user.findUnique({ where: { id: victim.id } });
  assert.strictEqual(untouched.active, true);
});

test('suspending a user kills their LIVE access token and their LIVE WebSocket, then reactivation restores login',
  { skip }, async () => {
    const admin  = await seedUser('platformadmin', { role: 'superAdmin' });
    const victim = await seedUser('suspendme');

    const adminSession  = await loginAs(admin);
    const victimSession = await loginAs(victim, 'itest-victim-device');

    // Baseline: the victim's token works over REST...
    const before = await request.get('/api/v1/common/auth/me').set(auth(victimSession.token));
    assert.strictEqual(before.status, 200);

    // ...and over a real WebSocket, subscribed to their own user channel.
    const ws = new WebSocket(
      `ws://127.0.0.1:${wsPort}/ws?token=${victimSession.token}&channels=user:${victim.id}`);
    wsServer.__sockets.push(ws);
    const connected = await waitForMessage(ws, (m) => m.type === 'connected');
    assert.deepStrictEqual(connected.channels, [`user:${victim.id}`], 'victim is subscribed before suspension');

    // Suspend.
    const suspend = await request.patch(`/api/v1/admin/users/${victim.id}/status`)
      .set(auth(adminSession.token)).send({ active: false });
    assert.strictEqual(suspend.status, 200, JSON.stringify(suspend.body));
    assert.strictEqual(result(suspend).user.active, false);

    // 1. The still-unexpired access token is rejected on the very next request —
    //    verifyToken re-reads the row, so this does not wait for the 24h JWT TTL.
    const afterRest = await request.get('/api/v1/common/auth/me').set(auth(victimSession.token));
    assert.strictEqual(afterRest.status, 401, 'a suspended user\'s live access token must stop working');

    // 2. The refresh token cannot be traded for a new access token either.
    const afterRefresh = await request.post('/api/v1/common/auth/refresh')
      .set('Cookie', victimSession.cookie).send({});
    assert.strictEqual(afterRefresh.status, 401, 'a suspended user cannot refresh back in');

    // 3. The ALREADY-OPEN socket is torn down: the hub re-validates identity on
    //    every subscribe (as well as on a periodic timer), so the next thing this
    //    live connection does is closed with 4001 rather than served.
    ws.send(JSON.stringify({ type: 'subscribe', channels: [`user:${victim.id}`] }));
    const closeCode = await waitForClose(ws);
    assert.strictEqual(closeCode, 4001, 'a suspended user\'s live WS connection must be closed');

    // 4. A fresh connection with the same token is refused outright.
    const reconnect = new WebSocket(
      `ws://127.0.0.1:${wsPort}/ws?token=${victimSession.token}&channels=user:${victim.id}`);
    wsServer.__sockets.push(reconnect);
    assert.strictEqual(await waitForClose(reconnect), 4001, 'a suspended user cannot open a new socket');

    // 5. Logging in again is refused while suspended.
    const blockedLogin = await request.post('/api/v1/common/auth/login')
      .send({ userName: victim.userName, password: victim.password });
    assert.strictEqual(blockedLogin.status, 403, JSON.stringify(blockedLogin.body));

    // Reactivation lets them back in — with brand-new sessions, never the revoked ones.
    const reactivate = await request.patch(`/api/v1/admin/users/${victim.id}/status`)
      .set(auth(adminSession.token)).send({ active: true });
    assert.strictEqual(reactivate.status, 200);

    const relogin = await loginAs(victim, 'itest-victim-device');
    assert.ok(relogin.token, 'a reactivated user can log in again');

    const stale = await request.post('/api/v1/common/auth/refresh')
      .set('Cookie', victimSession.cookie).send({});
    assert.strictEqual(stale.status, 401, 'reactivation must not resurrect pre-suspension sessions');
  });

test('an admin cannot suspend their own account', { skip }, async () => {
  const admin   = await seedUser('selfsuspend', { role: 'superAdmin' });
  const session = await loginAs(admin);
  const res = await request.patch(`/api/v1/admin/users/${admin.id}/status`)
    .set(auth(session.token)).send({ active: false });
  assert.strictEqual(res.status, 403, JSON.stringify(res.body));
});

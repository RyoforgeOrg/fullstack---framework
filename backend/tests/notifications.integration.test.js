// Notifications integration tests (supertest + a real ws client) — run against a
// REAL Postgres + Redis, same convention as tests/auth.integration.test.js.
//
// Enable with:  RUN_INTEGRATION=1 npm run test:integration
// (or set TEST_DATABASE_URL). Skips cleanly when infra is absent.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const ENABLED = process.env.RUN_INTEGRATION === '1' || !!process.env.TEST_DATABASE_URL;
const skip    = ENABLED ? false : 'integration infra not configured (set RUN_INTEGRATION=1)';

if (ENABLED) {
  process.env.DATABASE_URL   = process.env.TEST_DATABASE_URL || 'postgresql://postgres:test@localhost:55432/framework?schema=public';
  process.env.REDIS_HOST     = process.env.TEST_REDIS_HOST || '127.0.0.1';
  process.env.REDIS_PORT     = process.env.TEST_REDIS_PORT || '56379';
  process.env.JWT_SECRET     = process.env.TEST_JWT_SECRET || 'itest-jwt-secret-itest-jwt-secret-0000000000';
  process.env.REFRESH_SECRET = process.env.TEST_REFRESH_SECRET || 'itest-refresh-secret-itest-refresh-0000000000';
  process.env.SMTP_HOST      = ''; // dev email mode — logs instead of sending
  process.env.TRUST_PROXY    = '1';
}

let express, supertest, bcrypt, http, WebSocket;
let prisma, client, redisReady, routes, apiResponse;
let generateToken;
let NotificationService, handleNotificationEmail, attachWsHub;
let request, server, port;
let userA, userB, tokenA, tokenB;

const uniq = (p) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1', routes);
  app.use('/api/v1', (req, res) => apiResponse.send(res, 'NOT_FOUND'));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error('[test app]', err);
    return apiResponse.send(res, 'SERVER_ERROR');
  });
  return app;
}

before(async () => {
  if (!ENABLED) return;
  express     = require('express');
  supertest   = require('supertest');
  bcrypt      = require('bcrypt');
  http        = require('http');
  WebSocket   = require('ws');
  prisma      = require('../config/dbConnect');
  ({ client, redisReady } = require('../config/redisConfig'));
  routes      = require('../routes');
  apiResponse = require('../helpers/apiResponse');
  ({ generateToken } = require('../helpers/generateToken'));
  NotificationService = require('../modules/notifications/services/NotificationService');
  ({ handleNotificationEmail } = require('../workers/notificationEmailJobHandler'));
  ({ attachWsHub } = require('../helpers/ws/hub'));

  await redisReady;
  await client.flushDb();

  const mkUser = async (prefix) => {
    const userName = uniq(prefix);
    const user = await prisma.user.create({
      data: {
        userName,
        email:    `${userName}@test.local`,
        name:     'Notif Test',
        password: bcrypt.hashSync('Str0ng!Passw0rd', 12),
        role:     'admin',
      },
    });
    return { user, token: generateToken(user) };
  };

  ({ user: userA, token: tokenA } = await mkUser('itest_notif_a'));
  ({ user: userB, token: tokenB } = await mkUser('itest_notif_b'));

  // NOTE: unlike server.js, no unclaimed-upgrade fallback destroyer is added
  // here — this test only ever opens /ws sockets that attachWsHub claims, and
  // http.Server's 'upgrade' event calls every registered listener (it doesn't
  // stop at the first one that handles it), so stacking a second "destroy
  // anything still open" listener would race the hub's own handleUpgrade and
  // could tear down a socket it just claimed.
  const app = buildApp();
  server = http.createServer(app);
  attachWsHub(server);
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;

  request = supertest(app);
});

after(async () => {
  if (!ENABLED) return;
  try {
    await prisma.notification.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
    await prisma.user.deleteMany({ where: { userName: { startsWith: 'itest_notif_' } } });
  } catch (err) {
    console.error('[itest after] cleanup failed:', err.message);
  } finally {
    await client.flushDb().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
    client.quit().catch(() => {});
  }

  // attachWsHub() opens its own Redis pub/sub subscriber for the cluster relay
  // (helpers/ws/hub.js `startRelay`) with no teardown API — by design, it's
  // meant to live for the process lifetime in production. That leaves one
  // open handle after everything above is torn down, so `node --test` never
  // reaches its own natural exit. Force it here rather than leave this file
  // hanging forever; every assertion above has already run by this point.
  setTimeout(() => process.exit(0), 50).unref();
});

// ── notify() → list → mark read → unread count ──────────────────────────────────

test('notify() creates a row that appears in the caller list, unread', { skip }, async () => {
  await NotificationService.notify({
    userId: userA.id,
    type:   'product',
    title:  'Welcome',
    body:   'Thanks for signing up.',
  });

  const res = await request.get('/api/v1/common/notifications')
    .set('Authorization', `Bearer ${tokenA}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.responseData.result.unreadCount, 1);
  assert.strictEqual(res.body.responseData.result.notifications.length, 1);
  assert.strictEqual(res.body.responseData.result.notifications[0].title, 'Welcome');
});

test('mark one read decrements unreadCount', { skip }, async () => {
  const list = await request.get('/api/v1/common/notifications').set('Authorization', `Bearer ${tokenA}`);
  const id = list.body.responseData.result.notifications[0].id;

  const markRes = await request.patch(`/api/v1/common/notifications/${id}/read`)
    .set('Authorization', `Bearer ${tokenA}`);
  assert.strictEqual(markRes.status, 200);

  const after = await request.get('/api/v1/common/notifications').set('Authorization', `Bearer ${tokenA}`);
  assert.strictEqual(after.body.responseData.result.unreadCount, 0);
});

test('mark-all-read clears unreadCount across multiple notifications', { skip }, async () => {
  await NotificationService.notify({ userId: userA.id, type: 'product', title: 'A', body: 'a' });
  await NotificationService.notify({ userId: userA.id, type: 'product', title: 'B', body: 'b' });

  const readAll = await request.post('/api/v1/common/notifications/read-all')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.strictEqual(readAll.status, 200);
  assert.ok(readAll.body.responseData.result.updated >= 2);

  const after = await request.get('/api/v1/common/notifications').set('Authorization', `Bearer ${tokenA}`);
  assert.strictEqual(after.body.responseData.result.unreadCount, 0);
});

// ── tenant isolation between users ───────────────────────────────────────────────

test('a notification for user A never appears in user B\'s list', { skip }, async () => {
  await NotificationService.notify({ userId: userA.id, type: 'product', title: 'Only for A', body: 'x' });

  const bList = await request.get('/api/v1/common/notifications').set('Authorization', `Bearer ${tokenB}`);
  const titles = bList.body.responseData.result.notifications.map((n) => n.title);
  assert.ok(!titles.includes('Only for A'));
});

test('mark-read on another user\'s notification 404s, does not leak or mutate it', { skip }, async () => {
  const created = await NotificationService.notify({ userId: userA.id, type: 'product', title: 'A-only', body: 'x' });

  const res = await request.patch(`/api/v1/common/notifications/${created.id}/read`)
    .set('Authorization', `Bearer ${tokenB}`);
  assert.strictEqual(res.body.responseCode, 1004);

  const row = await prisma.notification.findUnique({ where: { id: created.id } });
  assert.strictEqual(row.readAt, null);
});

// ── email delivery + preference opt-out ──────────────────────────────────────────

test('opted-out category creates the in-app row but does NOT enqueue an email job', { skip }, async () => {
  await request.patch('/api/v1/common/notifications/preferences')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ product: false });

  const queueKey = 'job:queue:queue:notification-email';
  const before = await client.lLen(queueKey);

  const notification = await NotificationService.notify({
    userId:   userA.id,
    type:     'file_uploaded', // category: product, now opted out
    title:    'File ready',
    body:     'Your export is ready.',
    channels: ['in_app', 'email'],
  });

  const afterLen = await client.lLen(queueKey);
  assert.strictEqual(afterLen, before);

  const row = await prisma.notification.findUnique({ where: { id: notification.id } });
  assert.ok(row); // in-app row still created
  assert.strictEqual(row.emailDeliveredAt, null);

  // Reset preference for subsequent tests.
  await request.patch('/api/v1/common/notifications/preferences')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ product: true });
});

test('security category ignores opt-out and always queues email', { skip }, async () => {
  await request.patch('/api/v1/common/notifications/preferences')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ product: false }); // security isn't in the settable set — should be ignored anyway

  const queueKey = 'job:queue:queue:notification-email';
  const before = await client.lLen(queueKey);

  await NotificationService.notify({
    userId:   userA.id,
    type:     'password_changed',
    title:    'Your password changed',
    body:     'If this was not you, contact support.',
    channels: ['in_app', 'email'],
  });

  const afterLen = await client.lLen(queueKey);
  assert.strictEqual(afterLen, before + 1);

  await client.lPop(queueKey); // drain so it doesn't leak into later tests
});

test('email delivery job actually runs and updates delivery tracking', { skip }, async () => {
  const notification = await NotificationService.notify({
    userId:   userA.id,
    type:     'password_changed',
    title:    'Security notice',
    body:     'Password changed.',
    channels: ['in_app', 'email'],
  });

  // Pull the job this notify() call just enqueued and run the handler directly
  // (same function the real worker registers in worker.js) rather than booting
  // the worker's infinite BLPOP loop inside a test process. lPop mirrors the
  // real worker's blPop (FIFO, pops from the head).
  const queueKey = 'job:queue:queue:notification-email';
  const jobId = await client.lPop(queueKey);
  assert.ok(jobId);

  const statusKey = `job:status:${jobId}`;
  const raw = await client.hGetAll(statusKey);
  const payload = JSON.parse(raw.payload);
  assert.strictEqual(payload.notificationId, notification.id);

  await handleNotificationEmail(payload, { reportProgress: async () => {} });

  const row = await prisma.notification.findUnique({ where: { id: notification.id } });
  assert.ok(row.emailDeliveredAt);
  assert.strictEqual(row.emailDeliveryError, null);
});

// ── real-time WS push ─────────────────────────────────────────────────────────────

test('notify() pushes a live event on the user:<id> WS channel', { skip }, async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(tokenA)}&channels=user:${userA.id}`);

  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for WS notification event')), 5000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'event' && msg.channel === `user:${userA.id}` && msg.payload?.event === 'notification') {
        clearTimeout(timer);
        resolve(msg.payload);
      }
    });
    ws.on('error', reject);
  });

  await new Promise((resolve) => ws.on('open', resolve));

  await NotificationService.notify({ userId: userA.id, type: 'product', title: 'Live push', body: 'x' });

  const payload = await received;
  assert.strictEqual(payload.notification.title, 'Live push');

  ws.close();
});

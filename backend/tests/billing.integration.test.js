// Billing / entitlement integration tests (supertest) — real Postgres + Redis,
// FAKE Stripe.
//
// Enable with:  RUN_INTEGRATION=1 npm run test:integration
// Skips cleanly when infra is absent so plain `npm test` still passes.
//
// ── HOW STRIPE IS FAKED (and what that still proves) ─────────────────────────
// Two independent seams, so no test ever needs a live key or reaches stripe.com:
//
//   1. OUTBOUND calls (checkout / portal / invoices) — setBillingProvider()
//      swaps a fake adapter in. The route, permission chain, plan lookup, price
//      resolution and response envelope are all the REAL code; only the HTTP
//      call to Stripe is replaced.
//
//   2. INBOUND webhooks — signed with the Stripe SDK's own
//      generateTestHeaderString(), which implements the exact HMAC scheme
//      Stripe's servers use. So the signature path is genuinely exercised
//      (see tests/billingProvider.test.js for the verification unit tests), and
//      the event bodies below are real Stripe event shapes.
//
// The processing logic is reachable two ways on purpose: over HTTP (proving the
// raw-body mount ordering from server.js works) and by calling
// processStripeEvent() directly (proving replay/ordering semantics without
// having to re-sign every fixture).
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const ENABLED = process.env.RUN_INTEGRATION === '1' || !!process.env.TEST_DATABASE_URL;
const skip    = ENABLED ? false : 'integration infra not configured (set RUN_INTEGRATION=1)';

const WEBHOOK_SECRET = 'whsec_billing_integration_secret';

if (ENABLED) {
  // ── Env must be set BEFORE any infra module is required ─────────────────────
  process.env.DATABASE_URL   = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:55432/framework?schema=public';
  process.env.REDIS_HOST     = process.env.TEST_REDIS_HOST || '127.0.0.1';
  process.env.REDIS_PORT     = process.env.TEST_REDIS_PORT || '56379';
  process.env.JWT_SECRET     = process.env.TEST_JWT_SECRET || 'itest-jwt-secret-itest-jwt-secret-0000000000';
  process.env.REFRESH_SECRET = process.env.TEST_REFRESH_SECRET || 'itest-refresh-secret-itest-refresh-0000000000';
  process.env.REFRESH_EXPIRY = '7d';
  process.env.SMTP_HOST      = '';
  process.env.TRUST_PROXY    = '1';
  // A fake key is enough: the only SDK call made with it is the local HMAC
  // helper, which never opens a socket.
  process.env.STRIPE_SECRET_KEY     = 'sk_test_billing_integration';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
}

let express, supertest, bcrypt, multer, Stripe;
let prisma, client, redisReady, routes, apiResponse;
let setBillingProvider, resetBillingProvider;
let processStripeEvent, checkEntitlement, effectiveFeatures, _resetFreePlanCache, UNLIMITED;
let request, signer;

function buildApp() {
  const app = express();
  app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
  // MIRRORS server.js EXACTLY: the raw-body webhook router is mounted BEFORE
  // express.json(). If that ordering ever regresses in server.js, the signature
  // tests below start failing here for the same reason they would in production.
  app.use('/api/v1/webhooks', require('../modules/billing/routes/stripeWebhookRoutes'));
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

const PREFIX      = 'btest_';
const SLUG_PREFIX = 'btest-';
const PLAN_PREFIX = 'btest_plan_';
const EVENT_PREFIX = 'evt_btest_';

const uniq     = (p) => `${PREFIX}${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const uniqSlug = (p) => `${SLUG_PREFIX}${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const uniqId   = (p) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const result = (res) => res.body.responseData.result;
const auth   = (actor) => ({ Authorization: `Bearer ${actor.token}` });

// Test-owned plans, so the seeded production catalogue is never mutated. 'free'
// itself is the migration's row — createFreeSubscription requires it by key.
let PRO_PLAN;
const PRO_PRICE_ID = 'price_btest_pro_monthly';

async function makeUser(prefix) {
  const userName = uniq(prefix);
  const email    = `${userName}@test.local`;
  const password = 'Str0ng!Passw0rd';
  const user = await prisma.user.create({
    data: { userName, email, name: 'Billing Test', password: bcrypt.hashSync(password, 12), role: 'admin' },
  });
  const login = await request.post('/api/v1/common/auth/login').send({ userName, password });
  assert.strictEqual(login.status, 200, 'seed user should be able to log in');
  return { id: user.id, userName, email, token: login.body.responseData.result.token };
}

async function createOrg(actor, name) {
  const res = await request.post('/api/v1/orgs').set(auth(actor)).send({ name, slug: uniqSlug('slug') });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return result(res).organization;
}

// Adds a second member with a given role, by writing the membership directly.
// The invitation path is already covered by organizations.integration.test.js —
// re-driving it here would test that module, not this one.
async function addMember(org, user, role) {
  await prisma.membership.create({
    data: { userId: user.id, organizationId: org.id, role, status: 'active', joinedAt: new Date() },
  });
}

// ── Stripe event fixtures (real payload shapes) ───────────────────────────────

const unix = (date) => Math.floor(date.getTime() / 1000);

function checkoutCompleted({ id, organizationId, planKey, customerId, subscriptionId, created }) {
  return {
    id, object: 'event', type: 'checkout.session.completed',
    created: unix(created),
    data: {
      object: {
        id: uniqId('cs'), object: 'checkout.session',
        client_reference_id: organizationId,
        customer: customerId,
        subscription: subscriptionId,
        payment_status: 'paid',
        status: 'complete',
        metadata: { organizationId, planKey },
      },
    },
  };
}

function subscriptionUpdated({ id, subscriptionId, customerId, status, created, periodEnd, priceId, organizationId }) {
  return {
    id, object: 'event', type: 'customer.subscription.updated',
    created: unix(created),
    data: {
      object: {
        id: subscriptionId, object: 'subscription',
        customer: customerId,
        status,
        current_period_end: periodEnd ? unix(periodEnd) : null,
        trial_end: null,
        items: { object: 'list', data: [{ id: uniqId('si'), object: 'subscription_item', price: { id: priceId, object: 'price' } }] },
        metadata: organizationId ? { organizationId } : {},
      },
    },
  };
}

function subscriptionDeleted({ id, subscriptionId, customerId, created }) {
  return {
    id, object: 'event', type: 'customer.subscription.deleted',
    created: unix(created),
    data: {
      object: {
        id: subscriptionId, object: 'subscription',
        customer: customerId,
        status: 'canceled',
        items: { object: 'list', data: [] },
        metadata: {},
      },
    },
  };
}

function invoicePaymentFailed({ id, subscriptionId, customerId, created }) {
  return {
    id, object: 'event', type: 'invoice.payment_failed',
    created: unix(created),
    data: {
      object: {
        id: uniqId('in'), object: 'invoice',
        customer: customerId,
        subscription: subscriptionId,
        status: 'open',
        attempt_count: 1,
      },
    },
  };
}

// POST an event over real HTTP with a real (SDK-generated) signature.
function postSignedWebhook(event, { secret = WEBHOOK_SECRET } = {}) {
  const payload   = JSON.stringify(event);
  const signature = signer.webhooks.generateTestHeaderString({ payload, secret });
  return request.post('/api/v1/webhooks/stripe')
    .set('stripe-signature', signature)
    .set('Content-Type', 'application/json')
    .send(payload);
}

const subscriptionOf = (orgId) =>
  prisma.subscription.findUnique({ where: { organizationId: orgId }, include: { plan: true } });

before(async () => {
  if (!ENABLED) return;
  express   = require('express');
  supertest = require('supertest');
  bcrypt    = require('bcrypt');
  multer    = require('multer');
  Stripe    = require('stripe');
  prisma    = require('../config/dbConnect');
  ({ client, redisReady } = require('../config/redisConfig'));
  routes      = require('../routes');
  apiResponse = require('../helpers/apiResponse');
  ({ setBillingProvider, resetBillingProvider } = require('../helpers/billingProvider'));
  ({ processStripeEvent } = require('../modules/billing/services/StripeWebhookService'));
  ({ checkEntitlement, effectiveFeatures, _resetFreePlanCache, UNLIMITED } = require('../helpers/entitlements'));

  await redisReady;
  request = supertest(buildApp());
  signer  = new Stripe(process.env.STRIPE_SECRET_KEY);

  PRO_PLAN = await prisma.plan.upsert({
    where:  { key: `${PLAN_PREFIX}pro` },
    update: { stripePriceId: PRO_PRICE_ID },
    create: {
      key: `${PLAN_PREFIX}pro`, name: 'Billing Test Pro', priceMonthlyCents: 2900,
      stripePriceId: PRO_PRICE_ID,
      features: { maxMembers: 25, maxFiles: 1000, apiAccess: true, prioritySupport: false },
    },
  });

  // The free-plan feature map is memoised per process; the seeded row is already
  // in place, but reset so the cache is built from the state these tests see.
  _resetFreePlanCache();

  // Default fake adapter. Individual tests override it and restore this.
  setBillingProvider(fakeProvider());
});

function fakeProvider(overrides = {}) {
  return {
    createCheckoutSession: async (args) => ({
      id: 'cs_test_fake', url: `https://checkout.stripe.test/session?org=${args.organizationId}&price=${args.priceId}`,
      _args: args,
    }),
    createPortalSession: async (args) => ({
      id: 'bps_test_fake', url: `https://billing.stripe.test/portal?customer=${args.customerId}`,
      _args: args,
    }),
    listInvoices: async () => ([
      { id: 'in_test_1', number: 'BT-0001', status: 'paid', amountPaid: 2900, currency: 'usd', createdAt: new Date(), hostedUrl: null, pdfUrl: null },
    ]),
    verifyWebhookSignature: (raw, sig) =>
      require('../helpers/billingProvider').realProvider.verifyWebhookSignature(raw, sig),
    ...overrides,
  };
}

after(async () => {
  if (!ENABLED) return;
  try {
    resetBillingProvider();
    // Orgs cascade their subscriptions; test plans can only be dropped once no
    // subscription references them (FK is RESTRICT — deliberately).
    await prisma.organization.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
    await prisma.plan.deleteMany({ where: { key: { startsWith: PLAN_PREFIX } } });
    await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: EVENT_PREFIX } } });
    await prisma.auditLog.deleteMany({ where: { user: { userName: { startsWith: PREFIX } } } });
    await prisma.refreshToken.deleteMany({ where: { user: { userName: { startsWith: PREFIX } } } });
    await prisma.user.deleteMany({ where: { userName: { startsWith: PREFIX } } });
  } catch (err) {
    console.error('[btest after] cleanup failed:', err.message);
  } finally {
    await prisma.$disconnect();
    client.quit().catch(() => {});
  }
});

// ── Provisioning ──────────────────────────────────────────────────────────────

test('a new organization is automatically given a free-plan subscription', { skip }, async () => {
  const owner = await makeUser('prov');
  const org   = await createOrg(owner, 'Provisioning Inc');

  const sub = await subscriptionOf(org.id);
  assert.ok(sub, 'every organization must have a subscription row from creation');
  assert.strictEqual(sub.plan.key, 'free');
  assert.strictEqual(sub.status, 'active');
  assert.strictEqual(sub.stripeCustomerId, null);
  assert.strictEqual(sub.stripeSubscriptionId, null);
});

test('the subscription is created in the SAME transaction as the org — a failed org create leaves neither', { skip }, async () => {
  const owner = await makeUser('atomic');
  const slug  = uniqSlug('dup');

  const first = await request.post('/api/v1/orgs').set(auth(owner)).send({ name: 'Atomic One', slug });
  assert.strictEqual(first.status, 201);

  // Same slug → unique violation inside the transaction.
  const second = await request.post('/api/v1/orgs').set(auth(owner)).send({ name: 'Atomic Two', slug });
  assert.strictEqual(second.status, 409, JSON.stringify(second.body));

  const orgs = await prisma.organization.findMany({ where: { slug } });
  assert.strictEqual(orgs.length, 1, 'the rolled-back org must not exist');
  assert.strictEqual(await prisma.subscription.count({ where: { organizationId: { in: orgs.map(o => o.id) } } }), 1);
});

// ── GET /billing ──────────────────────────────────────────────────────────────

test('GET /billing returns the current plan and catalogue; readable by a viewer', { skip }, async () => {
  const owner  = await makeUser('read_owner');
  const viewer = await makeUser('read_viewer');
  const org    = await createOrg(owner, 'Readable Inc');
  await addMember(org, viewer, 'viewer');

  const res = await request.get(`/api/v1/orgs/${org.id}/billing`).set(auth(owner));
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(result(res).subscription.plan.key, 'free');
  assert.strictEqual(result(res).subscription.entitled, true);
  assert.strictEqual(result(res).subscription.hasPaymentAccount, false);
  assert.ok(result(res).availablePlans.some(p => p.key === 'free'));

  // A viewer must be able to see why a feature is locked.
  const asViewer = await request.get(`/api/v1/orgs/${org.id}/billing`).set(auth(viewer));
  assert.strictEqual(asViewer.status, 200);
  assert.strictEqual(result(asViewer).subscription.plan.key, 'free');
});

test('GET /billing never leaks the Stripe customer id to the browser', { skip }, async () => {
  const owner = await makeUser('leak');
  const org   = await createOrg(owner, 'Leak Check Inc');
  await prisma.subscription.update({
    where: { organizationId: org.id },
    data:  { stripeCustomerId: 'cus_btest_secret' },
  });

  const res = await request.get(`/api/v1/orgs/${org.id}/billing`).set(auth(owner));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(result(res).subscription.hasPaymentAccount, true);
  assert.strictEqual(JSON.stringify(res.body).includes('cus_btest_secret'), false,
    'the raw Stripe customer id must never appear in an API response');
});

test('a non-member gets 403 on billing — same anti-enumeration stance as every org route', { skip }, async () => {
  const owner     = await makeUser('iso_owner');
  const outsider  = await makeUser('iso_out');
  const org       = await createOrg(owner, 'Isolated Inc');

  assert.strictEqual((await request.get(`/api/v1/orgs/${org.id}/billing`).set(auth(outsider))).status, 403);
  assert.strictEqual((await request.post(`/api/v1/orgs/${org.id}/billing/checkout`).set(auth(outsider)).send({ planKey: PRO_PLAN.key })).status, 403);
});

// ── Checkout / portal (mocked adapter, real routes) ───────────────────────────

test('POST /billing/checkout returns a session URL and does NOT grant the plan yet', { skip }, async () => {
  const owner = await makeUser('co_owner');
  const org   = await createOrg(owner, 'Checkout Inc');

  const res = await request.post(`/api/v1/orgs/${org.id}/billing/checkout`)
    .set(auth(owner)).send({ planKey: PRO_PLAN.key });

  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.match(result(res).checkout.url, /^https:\/\/checkout\.stripe\.test\//);
  assert.ok(result(res).checkout.url.includes(PRO_PRICE_ID), 'the price id must come from the Plan row');

  // Reaching the payment page is not paying for it. Only the webhook grants.
  const sub = await subscriptionOf(org.id);
  assert.strictEqual(sub.plan.key, 'free', 'checkout must not upgrade the plan on its own');
});

test('checkout takes the price from the Plan row — a client cannot name its own price or amount', { skip }, async () => {
  const owner = await makeUser('price');
  const org   = await createOrg(owner, 'Price Inc');

  let captured = null;
  setBillingProvider(fakeProvider({
    createCheckoutSession: async (args) => { captured = args; return { id: 'cs_x', url: 'https://checkout.stripe.test/x' }; },
  }));

  const res = await request.post(`/api/v1/orgs/${org.id}/billing/checkout`)
    .set(auth(owner))
    .send({ planKey: PRO_PLAN.key, priceId: 'price_attacker_one_cent', amount: 1, stripePriceId: 'price_attacker' });

  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.strictEqual(captured.priceId, PRO_PRICE_ID, 'the client-supplied price must be ignored');
  assert.strictEqual(captured.organizationId, org.id);
  assert.strictEqual(captured.planKey, PRO_PLAN.key);

  setBillingProvider(fakeProvider());
});

test('checkout rejects the free plan, an unknown plan, and a plan with no Stripe price configured', { skip }, async () => {
  const owner = await makeUser('reject');
  const org   = await createOrg(owner, 'Reject Inc');
  const url   = `/api/v1/orgs/${org.id}/billing/checkout`;

  assert.strictEqual((await request.post(url).set(auth(owner)).send({ planKey: 'free' })).status, 400);
  assert.strictEqual((await request.post(url).set(auth(owner)).send({ planKey: 'no_such_plan' })).status, 404);
  assert.strictEqual((await request.post(url).set(auth(owner)).send({})).status, 400, 'planKey is required');

  // A paid plan whose stripePriceId has not been set for this environment.
  const unconfigured = await prisma.plan.create({
    data: { key: `${PLAN_PREFIX}unconfigured`, name: 'Unconfigured', priceMonthlyCents: 1000, features: {} },
  });
  const res = await request.post(url).set(auth(owner)).send({ planKey: unconfigured.key });
  assert.strictEqual(res.status, 503, JSON.stringify(res.body));
});

test('POST /billing/portal returns a portal URL once the org has a Stripe customer', { skip }, async () => {
  const owner = await makeUser('portal');
  const org   = await createOrg(owner, 'Portal Inc');

  // Never billed → nothing to manage.
  const early = await request.post(`/api/v1/orgs/${org.id}/billing/portal`).set(auth(owner));
  assert.strictEqual(early.status, 400, JSON.stringify(early.body));

  await prisma.subscription.update({
    where: { organizationId: org.id }, data: { stripeCustomerId: 'cus_btest_portal' },
  });

  const res = await request.post(`/api/v1/orgs/${org.id}/billing/portal`).set(auth(owner));
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  assert.ok(result(res).portal.url.includes('cus_btest_portal'));
});

test('GET /billing/invoices returns [] before billing and the adapter list after', { skip }, async () => {
  const owner = await makeUser('inv');
  const org   = await createOrg(owner, 'Invoice Inc');

  const empty = await request.get(`/api/v1/orgs/${org.id}/billing/invoices`).set(auth(owner));
  assert.strictEqual(empty.status, 200);
  assert.deepStrictEqual(result(empty).invoices, []);

  await prisma.subscription.update({
    where: { organizationId: org.id }, data: { stripeCustomerId: 'cus_btest_inv' },
  });

  const listed = await request.get(`/api/v1/orgs/${org.id}/billing/invoices`).set(auth(owner));
  assert.strictEqual(listed.status, 200);
  assert.strictEqual(result(listed).invoices.length, 1);
  assert.strictEqual(result(listed).invoices[0].number, 'BT-0001');
});

// ── Permission matrix ─────────────────────────────────────────────────────────

test('member and viewer cannot start checkout, open the portal, or read invoices', { skip }, async () => {
  const owner  = await makeUser('perm_owner');
  const admin  = await makeUser('perm_admin');
  const member = await makeUser('perm_member');
  const viewer = await makeUser('perm_viewer');
  const org    = await createOrg(owner, 'Permissions Inc');
  await addMember(org, admin,  'admin');
  await addMember(org, member, 'member');
  await addMember(org, viewer, 'viewer');

  for (const actor of [member, viewer]) {
    const checkout = await request.post(`/api/v1/orgs/${org.id}/billing/checkout`)
      .set(auth(actor)).send({ planKey: PRO_PLAN.key });
    assert.strictEqual(checkout.status, 403, `checkout must be denied (${JSON.stringify(checkout.body)})`);

    const portal = await request.post(`/api/v1/orgs/${org.id}/billing/portal`).set(auth(actor));
    assert.strictEqual(portal.status, 403, 'portal must be denied');

    const invoices = await request.get(`/api/v1/orgs/${org.id}/billing/invoices`).set(auth(actor));
    assert.strictEqual(invoices.status, 403, 'invoices must be denied');

    // ...but reading the current plan is allowed for everyone.
    assert.strictEqual((await request.get(`/api/v1/orgs/${org.id}/billing`).set(auth(actor))).status, 200);
  }

  // An admin may do all of it.
  const asAdmin = await request.post(`/api/v1/orgs/${org.id}/billing/checkout`)
    .set(auth(admin)).send({ planKey: PRO_PLAN.key });
  assert.strictEqual(asAdmin.status, 201, JSON.stringify(asAdmin.body));
});

// ── Webhook: signature (over real HTTP, through the raw-body mount) ───────────

test('webhook rejects an unsigned or wrongly-signed request with 400 and processes nothing', { skip }, async () => {
  const owner = await makeUser('sig');
  const org   = await createOrg(owner, 'Signature Inc');

  const event = checkoutCompleted({
    id: `${EVENT_PREFIX}badsig_${Date.now()}`, organizationId: org.id, planKey: PRO_PLAN.key,
    customerId: 'cus_btest_sig', subscriptionId: uniqId('sub'), created: new Date(),
  });

  const unsigned = await request.post('/api/v1/webhooks/stripe')
    .set('Content-Type', 'application/json').send(JSON.stringify(event));
  assert.strictEqual(unsigned.status, 400);

  const wrongSecret = await postSignedWebhook(event, { secret: 'whsec_attacker_guess' });
  assert.strictEqual(wrongSecret.status, 400);

  const sub = await subscriptionOf(org.id);
  assert.strictEqual(sub.plan.key, 'free', 'an unverified event must not change any state');
  assert.strictEqual(await prisma.processedWebhookEvent.count({ where: { eventId: event.id } }), 0,
    'a rejected event must not be recorded as processed');
});

test('webhook accepts a correctly signed request through the raw-body mount', { skip }, async () => {
  const owner = await makeUser('http');
  const org   = await createOrg(owner, 'Raw Body Inc');
  const subscriptionId = uniqId('sub');

  const res = await postSignedWebhook(checkoutCompleted({
    id: `${EVENT_PREFIX}http_${Date.now()}`, organizationId: org.id, planKey: PRO_PLAN.key,
    customerId: 'cus_btest_http', subscriptionId, created: new Date(),
  }));

  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.status, 'processed');

  const sub = await subscriptionOf(org.id);
  assert.strictEqual(sub.plan.key, PRO_PLAN.key);
  assert.strictEqual(sub.status, 'active');
  assert.strictEqual(sub.stripeCustomerId, 'cus_btest_http');
  assert.strictEqual(sub.stripeSubscriptionId, subscriptionId);
});

// ── Webhook: event processing ─────────────────────────────────────────────────

test('checkout.session.completed upgrades the organization to the purchased plan', { skip }, async () => {
  const owner = await makeUser('upgrade');
  const org   = await createOrg(owner, 'Upgrade Inc');

  assert.strictEqual((await subscriptionOf(org.id)).plan.key, 'free');
  assert.strictEqual(await checkEntitlement(org.id, 'apiAccess'), false);

  const outcome = await processStripeEvent(checkoutCompleted({
    id: `${EVENT_PREFIX}up_${Date.now()}`, organizationId: org.id, planKey: PRO_PLAN.key,
    customerId: 'cus_btest_up', subscriptionId: uniqId('sub'), created: new Date(),
  }));

  assert.strictEqual(outcome.status, 'processed');
  const sub = await subscriptionOf(org.id);
  assert.strictEqual(sub.plan.key, PRO_PLAN.key);
  assert.strictEqual(sub.status, 'active');
  assert.strictEqual(await checkEntitlement(org.id, 'apiAccess'), true, 'entitlements follow the new plan immediately');
});

test('customer.subscription.updated syncs status, period and plan verbatim from Stripe', { skip }, async () => {
  const owner = await makeUser('sync');
  const org   = await createOrg(owner, 'Sync Inc');
  const subscriptionId = uniqId('sub');
  const periodEnd = new Date(Date.now() + 30 * 24 * 3600 * 1000);

  await processStripeEvent(checkoutCompleted({
    id: `${EVENT_PREFIX}sync_a_${Date.now()}`, organizationId: org.id, planKey: PRO_PLAN.key,
    customerId: 'cus_btest_sync', subscriptionId, created: new Date(Date.now() - 60_000),
  }));

  await processStripeEvent(subscriptionUpdated({
    id: `${EVENT_PREFIX}sync_b_${Date.now()}`, subscriptionId, customerId: 'cus_btest_sync',
    status: 'trialing', created: new Date(), periodEnd, priceId: PRO_PRICE_ID,
  }));

  const sub = await subscriptionOf(org.id);
  assert.strictEqual(sub.status, 'trialing', 'Stripe\'s own status vocabulary is stored verbatim');
  assert.strictEqual(sub.currentPeriodEnd.getTime(), new Date(unix(periodEnd) * 1000).getTime());
  // trialing is an entitled status — that is the point of a trial.
  assert.strictEqual(await checkEntitlement(org.id, 'apiAccess'), true);
});

test('invoice.payment_failed marks past_due and degrades entitlements to free, keeping the plan visible', { skip }, async () => {
  const owner = await makeUser('dunning');
  const org   = await createOrg(owner, 'Dunning Inc');
  const subscriptionId = uniqId('sub');

  await processStripeEvent(checkoutCompleted({
    id: `${EVENT_PREFIX}dun_a_${Date.now()}`, organizationId: org.id, planKey: PRO_PLAN.key,
    customerId: 'cus_btest_dun', subscriptionId, created: new Date(Date.now() - 60_000),
  }));
  assert.strictEqual(await checkEntitlement(org.id, 'apiAccess'), true);

  await processStripeEvent(invoicePaymentFailed({
    id: `${EVENT_PREFIX}dun_b_${Date.now()}`, subscriptionId, customerId: 'cus_btest_dun', created: new Date(),
  }));

  const sub = await subscriptionOf(org.id);
  assert.strictEqual(sub.status, 'past_due');
  assert.strictEqual(sub.plan.key, PRO_PLAN.key, 'the row still names the paid plan so the UI can say what is at risk');
  assert.strictEqual(await checkEntitlement(org.id, 'apiAccess'), false, 'access degrades to free immediately');
  assert.strictEqual(await checkEntitlement(org.id, 'maxMembers'), 3, 'free-plan limits apply while past due');

  const res = await request.get(`/api/v1/orgs/${org.id}/billing`).set(auth(owner));
  assert.strictEqual(result(res).subscription.entitled, false);
  assert.strictEqual(result(res).subscription.plan.key, PRO_PLAN.key);
});

test('customer.subscription.deleted downgrades to free and clears the subscription id', { skip }, async () => {
  const owner = await makeUser('cancel');
  const org   = await createOrg(owner, 'Cancel Inc');
  const subscriptionId = uniqId('sub');

  await processStripeEvent(checkoutCompleted({
    id: `${EVENT_PREFIX}can_a_${Date.now()}`, organizationId: org.id, planKey: PRO_PLAN.key,
    customerId: 'cus_btest_can', subscriptionId, created: new Date(Date.now() - 60_000),
  }));

  await processStripeEvent(subscriptionDeleted({
    id: `${EVENT_PREFIX}can_b_${Date.now()}`, subscriptionId, customerId: 'cus_btest_can', created: new Date(),
  }));

  const sub = await subscriptionOf(org.id);
  assert.strictEqual(sub.plan.key, 'free');
  assert.strictEqual(sub.status, 'canceled');
  assert.strictEqual(sub.stripeSubscriptionId, null, 'cleared so a future re-subscribe cannot collide on the unique index');
  assert.strictEqual(sub.stripeCustomerId, 'cus_btest_can', 'the customer is kept so the portal still opens');
  assert.strictEqual(await checkEntitlement(org.id, 'apiAccess'), false);
});

test('an event naming no organization this app knows is claimed, not retried forever', { skip }, async () => {
  const eventId = `${EVENT_PREFIX}orphan_${Date.now()}`;
  const outcome = await processStripeEvent(subscriptionUpdated({
    id: eventId, subscriptionId: 'sub_never_seen', customerId: 'cus_never_seen',
    status: 'active', created: new Date(), priceId: PRO_PRICE_ID,
  }));

  assert.strictEqual(outcome.status, 'unmatched');
  assert.strictEqual(await prisma.processedWebhookEvent.count({ where: { eventId } }), 1,
    'claimed so Stripe stops retrying an event for a tenant that does not exist');
});

test('an unhandled event type is claimed and ignored', { skip }, async () => {
  const eventId = `${EVENT_PREFIX}unhandled_${Date.now()}`;
  const outcome = await processStripeEvent({
    id: eventId, object: 'event', type: 'customer.discount.created',
    created: unix(new Date()), data: { object: { id: 'di_1', object: 'discount' } },
  });
  assert.strictEqual(outcome.status, 'ignored');
  assert.strictEqual(await prisma.processedWebhookEvent.count({ where: { eventId } }), 1);
});

// ── Idempotency: replay ───────────────────────────────────────────────────────

test('IDEMPOTENCY: replaying the same event id applies it exactly once', { skip }, async () => {
  const owner = await makeUser('replay');
  const org   = await createOrg(owner, 'Replay Inc');
  const eventId = `${EVENT_PREFIX}replay_${Date.now()}`;
  const event = checkoutCompleted({
    id: eventId, organizationId: org.id, planKey: PRO_PLAN.key,
    customerId: 'cus_btest_replay', subscriptionId: uniqId('sub'), created: new Date(),
  });

  const first = await processStripeEvent(event);
  assert.strictEqual(first.status, 'processed');
  const afterFirst = await subscriptionOf(org.id);

  // Stripe redelivers the identical event — three more times, for good measure.
  for (let i = 0; i < 3; i++) {
    const again = await processStripeEvent(event);
    assert.strictEqual(again.status, 'duplicate', 'a redelivered event must be recognised, not re-applied');
  }

  const afterReplays = await subscriptionOf(org.id);
  assert.strictEqual(afterReplays.updatedAt.getTime(), afterFirst.updatedAt.getTime(),
    'a duplicate must not even touch the row (updatedAt unchanged)');
  assert.strictEqual(afterReplays.plan.key, PRO_PLAN.key);
  assert.strictEqual(await prisma.processedWebhookEvent.count({ where: { eventId } }), 1);
});

test('IDEMPOTENCY: a replay over real HTTP answers 200 so Stripe stops retrying', { skip }, async () => {
  const owner = await makeUser('replay_http');
  const org   = await createOrg(owner, 'Replay HTTP Inc');
  const event = checkoutCompleted({
    id: `${EVENT_PREFIX}replayhttp_${Date.now()}`, organizationId: org.id, planKey: PRO_PLAN.key,
    customerId: 'cus_btest_rh', subscriptionId: uniqId('sub'), created: new Date(),
  });

  const first  = await postSignedWebhook(event);
  const second = await postSignedWebhook(event);

  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.status, 'processed');
  assert.strictEqual(second.status, 200, 'a duplicate is a success, not an error — 4xx/5xx would make Stripe retry');
  assert.strictEqual(second.body.status, 'duplicate');
});

test('IDEMPOTENCY: concurrent deliveries of the same event apply it exactly once', { skip }, async () => {
  const owner = await makeUser('concurrent');
  const org   = await createOrg(owner, 'Concurrent Inc');
  const eventId = `${EVENT_PREFIX}concurrent_${Date.now()}`;
  const event = checkoutCompleted({
    id: eventId, organizationId: org.id, planKey: PRO_PLAN.key,
    customerId: 'cus_btest_conc', subscriptionId: uniqId('sub'), created: new Date(),
  });

  // The claim is a primary-key INSERT inside the same transaction as the write,
  // so exactly one of these can win however they interleave.
  const outcomes = await Promise.allSettled([
    processStripeEvent(event), processStripeEvent(event),
    processStripeEvent(event), processStripeEvent(event),
  ]);

  const statuses = outcomes
    .filter(o => o.status === 'fulfilled')
    .map(o => o.value.status);
  assert.strictEqual(statuses.filter(s => s === 'processed').length, 1,
    `exactly one delivery must be processed, got ${JSON.stringify(statuses)}`);
  assert.strictEqual(await prisma.processedWebhookEvent.count({ where: { eventId } }), 1);
});

// ── Out-of-order delivery ─────────────────────────────────────────────────────

test('OUT-OF-ORDER: an older event delivered later does not clobber newer state', { skip }, async () => {
  const owner = await makeUser('ooo');
  const org   = await createOrg(owner, 'Out Of Order Inc');
  const subscriptionId = uniqId('sub');
  const customerId = 'cus_btest_ooo';

  const tEarly = new Date(Date.now() - 2 * 3600 * 1000);
  const tLate  = new Date(Date.now() - 1 * 3600 * 1000);

  await processStripeEvent(checkoutCompleted({
    id: `${EVENT_PREFIX}ooo_a_${Date.now()}`, organizationId: org.id, planKey: PRO_PLAN.key,
    customerId, subscriptionId, created: new Date(Date.now() - 3 * 3600 * 1000),
  }));

  // The NEWER event arrives first: the org paid and is active again.
  const newer = await processStripeEvent(subscriptionUpdated({
    id: `${EVENT_PREFIX}ooo_new_${Date.now()}`, subscriptionId, customerId,
    status: 'active', created: tLate, priceId: PRO_PRICE_ID,
  }));
  assert.strictEqual(newer.status, 'processed');
  assert.strictEqual((await subscriptionOf(org.id)).status, 'active');

  // Now Stripe redelivers the OLDER past_due event it failed to deliver earlier.
  const olderId = `${EVENT_PREFIX}ooo_old_${Date.now()}`;
  const older = await processStripeEvent(invoicePaymentFailed({
    id: olderId, subscriptionId, customerId, created: tEarly,
  }));

  assert.strictEqual(older.status, 'stale', 'an event older than the watermark must not mutate state');
  const sub = await subscriptionOf(org.id);
  assert.strictEqual(sub.status, 'active', 'a stale past_due must NOT knock a paid-up org back into dunning');
  assert.strictEqual(await checkEntitlement(org.id, 'apiAccess'), true);

  // Still claimed, so Stripe stops retrying it.
  assert.strictEqual(await prisma.processedWebhookEvent.count({ where: { eventId: olderId } }), 1);
});

test('OUT-OF-ORDER: a stale older event does not drag the watermark backwards', { skip }, async () => {
  const owner = await makeUser('watermark');
  const org   = await createOrg(owner, 'Watermark Inc');
  const subscriptionId = uniqId('sub');
  const customerId = 'cus_btest_wm';

  const tNew = new Date(Date.now() - 1 * 3600 * 1000);
  const tOld = new Date(Date.now() - 5 * 3600 * 1000);

  await processStripeEvent(checkoutCompleted({
    id: `${EVENT_PREFIX}wm_a_${Date.now()}`, organizationId: org.id, planKey: PRO_PLAN.key,
    customerId, subscriptionId, created: new Date(Date.now() - 6 * 3600 * 1000),
  }));
  await processStripeEvent(subscriptionUpdated({
    id: `${EVENT_PREFIX}wm_new_${Date.now()}`, subscriptionId, customerId,
    status: 'active', created: tNew, priceId: PRO_PRICE_ID,
  }));

  const watermarkBefore = (await subscriptionOf(org.id)).lastEventAt;
  assert.strictEqual(watermarkBefore.getTime(), new Date(unix(tNew) * 1000).getTime());

  await processStripeEvent(invoicePaymentFailed({
    id: `${EVENT_PREFIX}wm_old_${Date.now()}`, subscriptionId, customerId, created: tOld,
  }));

  const watermarkAfter = (await subscriptionOf(org.id)).lastEventAt;
  assert.strictEqual(watermarkAfter.getTime(), watermarkBefore.getTime(),
    'a rejected stale event must leave the watermark where it was');
});

test('OUT-OF-ORDER: cancellation is terminal and applies even when delivered out of order', { skip }, async () => {
  const owner = await makeUser('terminal');
  const org   = await createOrg(owner, 'Terminal Inc');
  const subscriptionId = uniqId('sub');
  const customerId = 'cus_btest_term';

  await processStripeEvent(checkoutCompleted({
    id: `${EVENT_PREFIX}term_a_${Date.now()}`, organizationId: org.id, planKey: PRO_PLAN.key,
    customerId, subscriptionId, created: new Date(Date.now() - 3 * 3600 * 1000),
  }));
  await processStripeEvent(subscriptionUpdated({
    id: `${EVENT_PREFIX}term_b_${Date.now()}`, subscriptionId, customerId,
    status: 'active', created: new Date(), priceId: PRO_PRICE_ID,
  }));
  assert.strictEqual((await subscriptionOf(org.id)).status, 'active');

  // The delete is OLDER than the active we just applied, but there is no later
  // event that un-deletes a subscription — honouring the stale 'active' would
  // leave a cancelled org entitled.
  const outcome = await processStripeEvent(subscriptionDeleted({
    id: `${EVENT_PREFIX}term_c_${Date.now()}`, subscriptionId, customerId,
    created: new Date(Date.now() - 2 * 3600 * 1000),
  }));

  assert.strictEqual(outcome.status, 'processed');
  const sub = await subscriptionOf(org.id);
  assert.strictEqual(sub.status, 'canceled');
  assert.strictEqual(sub.plan.key, 'free');
  assert.strictEqual(await checkEntitlement(org.id, 'apiAccess'), false);
});

// ── Entitlements ──────────────────────────────────────────────────────────────

test('checkEntitlement reflects the organization\'s current plan, and fails closed on unknown keys', { skip }, async () => {
  const owner = await makeUser('ent');
  const org   = await createOrg(owner, 'Entitlement Inc');

  assert.strictEqual(await checkEntitlement(org.id, 'apiAccess'), false);
  assert.strictEqual(await checkEntitlement(org.id, 'maxMembers'), 3);
  assert.strictEqual(await checkEntitlement(org.id, 'aFeatureNobodyDefined'), false,
    'an unknown feature key must be denied, never silently granted');

  await processStripeEvent(checkoutCompleted({
    id: `${EVENT_PREFIX}ent_${Date.now()}`, organizationId: org.id, planKey: PRO_PLAN.key,
    customerId: 'cus_btest_ent', subscriptionId: uniqId('sub'), created: new Date(),
  }));

  assert.strictEqual(await checkEntitlement(org.id, 'apiAccess'), true);
  assert.strictEqual(await checkEntitlement(org.id, 'maxMembers'), 25);
  const features = await effectiveFeatures(org.id);
  assert.strictEqual(features.maxFiles, 1000);
});

test('checkEntitlement reports -1 (UNLIMITED) for an uncapped plan', { skip }, async () => {
  const owner = await makeUser('unlimited');
  const org   = await createOrg(owner, 'Unlimited Inc');
  const unlimitedPlan = await prisma.plan.create({
    data: {
      key: `${PLAN_PREFIX}unlimited`, name: 'Unlimited', priceMonthlyCents: 9900,
      stripePriceId: 'price_btest_unlimited',
      features: { maxMembers: -1, maxFiles: -1, apiAccess: true },
    },
  });

  await processStripeEvent(checkoutCompleted({
    id: `${EVENT_PREFIX}unl_${Date.now()}`, organizationId: org.id, planKey: unlimitedPlan.key,
    customerId: 'cus_btest_unl', subscriptionId: uniqId('sub'), created: new Date(),
  }));

  assert.strictEqual(await checkEntitlement(org.id, 'maxMembers'), UNLIMITED);
  assert.strictEqual(UNLIMITED, -1);
});

test('requireEntitlement gates a route: denied on free, allowed on pro', { skip }, async () => {
  const owner = await makeUser('gate');
  const org   = await createOrg(owner, 'Gated Inc');

  // A throwaway app mounting the primitive exactly as a future module would:
  //   router.post('/foo', verifyToken, tenantContext, requireEntitlement('apiAccess'), handler)
  const { requireEntitlement } = require('../helpers/entitlements');
  const verifyToken   = require('../middleware/verifyToken');
  const tenantContext = require('../middleware/tenantContext');

  const app = express();
  app.use(express.json());
  app.get('/api/v1/orgs/:orgId/gated',
    verifyToken, tenantContext, requireEntitlement('apiAccess'),
    (req, res) => apiResponse.send(res, 'SUCCESS', { ok: true, entitlement: req.entitlement }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error('[gate app]', err);
    return apiResponse.send(res, 'SERVER_ERROR');
  });
  const gated = supertest(app);

  const denied = await gated.get(`/api/v1/orgs/${org.id}/gated`).set(auth(owner));
  assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
  assert.strictEqual(result(denied).upgradeRequired, true);
  assert.strictEqual(result(denied).feature, 'apiAccess');

  await processStripeEvent(checkoutCompleted({
    id: `${EVENT_PREFIX}gate_${Date.now()}`, organizationId: org.id, planKey: PRO_PLAN.key,
    customerId: 'cus_btest_gate', subscriptionId: uniqId('sub'), created: new Date(),
  }));

  const allowed = await gated.get(`/api/v1/orgs/${org.id}/gated`).set(auth(owner));
  assert.strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
  assert.strictEqual(result(allowed).ok, true);
});

test('an organization with no subscription row at all degrades to free rather than throwing', { skip }, async () => {
  const owner = await makeUser('orphan_sub');
  const org   = await createOrg(owner, 'Orphan Sub Inc');
  await prisma.subscription.delete({ where: { organizationId: org.id } });

  assert.strictEqual(await checkEntitlement(org.id, 'apiAccess'), false);
  assert.strictEqual(await checkEntitlement(org.id, 'maxMembers'), 3);
});

// Unit tests for helpers/billingProvider.js — no DB, no Redis, no network, and
// no live Stripe account.
//
// HOW THIS TESTS REAL SIGNATURE VERIFICATION WITHOUT STRIPE:
// stripe.webhooks.generateTestHeaderString() is part of the shipped SDK and
// computes the exact same HMAC-SHA256 scheme Stripe's servers use. Signing a
// payload with it and then verifying through the adapter exercises the
// production verification path end to end, offline. The only thing not covered
// is Stripe's own signing — which is not this codebase's code.
const test = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');

const WEBHOOK_SECRET = 'whsec_test_secret_for_unit_tests';

// billingProvider reads STRIPE_* lazily, per call — set before requiring so the
// module has nothing captured at import time either way.
process.env.STRIPE_SECRET_KEY    = 'sk_test_not_a_real_key';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { realProvider, getBillingProvider, setBillingProvider, resetBillingProvider } =
  require('../helpers/billingProvider');

const signer = new Stripe('sk_test_not_a_real_key');

function signed(payloadObject, { secret = WEBHOOK_SECRET, timestamp } = {}) {
  const payload   = JSON.stringify(payloadObject);
  const signature = signer.webhooks.generateTestHeaderString({ payload, secret, timestamp });
  return { payload, signature };
}

const sampleEvent = {
  id:      'evt_test_signature',
  object:  'event',
  type:    'checkout.session.completed',
  created: Math.floor(Date.now() / 1000),
  data:    { object: { id: 'cs_test_1', object: 'checkout_session' } },
};

test('verifyWebhookSignature accepts a correctly signed payload and returns the parsed event', () => {
  const { payload, signature } = signed(sampleEvent);
  const event = realProvider.verifyWebhookSignature(payload, signature);
  assert.equal(event.id, 'evt_test_signature');
  assert.equal(event.type, 'checkout.session.completed');
});

test('verifyWebhookSignature accepts a Buffer body — express.raw() hands us bytes, not a string', () => {
  const { payload, signature } = signed(sampleEvent);
  const event = realProvider.verifyWebhookSignature(Buffer.from(payload, 'utf8'), signature);
  assert.equal(event.id, 'evt_test_signature');
});

test('verifyWebhookSignature rejects a payload signed with the wrong secret', () => {
  const { payload, signature } = signed(sampleEvent, { secret: 'whsec_an_attackers_guess' });
  assert.throws(() => realProvider.verifyWebhookSignature(payload, signature), /signature/i);
});

test('verifyWebhookSignature rejects a body tampered with after signing', () => {
  const { payload, signature } = signed(sampleEvent);
  const tampered = payload.replace('cs_test_1', 'cs_test_attacker');
  assert.equal(tampered === payload, false, 'the tamper must actually change the bytes');
  assert.throws(() => realProvider.verifyWebhookSignature(tampered, signature), /signature/i);
});

test('verifyWebhookSignature rejects a missing signature header', () => {
  const { payload } = signed(sampleEvent);
  assert.throws(() => realProvider.verifyWebhookSignature(payload, undefined));
});

test('verifyWebhookSignature rejects a replay outside Stripe\'s timestamp tolerance', () => {
  // Signature is valid; the timestamp is an hour old. Stripe's default tolerance
  // is 5 minutes, so a captured-and-replayed request must not verify.
  const hourAgo = Math.floor(Date.now() / 1000) - 3600;
  const { payload, signature } = signed(sampleEvent, { timestamp: hourAgo });
  assert.throws(() => realProvider.verifyWebhookSignature(payload, signature), /timestamp|tolerance/i);
});

test('verifyWebhookSignature round-trip is byte-exact — re-serialising the body breaks the HMAC', () => {
  // Guards the reason the webhook route must be mounted before express.json():
  // JSON.parse → JSON.stringify changes whitespace/key order and invalidates the
  // signature. If this ever stops throwing, the raw-body requirement changed.
  const withSpaces = JSON.stringify(sampleEvent, null, 2);
  const signature  = signer.webhooks.generateTestHeaderString({ payload: withSpaces, secret: WEBHOOK_SECRET });
  const reparsed   = JSON.stringify(JSON.parse(withSpaces));
  assert.throws(() => realProvider.verifyWebhookSignature(reparsed, signature), /signature/i);
});

test('missing STRIPE_WEBHOOK_SECRET throws instead of silently accepting anything', () => {
  const saved = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  try {
    const { payload, signature } = signed(sampleEvent, { secret: saved });
    assert.throws(() => realProvider.verifyWebhookSignature(payload, signature), /STRIPE_WEBHOOK_SECRET/);
  } finally {
    process.env.STRIPE_WEBHOOK_SECRET = saved;
  }
});

test('setBillingProvider swaps the instance services resolve, resetBillingProvider restores it', async () => {
  assert.equal(getBillingProvider(), realProvider);

  setBillingProvider({
    createCheckoutSession: async () => ({ id: 'cs_fake', url: 'https://checkout.example/fake' }),
  });
  const session = await getBillingProvider().createCheckoutSession({});
  assert.equal(session.url, 'https://checkout.example/fake');

  resetBillingProvider();
  assert.equal(getBillingProvider(), realProvider);
});

test('the real adapter never reaches the network without a secret key', async () => {
  const saved = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  try {
    await assert.rejects(
      () => realProvider.createCheckoutSession({ priceId: 'price_x' }),
      /STRIPE_SECRET_KEY/
    );
  } finally {
    process.env.STRIPE_SECRET_KEY = saved;
  }
});

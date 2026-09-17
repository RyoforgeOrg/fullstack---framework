/**
 * Stripe webhook router — mounted in server.js at /api/v1/webhooks, BEFORE
 * express.json(), because HMAC verification needs the exact bytes Stripe signed.
 * It cannot live in routes/index.js: that router sits behind the global JSON
 * body parser, which would have already consumed and re-serialised the body.
 *
 * Unauthenticated by design. Stripe has no JWT — the signature IS the
 * authentication, and an unsigned or mis-signed request is rejected with 400
 * before any code touches the database.
 *
 * One fixed URL for every organization: Stripe posts to a single endpoint, and
 * the tenant is derived from the event payload (see StripeWebhookService's
 * resolveSubscription), never from the URL.
 */
const express = require('express');
const router  = express.Router();
const { handleStripeWebhook } = require('../services/StripeWebhookService');

// express.raw leaves req.body as a Buffer. Scoped to this route only — the rest
// of the API keeps the parsed-JSON body it expects.
router.post('/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

module.exports = router;

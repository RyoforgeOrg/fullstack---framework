// Express application entry point.
// Wires middleware, routes, WebSocket servers, and cron jobs.
const express      = require('express');
const http         = require('http');
const cors         = require('cors');
const helmet       = require('helmet');
const cookieParser = require('cookie-parser');
const multer       = require('multer');
const { randomUUID } = require('node:crypto');
const pinoHttp = require('pino-http');
const pino     = require('pino');
require('dotenv').config();

// Credential/token query params must never reach stdout via req.url logging
// (e.g. a mis-designed link like /reset?token=... or /verify?otp=...).
const URL_REDACT_PARAMS = ['token', 'refreshToken', 'otp', 'code', 'password'];
function sanitizeUrl(url) {
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return url;
  const params = new URLSearchParams(url.slice(qIndex + 1));
  let changed = false;
  for (const p of URL_REDACT_PARAMS) {
    if (params.has(p)) { params.set(p, '[REDACTED]'); changed = true; }
  }
  return changed ? `${url.slice(0, qIndex)}?${params.toString()}` : url;
}

// ── Production config guard ────────────────────────────────────────────────────
// Runs BEFORE infra modules are required so a misconfigured deploy fails with a
// clear message instead of an obscure Redis/Prisma connection crash.
if (process.env.NODE_ENV === 'production') {
  const weak  = (v) => !v || v.length < 32 || /change-?me/i.test(v);
  const missing = [];
  if (weak(process.env.JWT_SECRET))     missing.push('JWT_SECRET (>=32 chars, not "change-me")');
  if (weak(process.env.REFRESH_SECRET)) missing.push('REFRESH_SECRET (>=32 chars, not "change-me")');
  if (!process.env.DATABASE_URL)        missing.push('DATABASE_URL');
  if (!process.env.REDIS_HOST)          missing.push('REDIS_HOST');
  if (!process.env.REDIS_PORT)          missing.push('REDIS_PORT');
  // Password reset is always wired (forgot/reset-password routes) — without SMTP
  // in production, emailService would otherwise fall back to logging the raw OTP.
  if (!process.env.SMTP_HOST)           missing.push('SMTP_HOST (required — password reset emails)');
  if (missing.length) {
    console.error(`[config] Refusing to start in production. Missing/weak env: ${missing.join(', ')}`);
    process.exit(1);
  }
}

const routes        = require('./routes');
const apiResponse   = require('./helpers/apiResponse');
const logger        = require('./config/logger');
const { client, redisReady } = require('./config/redisConfig');
const prisma        = require('./config/dbConnect');

const app    = express();
const server = http.createServer(app);
const port   = process.env.PORT || 3000;

// Trust proxy so req.ip reflects the real client behind ALB/nginx. Without this
// every user shares the proxy IP → the login limiter counts them as one bucket.
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));

// ── Middleware ─────────────────────────────────────────────────────────────────
// CORS locked to FRONTEND_URL (comma-separated list supported). Dev default:
// localhost:5173 (Vite). Adjust in .env per environment. Shared with the WS
// hub's Origin check (helpers/ws/hub.js) via config/corsConfig.js.
// credentials:true + an explicit (never wildcard) origin list — required for the
// browser to send/receive the httpOnly refresh-token cookie (F11) cross-origin.
const { allowedOrigins } = require('./config/corsConfig');
app.use(cors({ origin: allowedOrigins, credentials: true }));

// Parses the httpOnly refresh-token cookie for POST /common/auth/refresh|logout.
app.use(cookieParser());

// Security headers: CSP, X-Frame-Options, nosniff, HSTS (behind TLS).
// The API serves JSON only — the SPA (separate container) defines its own CSP.
app.use(helmet());

// Structured request logging with x-request-id correlation across the cluster.
app.use(pinoHttp({
  logger,
  genReqId:  (req) => req.headers['x-request-id'] || randomUUID(),
  autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/health/deep' },
  serializers: {
    req(req) {
      const serialized = pino.stdSerializers.req(req);
      serialized.url = sanitizeUrl(serialized.url);
      return serialized;
    },
  },
}));

// If your product has a payment webhook that requires the raw body for HMAC verification,
// mount it HERE before express.json() using express.raw({ type: 'application/json' }).
// Stripe (billing module): express.raw is applied inside the router, scoped to
// that one route, so nothing else loses its parsed body.
app.use('/api/v1/webhooks', require('./modules/billing/routes/stripeWebhookRoutes'));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.locals.redis = client;

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use('/api/v1', routes);
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

// Deep health: verifies DB + Redis actually answer. Blue-green promotion uses
// this, so a broken database never gets promoted. Liveness /health stays shallow.
// Unauthenticated (blue-green health checks hit it over plain HTTP), so the
// response body never carries raw dependency error text — that's logged
// server-side only. Each check is bounded so a hung dependency can't hang the
// whole probe (same Promise.race pattern used for Redis readiness at boot).
const HEALTH_CHECK_TIMEOUT_MS = 4000;
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      t.unref();
    }),
  ]);
}
app.get('/health/deep', async (req, res) => {
  const [db, redis] = await Promise.allSettled([
    withTimeout(prisma.$queryRaw`SELECT 1`, HEALTH_CHECK_TIMEOUT_MS),
    withTimeout(client.ping(), HEALTH_CHECK_TIMEOUT_MS),
  ]);
  const ok = db.status === 'fulfilled' && redis.status === 'fulfilled';
  if (db.status === 'rejected')    logger.error({ err: db.reason },    'health/deep: db check failed');
  if (redis.status === 'rejected') logger.error({ err: redis.reason }, 'health/deep: redis check failed');
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'unhealthy',
    db:     db.status === 'fulfilled'    ? 'up' : 'down',
    redis:  redis.status === 'fulfilled' ? 'up' : 'down',
  });
});

// ── 404 + error handling (JSON envelope, never HTML) ──────────────────────────
// Express 5 forwards rejected async handlers here automatically.
app.use('/api/v1', (req, res) => apiResponse.send(res, 'NOT_FOUND'));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof multer.MulterError) {
    req.log?.warn({ err }, 'upload rejected');
    return apiResponse.send(res, 'INVALID_REQUEST', { message: err.message });
  }
  if (err.type === 'entity.too.large') {
    req.log?.warn({ err }, 'payload too large');
    return apiResponse.send(res, 'INVALID_REQUEST', { message: 'Payload too large.' });
  }

  req.log?.error({ err, reqId: req.id }, 'unhandled error');
  return apiResponse.send(res, 'SERVER_ERROR');
});

// ── Cron jobs ──────────────────────────────────────────────────────────────────
const { startPurgeCron } = require('./jobs/purgeExpiredTokens');
startPurgeCron();

// ── WebSocket hub (shared) ─────────────────────────────────────────────────────
// attachWsHub: generic /ws?token=...&channels=a,b for any realtime feature.
// attachJobWsServer: /ws/jobs/:jobId — live job progress (thin shim over the hub).
// Both register themselves (noServer WebSocketServer instances) against the
// SAME http.Server; hub.js installs exactly one 'upgrade' listener per server
// that dispatches by path to whichever hub matches, destroying the socket only
// for genuinely unmatched paths. Do NOT add another 'upgrade' listener here —
// a second listener would race the hub's handleUpgrade() and destroy sockets
// the hub already accepted.
const { attachWsHub }            = require('./helpers/ws/hub');
const { attachJobWsServer }      = require('./helpers/queue/jobWsServer');

attachWsHub(server);
attachJobWsServer(server);

// ── Start ──────────────────────────────────────────────────────────────────────
// Wait for the Redis connection so the first request never hits a rate-limiter /
// OTP / cache race. node-redis retries connect() forever by default, so cap the
// boot wait at 15s. Prod: fail fast when Redis is down — a silently-degraded API
// behind blue-green would promote traffic onto a half-dead instance. Dev: start
// anyway (HybridStore + cache helpers degrade; the client keeps retrying in the
// background and the store picks Redis back up on reconnect).
(async function start() {
  const BOOT_REDIS_TIMEOUT_MS = 15000;
  const redisUp = await Promise.race([
    redisReady,
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), BOOT_REDIS_TIMEOUT_MS);
      t.unref();
    }),
  ]);
  if (process.env.NODE_ENV === 'production' && !redisUp) {
    logger.fatal('Redis unreachable in production — refusing to start');
    process.exit(1);
  }
  server.listen(port, () => logger.info({ port }, 'server listening'));
})();

// ── Graceful shutdown ──────────────────────────────────────────────────────────
// Drains in-flight HTTP requests, then disconnects Prisma + Redis. Blue-green
// deploy kills the old container with SIGTERM — without this, requests die mid-flight.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'draining connections');

  const force = setTimeout(() => {
    logger.error('drain timeout — forcing exit');
    process.exit(1);
  }, 10000);
  force.unref();

  server.close(() => {
    Promise.allSettled([
      prisma.$disconnect(),
      client.quit().catch(() => {}),
    ]).finally(() => {
      logger.info('shutdown complete');
      process.exit(0);
    });
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

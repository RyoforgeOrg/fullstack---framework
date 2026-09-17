// Background job worker process.
// Run as a SEPARATE PM2 process (fork mode, NOT cluster) — see ecosystem.config.js.
// Each key in `handlers` is a queue name; the value is an async handler function.
// Handler signature: (payload, { jobId, reportProgress }) => Promise<result>
// Copy workers/_stub.js to create a new handler.
require('dotenv').config();

const { startWorker } = require('./helpers/queue/jobQueue');

// ── Register your product's job handlers here ──────────────────────────────────
// const { handleMyFeature } = require('./workers/myFeatureJobHandler');
const { handleNotificationEmail } = require('./workers/notificationEmailJobHandler');

const handlers = {
  // 'my-feature:action': handleMyFeature,
  'queue:notification-email': handleNotificationEmail,
};

const worker = startWorker(handlers, { exitOnError: false });

// Graceful shutdown: stop claiming new jobs, let whatever's in flight finish
// (or reach its next lease-renewal-safe point), then exit. Bounded so a stuck
// handler can never block the container from stopping — PM2/Docker eventually
// SIGKILLs anyway, but we want the normal path to be a clean exit within the
// grace period, not a mid-job kill that only the stuck-job sweep recovers from.
const DRAIN_TIMEOUT_MS = 25 * 1000;
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Worker] ${signal} received, draining...`);

  const forceExit = setTimeout(() => {
    console.error('[Worker] Drain timeout exceeded, forcing exit.');
    process.exit(1);
  }, DRAIN_TIMEOUT_MS + 2000); // headroom beyond startWorker's own internal drain deadline
  forceExit.unref?.();

  worker.stop(DRAIN_TIMEOUT_MS)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Worker] Error during shutdown:', err.message);
      process.exit(1);
    });
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

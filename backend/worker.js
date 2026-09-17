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

startWorker(handlers, { exitOnError: false });

process.on('SIGINT',  () => { console.log('[Worker] SIGINT received, shutting down.'); process.exit(0); });
process.on('SIGTERM', () => { console.log('[Worker] SIGTERM received, shutting down.'); process.exit(0); });

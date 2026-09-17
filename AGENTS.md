# AGENTS.md — Project Guide for AI Agents

Read this file completely before writing any code in this repo.

---

## What This Repo Is

A **production-grade SaaS scaffold** built on a proven stack. Use it to bootstrap new SaaS products (CRM, ERP, LMS, HRMS, Marketplace, etc.) without starting from zero. The auth system, background jobs, deployment pipeline, and common infrastructure are production-ready.

---

## Repository Layout

```
.
├── ARCHITECTURE.md          # Stack reference, naming conventions, module loop, security checklist
├── AGENTS.md                # This file
├── SOURCE-MAPPING.md        # Every file: what it does, status, what to customize
├── .claude/
│   └── CLAUDE.md            # Claude Code session context
│
├── backend/
│   ├── server.js            # Express entry point + HTTP server (WS, crons wire here)
│   ├── worker.js            # PM2 worker process — background job consumer
│   ├── ecosystem.config.js  # PM2: cluster (api) + fork (worker)
│   ├── start.sh             # Container entrypoint: migrate → worker → server
│   ├── prisma.config.ts     # Prisma 7 config
│   ├── dockerfile           # node:22-slim, prisma generate, start.sh CMD
│   ├── docker-compose.yml   # Single-service compose (external DB/Redis)
│   ├── .dockerignore
│   ├── DOCKER.md            # Deployment setup guide
│   ├── .github/workflows/
│   │   ├── deploy.yml       # DEV: push deployment-dev → ECR → EC2 blue-green
│   │   └── deploy-prod.yml  # PROD: push v* tag → ECR → EC2 blue-green
│   │
│   ├── config/
│   │   ├── dbConnect.js     # PrismaClient with @prisma/adapter-pg (pg.Pool)
│   │   ├── redisConfig.js   # Redis client + getCache/setCache/deleteCache
│   │   ├── s3.js            # AWS S3Client
│   │   └── cloudinary.js    # Cloudinary v2
│   │
│   ├── prisma/
│   │   └── schema.prisma    # User, RefreshToken, AuditLog base models
│   │                        # Add product domain models below the marker
│   │
│   ├── globals/
│   │   └── response.json    # Response codes 1000–1014
│   │
│   ├── helpers/
│   │   ├── apiResponse.js   # response('KEY', data) — standard envelope
│   │   ├── paginate.js      # page/limit/skip/meta helper
│   │   ├── auditLogger.js   # auditLog.create wrapper
│   │   ├── generateToken.js # JWT access + refresh token helpers
│   │   ├── emailService.js  # SMTP transport (dev mode logs when SMTP_HOST unset)
│   │   ├── ws/
│   │   │   └── hub.js       # Reusable WS emitter/receiver: attachWsHub + emitToChannel
│   │   └── queue/
│   │       ├── jobQueue.js     # Redis BLPOP queue (enqueue, status, progress)
│   │       └── jobWsServer.js  # /ws/jobs/:jobId shim over ws/hub.js
│   │
│   ├── middleware/
│   │   ├── verifyToken.js   # Bearer JWT auth → req.user
│   │   ├── role.js          # role(...roles) guard
│   │   ├── accessLevel.js   # read-only enforcement
│   │   ├── rateLimit.js     # createLimiter() factory + preset limiters
│   │   └── upload.js        # multer memoryStorage 5 MB
│   │
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── routes/authRoutes.js    # login, refresh, me, logout, profile, pwd reset
│   │   │   └── services/AuthService.js # full auth logic
│   │   └── notifications/
│   │       ├── notificationCategories.js  # type → category (security/organization/product)
│   │       ├── routes/notificationRoutes.js
│   │       └── services/NotificationService.js  # notify(), list/markRead/preferences
│   │
│   ├── routes/
│   │   └── index.js         # Central router — add module mounts here
│   │
│   ├── scripts/
│   │   ├── generateModule.js    # npm run gen:module <name>
│   │   ├── generateModel.js     # npm run gen:model <Name>
│   │   ├── generateMigration.js # npm run gen:migration <name>
│   │   ├── deployMigration.js   # npm run migrate:deploy
│   │   ├── generatePostman.js   # npm run gen:postman [name]
│   │   └── createSuperAdmin.js  # npm run create:superadmin
│   │
│   ├── jobs/
│   │   └── _stub.js         # Cron job template
│   └── workers/
│       ├── _stub.js         # Background job handler template
│       └── notificationEmailJobHandler.js  # queue:notification-email — sends via emailService
│
└── frontend/
    ├── server.js            # Express SPA server with OG meta injection
    ├── nginx.conf           # Alternative: plain nginx static host
    ├── dockerfile           # Multi-stage: builder (Vite) → prod (Express)
    ├── docker-compose.yml
    ├── .github/workflows/
    │   ├── deploy.yml
    │   └── deploy-prod.yml
    ├── vite.config.js       # plugins: [react(), tailwindcss()]
    ├── eslint.config.js     # ESLint 9 flat config
    ├── index.html           # SPA shell with OG placeholders
    └── src/
        ├── main.jsx
        ├── App.jsx          # Route definitions + DefaultRedirect
        ├── contexts/
        │   └── AuthContext.jsx  # Global auth state, useAuth()
        ├── components/
        │   ├── PrivateRoute.jsx
        │   ├── MainLayout.jsx   # Desktop sidebar — define NAV_ITEMS
        │   ├── MobileLayout.jsx # Mobile bottom nav — define MOBILE_NAV_ITEMS
        │   └── common/          # 17 reusable UI primitives + NotificationBell.jsx
        ├── hooks/
        │   ├── useDataFetch.js  # Generic data fetch hook
        │   └── useWebSocket.js  # channel subscribe hook over server/ws.js
        ├── server/
        │   ├── api.js            # Single API gateway — all fetch() calls live here
        │   └── ws.js              # Shared WS client (wsClient) over the hub
        ├── utils/
        │   └── subdomain.js     # Subdomain detection (multi-tenant)
        └── pages/
            └── _stub.jsx        # Page template
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend runtime | Node.js 22, Express 5 |
| Database ORM | Prisma 7 + `@prisma/adapter-pg` (pg.Pool driver) |
| Database | PostgreSQL |
| Cache / Queue | Redis 5 |
| Auth | JWT (24h access + 7d refresh rotation), bcrypt |
| File upload | multer → AWS S3 or Cloudinary |
| Email | SMTP via nodemailer (`SMTP_*` env — AWS SES-compatible) |
| SMS / WhatsApp | Twilio |
| Payments | Razorpay (unwire if not needed) |
| Background jobs | Custom Redis BLPOP queue (3 retries + stuck-job recovery) + node-cron |
| Process manager | PM2 (cluster API + fork worker) |
| Real-time | WebSocket (`ws`) bridging Redis pub/sub |
| Frontend | React 19, React Router 7, Vite 7 (SWC) |
| Styling | Tailwind CSS 4 (Vite plugin — no config file) |
| State | React Context + useState (no Redux/Zustand/React Query) |
| HTTP client | Native `fetch` (no axios on frontend) |
| Icons | Phosphor Icons + react-icons |

**No TypeScript (exception: `src/components/designs/` templates are TSX). No Prettier.** ESLint 9 flat config only. Tests: `node:test` (backend) + Vitest (frontend) — run via `npm test`.

---

## API Response Envelope

Every backend response uses:
```json
{
  "responseCode": 1000,
  "responseMessage": "Operation completed successfully.",
  "responseData": { "result": <payload> }
}
```

Codes live in `backend/globals/response.json` (1000–1014).
Use `helpers/apiResponse.js` → `response('SUCCESS', data)` to send.
The frontend `api.js` unwraps automatically — pages receive `result` directly.

---

## Module Creation Loop

```bash
# 1. Scaffold backend module
npm run gen:module invoice

# 2. Add Prisma model
npm run gen:model Invoice id:cuid name:String amount:Float createdAt:DateTime

# 3. Run migration
npm run gen:migration add_invoice

# 4. Implement logic in modules/invoice/services/InvoiceService.js
# 5. Wire routes in modules/invoice/routes/invoiceRoutes.js
# 6. routes/index.js is auto-updated by gen:module
# 7. Add API namespace to frontend/src/server/api.js
# 8. Build page in frontend/src/pages/invoice/InvoicePage.jsx
# 9. Add route in frontend/src/App.jsx
# 10. Generate Postman collection
npm run gen:postman "My App API"
```

---

## Auth Pattern

| Endpoint | Route |
|----------|-------|
| Login | `POST /api/v1/common/auth/login` → `{ token, refreshToken, user }` |
| Refresh | `POST /api/v1/common/auth/refresh` — single-use rotation |
| Me | `GET  /api/v1/common/auth/me` |
| Logout | `POST /api/v1/common/auth/logout` |

**Middleware chain for protected routes:**
```js
router.get('/resource',  verifyToken, role('admin'),                     handler);
router.post('/resource', verifyToken, role('admin'), requireReadWrite(), handler);
```

**Force-logout all sessions:** increment `tokenVersion` on the User row.
**Lockout:** 5 consecutive failures → `lockedUntil` set 15 min ahead.

> **Refresh tokens are OPAQUE `randomBytes(48)` values, NOT JWTs** (a deterministic
> JWT collided on the unique `tokenHash` on every 2nd login and broke rotation).
> Validation = DB lookup by `tokenHash` + `revoked`/`expiredAt` checks; expiry lives
> in the DB row. Rate limits are Redis-backed with per-limiter prefixes
> (`rl:login:`/`rl:otp:`/`rl:refresh:`/`rl:general:`) and degrade to in-memory
> sliding windows if Redis drops; prod refuses to boot when Redis is unreachable.

---

## Background Jobs

```js
// Enqueue from any service:
const { enqueueJob } = require('../../helpers/queue/jobQueue');
const { jobId } = await enqueueJob('invoice:send-pdf', { invoiceId }, { userId: req.user.id });

// Handler (workers/invoiceSendPdfJobHandler.js):
async function handleInvoiceSendPdf(payload, { jobId, reportProgress }) {
  await reportProgress(0, 'Starting…');
  // ... work ...
  await reportProgress(100, 'Done.');
  return { sent: true };
}

// Register in worker.js:
handlers['invoice:send-pdf'] = handleInvoiceSendPdf;
```

Stream progress to browser: the shared WS hub relays `emitToChannel('job:<jobId>', …)` (Redis pub/sub → every API instance → subscribed sockets). Server wires it in `server.js` (`attachWsHub` + `attachJobWsServer`); client uses `frontend/src/server/ws.js`.

```js
// Any service (API or worker) — push to a channel:
const { emitToChannel } = require('./helpers/ws/hub');
await emitToChannel('user:' + userId, { event: 'plan-changed' });

// Browser:
import { wsClient } from '../server/ws';
wsClient.onChannel('user:' + userId, (payload) => ...);  // auto-connects
```

**Reliability:** handlers get 3 attempts (re-queued with backoff-free retry on failure). Jobs stuck in `processing` (crashed worker) are re-queued automatically on next worker start. Always pass `{ userId: req.user.id }` in the meta arg — the WS hub refuses job channels without a matching owner.

---

## Frontend Patterns

| Pattern | Where |
|---------|-------|
| All API calls | `src/server/api.js` — never call `fetch()` directly in pages |
| Realtime events | `src/server/ws.js` (`wsClient`) — never `new WebSocket()` in pages |
| Realtime in React | `useWebSocket(channel, handler)` from `src/hooks/useWebSocket.js` |
| Auth state | `useAuth()` from `AuthContext` |
| Protected pages | `<PrivateRoute allowedRoles={['admin']}>` |
| Data fetching | `useDataFetch(() => api.feature.list(query), [deps])` |
| UI primitives | `import { Button, Table, Modal } from '../components/common'` |
| Navigation | Define `NAV_ITEMS` in `MainLayout.jsx` |

---

## Deployment

- **Dev**: push to `deployment-dev` → GitHub Actions builds Docker → ECR → EC2 blue-green
- **Prod**: push `v*` tag → same pipeline to prod ECR + EC2
- **Blue-green**: staged container on port 4000, requires 3 consecutive `/health` successes before traffic switches to port 3000
- **Container entrypoint**: `start.sh` runs `prisma migrate deploy` → `node worker.js &` → `node server.js`

**GitHub Secrets needed:**

| Environment | Secrets |
|-------------|---------|
| Dev | `AWS_ACCESS_KEY`, `AWS_SECRET_KEY`, `VPS_HOST`, `VPS_SSH_KEY`, `ENVFILES` |
| Production | `AWS_ACCESS_KEY_PROD`, `AWS_SECRET_ACCESS_KEY_PROD`, `PROD_VPS_HOST`, `PROD_VPS_SSH_KEY`, `ENVFILES` |

---

## Where to Find Things

| Question | File |
|----------|------|
| Response codes | `backend/globals/response.json` |
| Token generation | `backend/helpers/generateToken.js` |
| Rate limiters | `backend/middleware/rateLimit.js` |
| Auth flow | `backend/modules/auth/services/AuthService.js` |
| Password reset (OTP) | `backend/modules/auth/services/AuthService.js` + `backend/helpers/emailService.js` |
| Email | `backend/helpers/emailService.js` (SMTP; dev mode logs when `SMTP_HOST` unset) |
| Route registration | `backend/routes/index.js` |
| Prisma schema | `backend/prisma/schema.prisma` |
| Job queue | `backend/helpers/queue/jobQueue.js` |
| WS hub (emit/subscribe) | `backend/helpers/ws/hub.js` — `attachWsHub(server)` + `emitToChannel(channel, payload)` |
| WS client | `frontend/src/server/ws.js` (`wsClient`) + `frontend/src/hooks/useWebSocket.js` |
| Tests | backend `node --test tests/` · frontend `vitest` · CI `.github/workflows/ci.yml` |
| Frontend API client | `frontend/src/server/api.js` |
| Auth context | `frontend/src/contexts/AuthContext.jsx` |
| Common UI | `frontend/src/components/common/index.js` |
| Design templates | `frontend/src/components/designs/` (10 landing-page templates, TSX) |
| File statuses + open decisions | `SOURCE-MAPPING.md` |
| Stack deep-dive | `ARCHITECTURE.md` |

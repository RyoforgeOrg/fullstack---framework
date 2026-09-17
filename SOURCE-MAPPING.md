# Framework File Reference

Every file in this repo, what it does, and what you need to customize per product.

**Status legend**
- ✅ Production-ready — use as-is
- ⚙️ Configure — change constants / env vars only (no logic edits)
- 🔌 Wire — add your product's implementations here
- 📋 Stub — copy and implement for each domain feature

---

## Backend

### Entry Points

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `backend/server.js` | 🔌 | Express app, middleware, routes, WS hook, cron hook | Add webhook pre-routes, cron starts, WS attachments |
| `backend/worker.js` | 🔌 | PM2 fork process, Redis BLPOP consumer | Register job handlers in the `handlers` map |
| `backend/ecosystem.config.js` | ⚙️ | PM2 cluster (API) + fork (worker) config | Change `APP_NAME` constant at the top |
| `backend/start.sh` | 🔌 | Container entrypoint: migrate → worker → server | Add `node seed/*.js` after migration if needed |

### Deployment

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `backend/dockerfile` | ⚙️ | node:22-slim, prisma generate, start.sh CMD | Add Chromium deps if product needs headless Chrome/PDF |
| `backend/docker-compose.yml` | ⚙️ | Single-service compose (external DB + Redis) | Replace `APP_NAME`; update env file path |
| `backend/.dockerignore` | ✅ | Excludes node_modules, IDE files, CI config | No changes needed |
| `backend/DOCKER.md` | ✅ | Setup guide, scripts, secrets table, troubleshooting | No changes needed |
| `backend/.github/workflows/deploy.yml` | ⚙️ | DEV blue-green: push to `deployment-dev` → ECR → EC2 | Replace `APP_NAME` in the env var and remote script |
| `backend/.github/workflows/deploy-prod.yml` | ⚙️ | PROD blue-green: push `v*` tag → ECR → EC2 | Same `APP_NAME` replacements; add seed exec calls |
| `backend/prisma.config.ts` | ✅ | Prisma 7 config (schema path, migrations path, DB URL) | No changes needed |

### Config / Infrastructure

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `backend/config/dbConnect.js` | ✅ | PrismaClient via `@prisma/adapter-pg` (pg.Pool) | Driven by `DATABASE_URL` — no code changes |
| `backend/config/redisConfig.js` | ✅ | Redis client + getCache/setCache/deleteCache helpers | Driven by `REDIS_*` env vars — no code changes |
| `backend/config/s3.js` | ✅ | AWS S3Client init | Driven by `AWS_*` env vars — no code changes |
| `backend/config/cloudinary.js` | ✅ | Cloudinary v2 config | Driven by `CLOUDINARY_*` env vars — no code changes |
| `backend/.env.example` | ⚙️ | All env var slots documented | Remove unused service vars (e.g. Cloudinary if not used) |

### Data Model

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `backend/prisma/schema.prisma` | 🔌 | `User`, `RefreshToken`, `AuditLog`, `Notification` base models | Add domain models below the `── Product Models ──` marker |
| `backend/globals/response.json` | 🔌 | 14 response codes (1000–1014, 1009 retired) | Add product-specific codes if the base set doesn't cover your cases |

### Helpers

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `backend/helpers/apiResponse.js` | ✅ | `response(key, data)` builds the envelope; `send(res, key, data, status)` sends it with HTTP status; BigInt serialized to Number locally (no global mutation) | No changes needed |
| `backend/helpers/paginate.js` | ✅ | `page`/`limit`/`skip`/meta from `req.query` | No changes needed |
| `backend/helpers/auditLogger.js` | ✅ | Writes one row to `AuditLog` table | No changes needed; pass extra fields via `extra` param |
| `backend/helpers/generateToken.js` | ✅ | JWT access token + **opaque** refresh token (`randomBytes(48)` base64url — never a JWT, avoids `tokenHash` collisions), `verifyAccessToken` | Pass product-specific claims via `extraClaims` to `generateToken()` |
| `backend/helpers/queue/jobQueue.js` | ✅ | Redis BLPOP queue: enqueue, status poll, progress reporting, 3 retries, `recoverStuckJobs()` on worker start | Progress events go through the WS hub (`emitToChannel('job:<id>')`) |
| `backend/helpers/queue/jobWsServer.js` | ✅ | `/ws/jobs/:jobId` — thin job-specific shim over the shared hub | Ownership enforced: WS refused unless `job.meta.userId` matches token; snapshot sent as first event |
| `backend/helpers/ws/hub.js` | ✅ | Reusable WS emitter/receiver: `attachWsHub(server)` (generic `/ws`), `emitToChannel(channel, payload)` (Redis pub/sub relay, cluster-safe), per-channel `authorizeChannel`/`snapshotFor` hooks | Add product channels; customize auth via options |
| `backend/helpers/emailService.js` | ✅ | SMTP transport via nodemailer; dev mode prints to log when `SMTP_HOST` unset | Configure `SMTP_*` env vars for real delivery |

### Middleware

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `backend/middleware/verifyToken.js` | ✅ | Bearer JWT → populates `req.user` | Add per-request grant validation after tokenVersion check if needed |
| `backend/middleware/role.js` | ✅ | RBAC guard: `role('admin', 'superAdmin')` | No changes needed |
| `backend/middleware/accessLevel.js` | ✅ | Blocks `read_only` users on mutating routes | Pass `readOnlyRoles` array to block additional role names |
| `backend/middleware/rateLimit.js` | ✅ | `loginLimiter`, `otpSendLimiter`, `refreshLimiter`, `generalLimiter` + `createLimiter()` factory | Hybrid `HybridStore`: Redis-backed (`rate-limit-redis`, per-limiter prefixes `rl:login:`/`rl:otp:`/`rl:refresh:`/`rl:general:`) shared across PM2 cluster, in-memory sliding-window fallback if Redis drops (re-inits store on reconnect, clears memory counters on recovery). Server boot waits on `redisReady` (15s race) |
| `backend/middleware/upload.js` | ✅ | multer memoryStorage, 5 MB limit | No changes needed |

### Auth Module

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `backend/modules/auth/routes/authRoutes.js` | 🔌 | login, refresh, me, logout, profile, forgot/reset-password | Add product-specific routes (SSO, magic link, MFA) |
| `backend/modules/auth/services/AuthService.js` | ✅ | Full auth logic: lockout (5 strikes → 15-min `lockedUntil`), opaque refresh-token rotation (lookup by `tokenHash` + `revoked`/`expiredAt`; expiry lives in the DB row), /me, profile, forgot/reset-password via Redis OTP | Extend `buildUserPayload()` for product-specific user fields |

**Auth flow — done:** `forgotPassword` generates a 6-digit OTP, stores its hash in Redis (`auth:reset:otp:<email>`, 10-min TTL), emails via `emailService` (send failure logged, never surfaced). `resetPassword` caps attempts per email (5), validates hash, updates password, bumps `tokenVersion`, revokes ALL refresh tokens (kills pre-reset sessions end-to-end).

### Notifications Module

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `backend/modules/notifications/notificationCategories.js` | 🔌 | `type` → category grouping (`security`/`organization`/`product`) used for email opt-out; `security` is never opt-out-able | Add new `type`s to `TYPE_CATEGORY_MAP` as modules introduce them |
| `backend/modules/notifications/services/NotificationService.js` | ✅ | `notify({ userId, organizationId?, type, title, body, data?, channels? })` — writes the `Notification` row, pushes it live on WS channel `user:<userId>`, enqueues `queue:notification-email` when requested + not opted out. Also `listNotifications`, `markRead`, `markAllRead`, `getPreferences`, `updatePreferences` | Call `notify()` from any module to raise a notification (see doc comment for intended `OrganizationService`/`AuthService` call sites once those modules land in this worktree) |
| `backend/modules/notifications/routes/notificationRoutes.js` | ✅ | `GET /`, `PATCH /:id/read`, `POST /read-all`, `GET /preferences`, `PATCH /preferences` — user-scoped, `verifyToken` only | No changes needed |
| `backend/workers/notificationEmailJobHandler.js` | ✅ | Worker handler for `queue:notification-email` — sends via `emailService`, updates `Notification.emailDeliveredAt`/`emailDeliveryError` | Registered in `worker.js` |

### Routes & Scripts

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `backend/routes/index.js` | 🔌 | Central router — mounts auth; placeholder for product modules | Add `router.use(...)` for every new module here |
| `backend/scripts/generateModule.js` | ✅ | Scaffolds `modules/<name>/routes/` + `services/`, updates `routes/index.js` | No changes needed |
| `backend/scripts/generateModel.js` | ✅ | Appends Prisma model to `schema.prisma` | No changes needed |
| `backend/scripts/generateMigration.js` | ✅ | Runs `prisma migrate dev --name` | No changes needed |
| `backend/scripts/deployMigration.js` | ✅ | Runs `prisma migrate deploy` (CI/CD) | No changes needed |
| `backend/scripts/generatePostman.js` | ✅ | Scans `modules/`, generates Postman collection in `docs/` | No changes needed |
| `backend/scripts/createSuperAdmin.js` | ✅ | Interactive CLI to seed the first super admin | No changes needed |

### Stubs

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `backend/jobs/_stub.js` | 📋 | Cron job template (node-cron) | Copy → rename → implement |
| `backend/workers/_stub.js` | 📋 | Background job handler template | Copy → rename → implement → register in `worker.js` |

---

## Frontend

### Build & Deployment

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `frontend/dockerfile` | ✅ | Multi-stage: Vite build → Express server | No changes needed |
| `frontend/docker-compose.yml` | ⚙️ | Single frontend service on 8080:80 | Replace `APP_NAME` |
| `frontend/nginx.conf` | ✅ | Alternative: plain nginx SPA static host (no OG injection) | Use instead of `server.js` if subdomain branding isn't needed |
| `frontend/server.js` | ⚙️ | Express SPA server with per-subdomain OG meta injection | Set `APP_NAME`, `APP_DESCRIPTION`, `BRANDING_API_PATH` env vars |
| `frontend/.github/workflows/deploy.yml` | ⚙️ | DEV: env file → Docker build → ECR → EC2 | Replace `APP_NAME` |
| `frontend/.github/workflows/deploy-prod.yml` | ⚙️ | PROD: same on `v*` tag | Replace `APP_NAME` |
| `frontend/vite.config.js` | ✅ | `plugins: [react(), tailwindcss()]` | No changes needed |
| `frontend/eslint.config.js` | ✅ | ESLint 9 flat config | Add product-specific rules if needed |
| `frontend/index.html` | ⚙️ | SPA shell with `__OG_TITLE__` / `__OG_DESCRIPTION__` / `__OG_IMAGE__` placeholders | Update `<title>` default; add product favicon |
| `frontend/.env.example` | ⚙️ | `VITE_API_BASE_URL`, `VITE_APP_DOMAIN` | Fill in per environment |

### Core React

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `frontend/src/main.jsx` | ✅ | React root mount | No changes needed |
| `frontend/src/App.jsx` | 🔌 | BrowserRouter + AuthProvider + route definitions | Add all product page routes here |
| `frontend/src/index.css` | ✅ | Tailwind CSS 4 import | Add global CSS if needed |

### Auth & Context

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `frontend/src/contexts/AuthContext.jsx` | 🔌 | Global auth state, `login()`, `logout()`, `useAuth()` hook | Add role context switching or product-specific user fields if needed |

### Components

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `frontend/src/components/PrivateRoute.jsx` | ✅ | Auth guard with `allowedRoles` prop | No changes needed |
| `frontend/src/components/MainLayout.jsx` | 🔌 | Desktop sidebar shell | Define `NAV_ITEMS` array with your product's navigation |
| `frontend/src/components/MobileLayout.jsx` | 🔌 | Mobile bottom-nav shell | Define `MOBILE_NAV_ITEMS` array |
| `frontend/src/components/common/` | ✅ | 17 reusable UI primitives: Button, Input, Modal, Table, Card, Badge, Toast, Select, StatCard, SearchableSelect, PhoneInput, Calendar, Loading, ProfileModal, WelcomeBanner, Icon3D, useToast | No changes needed; extend individual components per product if needed |
| `frontend/src/components/common/NotificationBell.jsx` | ✅ | Bell + dropdown inbox; loads via `api.notifications.list`, live-pushed via `useWebSocket('user:<id>', ...)`, mark-read/mark-all-read | No changes needed; wired into `MainLayout.jsx`/`MobileLayout.jsx` headers |

### Data & API

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `frontend/src/server/api.js` | 🔌 | Single API gateway, auth headers, refresh-once recovery (HTTP 401 + envelope 1010), response unwrapping | Add product domain namespaces to the `api` object |
| `frontend/src/server/ws.js` | ✅ | Single WS client (`wsClient`) over the shared hub: auto-connect, backoff reconnect, channel subscribe/unsubscribe, typed events | No changes needed; add product channels via `subscribeChannel` |
| `frontend/src/hooks/useWebSocket.js` | ✅ | Realtime React hook: `useWebSocket(channel, handler, { enabled })` | No changes needed |
| `frontend/src/hooks/useDataFetch.js` | ✅ | Generic data-fetch hook with loading/error state | No changes needed |
| `frontend/src/utils/subdomain.js` | ✅ | Subdomain detection from hostname (multi-tenant support) | No changes needed |

### Stubs

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `frontend/src/pages/_stub.jsx` | 📋 | Page component template | Copy → rename → implement |

---

## Root Documentation

| File | Purpose |
|------|---------|
| `ARCHITECTURE.md` | Stack, folder ownership, naming conventions, module creation loop, security checklist |
| `AGENTS.md` | Agent-facing project guide: file map, patterns, where to find things |
| `.claude/CLAUDE.md` | Claude Code session context: hard rules, patterns, pitfalls, bootstrap checklist |

---

## Open Decisions

These are architectural choices the framework intentionally leaves to the product team.

| # | Decision | Recommendation |
|---|----------|---------------|
| 1 | **Rate limit store in PM2 cluster** | ✅ Done — HybridStore: Redis-backed (`rate-limit-redis`, per-limiter prefixes `rl:login:`/`rl:otp:`/`rl:refresh:`/`rl:general:`), in-memory sliding-window fallback if Redis down. |
| 2 | **Input validation library** | Currently manual inline checks in services. Add Zod at route level for schema validation if desired. |
| 3 | **Centralized error handler** | ✅ Done — global error middleware in `server.js`: JSON 404, multer errors → 400, `SERVER_ERROR` fallback. Add per-domain error mappers here. |
| 4 | **Prisma Accelerate** | Not active. Enable by calling `prisma.$extends(withAccelerate())` in `config/dbConnect.js`. |
| 5 | **Cloudinary vs S3 routing** | Both configured. Decide per asset type: S3 for docs/exports, Cloudinary for images/media. Encode in a `helpers/storage.js`. |
| 6 | **Email transport helper** | ✅ Done — `helpers/emailService.js` (SMTP via nodemailer, SES-compatible; dev-mode log). Password-reset OTP flow wired. |
| 7 | **Structured logging** | ✅ Done — pino logger + per-request IDs in `server.js`. Wire transports (CloudWatch, Datadog) if log aggregation needed. |
| 8 | **Test framework** | ✅ Done — `node:test` (backend, `npm test`) + Vitest (frontend, `npm test`). CI gates both in `.github/workflows/ci.yml`. |
| 9 | **Code formatter** | ESLint only. Add Prettier + `eslint-config-prettier` if team formatting standards are needed. |

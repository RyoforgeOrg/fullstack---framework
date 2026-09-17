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
| `backend/dockerfile` | ⚙️ | node:22-slim, `npm ci --omit=dev`, pinned `prisma generate`, non-root `appuser`, start.sh CMD | Add Chromium deps if product needs headless Chrome/PDF |
| `backend/docker-compose.yml` | ⚙️ | Single-service compose (external DB + Redis) | Replace `APP_NAME`; update env file path |
| `backend/.dockerignore` | ✅ | Excludes node_modules, IDE files, CI config, `.env*` (keeps `.env.example`); package-lock.json is NOT excluded (`npm ci` needs it) | No changes needed |
| `backend/DOCKER.md` | ✅ | Setup guide, scripts, secrets table, troubleshooting | No changes needed |
| `.github/workflows/deploy-backend-dev.yml` | ⚙️ | DEV blue-green: CI-gated (`workflow_run`) on `deployment-dev` → ECR (SHA + `dev` tags) → EC2, explicit migration step before traffic switch, `rollback_sha` input | Replace `APP_NAME` in the env var and remote script |
| `.github/workflows/deploy-backend-prod.yml` | ⚙️ | PROD blue-green: CI-gated on `v*` tags → ECR (SHA + `latest` tags) → EC2, explicit migration step before traffic switch, `rollback_sha` input | Same `APP_NAME` replacements; add seed exec calls |
| `backend/prisma.config.ts` | ✅ | Prisma 7 config (schema path, migrations path, DB URL) | No changes needed |

### Config / Infrastructure

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `backend/config/dbConnect.js` | ✅ | PrismaClient via `@prisma/adapter-pg` (pg.Pool) | Driven by `DATABASE_URL` — no code changes |
| `backend/config/redisConfig.js` | ✅ | Redis client + getCache/setCache/deleteCache helpers | Driven by `REDIS_*` env vars — no code changes |
| `backend/config/s3.js` | ✅ | AWS S3Client init | Driven by `AWS_*` env vars — no code changes |
| `backend/helpers/fileStorage.js` | ✅ | Object storage interface — `uploadObject(buffer, key, mimeType)`, `getSignedDownloadUrl(key, expirySeconds)`, `deleteObject(key)`, backed by S3 (`config/s3.js`). Functions exported individually so `node:test`'s `mock.method` can swap them for a fake in-memory store in tests without AWS credentials | The only file that should import `@aws-sdk/*` directly — route/service code goes through this |
| `backend/config/cloudinary.js` | ✅ | Cloudinary v2 config | Driven by `CLOUDINARY_*` env vars — no code changes |
| `backend/.env.example` | ⚙️ | All env var slots documented | Remove unused service vars (e.g. Cloudinary if not used) |

### Data Model

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `backend/prisma/schema.prisma` | 🔌 | `User`, `RefreshToken`, `AuditLog` base models + multi-tenancy (`Organization`, `Membership`, `Invitation`, enums `OrganizationStatus`/`MembershipRole`/`MembershipStatus`) + `File` (tenant-owned upload metadata, enum `FileStatus`) | Add domain models below the `── Product Models ──` marker. Every tenant-owned model MUST carry an indexed `organizationId` FK — see the tenancy contract comment above the `Organization` model |
| `backend/prisma/migrations/20260911120000_add_organizations_and_memberships/` | ✅ | Creates the three tenancy tables + a **partial** unique index `Invitation_org_email_pending_key` (raw SQL — Prisma cannot express `WHERE`), enforcing one pending invitation per (org, email) | Re-add the partial index by hand if `prisma migrate dev` ever emits a DROP for it |
| `backend/prisma/migrations/20260911130000_add_files/` | ✅ | Creates the `File` table (hand-written SQL, matching the org migration's pattern) + `FileStatus` enum + `organizationId`/`organizationId+status` indexes + cascade FKs to `Organization` and `User` | No changes needed |
| `backend/globals/response.json` | 🔌 | 14 response codes (1000–1014, 1009 retired) | Add product-specific codes if the base set doesn't cover your cases |

### Helpers

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `backend/helpers/apiResponse.js` | ✅ | `response(key, data)` builds the envelope; `send(res, key, data, status)` sends it with HTTP status; BigInt serialized to Number locally (no global mutation) | No changes needed |
| `backend/helpers/paginate.js` | ✅ | `page`/`limit`/`skip`/meta from `req.query` | No changes needed |
| `backend/helpers/auditLogger.js` | ✅ | Writes one row to `AuditLog` table | No changes needed; pass extra fields via `extra` param |
| `backend/helpers/generateToken.js` | ✅ | JWT access token + **opaque** refresh token (`randomBytes(48)` base64url — never a JWT, avoids `tokenHash` collisions), `verifyAccessToken` | Pass product-specific claims via `extraClaims` to `generateToken()` |
| `backend/helpers/queue/jobQueue.js` | ✅ | Redis queue: enqueue (with optional `idempotencyKey`), status poll, progress reporting, atomic BLMOVE claim + lease/heartbeat, periodic `recoverStuckJobs()` sweep (startup + every 30s), 3 total attempts | Progress events go through the WS hub (`emitToChannel('job:<id>')`); queued-but-unstarted jobs never expire, terminal states retained 24h |
| `backend/helpers/queue/jobWsServer.js` | ✅ | `/ws/jobs/:jobId` — thin job-specific shim over the shared hub | Ownership enforced: WS refused unless `job.meta.userId` matches token; snapshot sent as first event |
| `backend/helpers/ws/hub.js` | ✅ | Reusable WS emitter/receiver: `attachWsHub(server)` (generic `/ws`), `emitToChannel(channel, payload)` (Redis pub/sub relay, cluster-safe), per-channel `authorizeChannel`/`snapshotFor` hooks | Add product channels; customize auth via options |
| `backend/helpers/emailService.js` | ✅ | SMTP transport via nodemailer; dev mode prints to log when `SMTP_HOST` unset. `sendPasswordResetOtp`, `sendOrgInvitation` | Configure `SMTP_*` env vars for real delivery |
| `backend/helpers/tenantScope.js` | ✅ | `scopedWhere(req, extra)` — merges `organizationId` into any Prisma `where`, and throws if `tenantContext` did not run. The one-line, hard-to-forget way to scope a tenant-owned query | No changes needed. Read the header comment before writing ANY query against a tenant-owned table |

### Middleware

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `backend/middleware/verifyToken.js` | ✅ | Bearer JWT → populates `req.user` | Add per-request grant validation after tokenVersion check if needed |
| `backend/middleware/role.js` | ✅ | RBAC guard: `role('admin', 'superAdmin')` | No changes needed |
| `backend/middleware/accessLevel.js` | ✅ | Blocks `read_only` users on mutating routes | Pass `readOnlyRoles` array to block additional role names |
| `backend/middleware/rateLimit.js` | ✅ | `loginLimiter`, `otpSendLimiter`, `refreshLimiter`, `generalLimiter` + `createLimiter()` factory | Hybrid `HybridStore`: Redis-backed (`rate-limit-redis`, per-limiter prefixes `rl:login:`/`rl:otp:`/`rl:refresh:`/`rl:general:`) shared across PM2 cluster, in-memory sliding-window fallback if Redis drops (re-inits store on reconnect, clears memory counters on recovery). Server boot waits on `redisReady` (15s race) |
| `backend/middleware/upload.js` | ✅ | multer memoryStorage, 5 MB limit | No changes needed |
| `backend/middleware/tenantContext.js` | ✅ | Resolves the active organization per request (`:orgId` route param, else `X-Organization-Id` header; a mismatch is 400). Verifies the caller's `Membership` is `active` and the `Organization` is `active`, then sets `req.organizationId` / `req.membership` / `req.organization`. Always **403, never 404** — a non-member cannot distinguish a real org id from a fake one | Mount it after `verifyToken` on every tenant-scoped route |
| `backend/middleware/requireOrgRole.js` | ✅ | `requireOrgRole(...roles)` checks `req.membership.role`; `ORG_PERMISSIONS` is the explicit capability→roles table (owner / admin / member / viewer) | Add rows to `ORG_PERMISSIONS` as product capabilities appear. Target-row guards (no self-edit, only owners mint owners, only owners touch owners) live in `OrganizationService.updateMember` |

### Auth Module

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `backend/modules/auth/routes/authRoutes.js` | 🔌 | login, refresh, me, logout, profile, forgot/reset-password | Add product-specific routes (SSO, magic link, MFA) |
| `backend/modules/auth/services/AuthService.js` | ✅ | Full auth logic: lockout (5 strikes → 15-min `lockedUntil`), opaque refresh-token rotation (lookup by `tokenHash` + `revoked`/`expiredAt`; expiry lives in the DB row), /me, profile, forgot/reset-password via Redis OTP | Extend `buildUserPayload()` for product-specific user fields |

### Organizations Module (multi-tenancy)

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `backend/modules/organizations/routes/organizationRoutes.js` | ✅ | `POST /orgs`, `GET /orgs`, `POST /orgs/invitations/:token/accept` (user-scoped) + `POST /orgs/:orgId/invitations`, `GET /orgs/:orgId/members`, `PATCH /orgs/:orgId/members/:membershipId`, `DELETE /orgs/:orgId` (org-scoped: `tenantContext` → `requireOrgRole`). Zod-validated | Add org-scoped product routes following the same `tenantContext` + `requireOrgRole` chain |
| `backend/modules/organizations/services/OrganizationService.js` | ✅ | Org creation (creator becomes `owner`), membership listing, opaque invitation tokens (`randomBytes(48)`, stored sha256-hashed like `RefreshToken`), single-use atomic acceptance (conditional `updateMany` claim inside a transaction — the refresh-rotation pattern), soft member removal, cascade org delete | Extend `publicOrg` / `publicMember` for product fields |

**Tenancy convention:** the active organization is the `:orgId` route param for routes nested under `/orgs/:orgId`, and the `X-Organization-Id` header for tenant-scoped routes that are not nested (future files/notifications). Both may be sent but must agree. There is **no server-side "current organization"** — it is resolved per request so one user can drive different orgs in different browser tabs.

**Invitation scope:** the accepting account must already exist and its email must match the invitation's (case-insensitively). "Invite an unregistered email → signup → auto-accept" is a deliberate follow-up, not implemented.

**Org deletion:** hard delete; `Membership` and `Invitation` are `ON DELETE CASCADE`. Member *removal* is soft (`status='removed'`) so history survives and a re-invite reactivates the same row.

**Auth flow — done:** `forgotPassword` generates a 6-digit OTP, stores its hash in Redis (`auth:reset:otp:<email>`, 10-min TTL), emails via `emailService` (send failure logged, never surfaced). `resetPassword` caps attempts per email (5), validates hash, updates password, bumps `tokenVersion`, revokes ALL refresh tokens (kills pre-reset sessions end-to-end).

### Files Module (tenant-owned object storage)

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `backend/modules/files/routes/fileRoutes.js` | ✅ | Mounted at `/api/v1/orgs/:orgId/files` (`mergeParams: true`). `POST /` upload, `GET /` paginated list, `GET /:fileId` metadata, `GET /:fileId/download` short-lived signed URL, `DELETE /:fileId` soft-delete + storage cleanup. All routes: `tenantContext` → `requireOrgRole(...ORG_PERMISSIONS['org:access'])` (any active member incl. viewer — no dedicated `files:*` permission tier was added, see the file's header comment) | Add a `files:*` tier to `ORG_PERMISSIONS` if upload/download should be restricted below "any active member" |
| `backend/modules/files/services/FileService.js` | ✅ | `uploadFile` (quota check → `fileStorage.uploadObject` → `prisma.file.create`, cleans up the object if the DB insert fails), `listFiles`/`getFile`/`downloadFile` (all `scopedWhere` + `findFirst`, never `findUnique`), `deleteFile` (soft-delete row, then delete the object synchronously — storage-delete failure is logged, not surfaced as a 500). Delete permission: uploader OR owner/admin (target-row guard, mirrors `OrganizationService.updateMember`) | Quota defaults: 500 MB / 1000 files per org, overridable via `FILES_STORAGE_QUOTA_BYTES` / `FILES_STORAGE_QUOTA_FILE_COUNT` env vars. Swap for `Organization.settings.storageQuotaBytes` once that field exists |
| `backend/helpers/fileStorage.js` | ✅ | See Config/Infrastructure row above | |

**Storage key namespacing:** `orgs/<organizationId>/<fileId>/<sanitized-filename>` — defense in depth on top of the DB-level `organizationId` filter. `storageKey` is never returned to clients; only `publicFile()`'s allowlisted fields (`id`, `filename`, `mimeType`, `sizeBytes`, `status`, `uploadedByUserId`, `createdAt`, `deletedAt`) are.

**Upload allowlist:** images (jpeg/png/webp/gif), PDF, legacy + OOXML office docs (doc/docx/xls/xlsx), CSV — the subset of `middleware/upload.js`'s `ALLOWED` map that has a registered signature sniffer. Video types are sniffable too but intentionally left out of the general-purpose file service.

**Download:** never streamed through this server. `GET /:fileId/download` returns a 5-minute signed URL in the JSON envelope for the client to fetch directly (no redirect, so it never leaks into server logs/referrers).

### Routes & Scripts

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `backend/routes/index.js` | 🔌 | Central router — mounts auth + `/orgs` (behind `verifyToken`); placeholder for product modules | Add `router.use(...)` for every new module here |
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
| `frontend/dockerfile` | ✅ | Multi-stage: Vite build (VITE_* passed as build ARGs, not a copied `.env`) → Express server, non-root `node` user, listens on 8080 | No changes needed |
| `frontend/docker-compose.yml` | ⚙️ | Single frontend service on 8080:8080 (container listens on 8080, not 80) | Replace `APP_NAME` |
| `frontend/.dockerignore` | ✅ | Excludes node_modules, dist, IDE files, `.env*` (keeps `.env.example`); package-lock.json is NOT excluded (`npm ci` needs it) | No changes needed |
| `frontend/nginx.conf` | ✅ | Alternative: plain nginx SPA static host (no OG injection) | Use instead of `server.js` if subdomain branding isn't needed |
| `frontend/server.js` | ⚙️ | Express SPA server with per-subdomain OG meta injection | Set `APP_NAME`, `APP_DESCRIPTION`, `BRANDING_API_PATH` env vars |
| `.github/workflows/deploy-frontend-dev.yml` | ⚙️ | DEV: CI-gated (`workflow_run`) → Docker build (VITE_* build-args) → ECR (SHA + `dev` tags) → EC2 blue-green on 8080:8080, `rollback_sha` input | Replace `APP_NAME`; set `VITE_*` secrets |
| `.github/workflows/deploy-frontend-prod.yml` | ⚙️ | PROD: CI-gated on `v*` tags → same blue-green flow, ECR SHA + `latest` tags | Replace `APP_NAME`; set `VITE_*` secrets |
| `frontend/vite.config.js` | ✅ | `plugins: [react(), tailwindcss()]` | No changes needed |
| `frontend/eslint.config.js` | ✅ | ESLint 9 flat config | Add product-specific rules if needed |
| `frontend/index.html` | ⚙️ | SPA shell with `__OG_TITLE__` / `__OG_DESCRIPTION__` / `__OG_IMAGE__` placeholders | Update `<title>` default; add product favicon |
| `frontend/public/branding-bootstrap.js` | ✅ | Branding bootstrap script, externalized out of `index.html` so the page's CSP can use `script-src 'self'` with no `unsafe-inline` | No changes needed |
| `frontend/.env.example` | ⚙️ | `VITE_API_BASE_URL`, `VITE_WS_URL`, `VITE_APP_DOMAIN` | Fill in per environment; local `docker build` runs can pass matching `--build-arg` values |

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
| `frontend/src/contexts/OrganizationContext.jsx` | ✅ | The user's organizations + the one THIS TAB is in (`sessionStorage`, never `localStorage` — different tabs must be able to hold different orgs). `useOrganization()`, `selectOrganization()`, `createOrganization()`, `refresh()`, `hasOrgRole()`. Mounted inside `AuthProvider` in `App.jsx` | Extend with org settings once org-scoped product pages exist |
| `frontend/src/components/common/OrganizationSwitcher.jsx` | ✅ | Minimal org dropdown + inline "create organization" form; rendered in `DashboardPage` | Move into `MainLayout` / `MobileLayout` headers for your product |

### Components

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `frontend/src/components/PrivateRoute.jsx` | ✅ | Auth guard with `allowedRoles` prop | No changes needed |
| `frontend/src/components/MainLayout.jsx` | 🔌 | Desktop sidebar shell | Define `NAV_ITEMS` array with your product's navigation |
| `frontend/src/components/MobileLayout.jsx` | 🔌 | Mobile bottom-nav shell | Define `MOBILE_NAV_ITEMS` array |
| `frontend/src/components/common/` | ✅ | 17 reusable UI primitives: Button, Input, Modal, Table, Card, Badge, Toast, Select, StatCard, SearchableSelect, PhoneInput, Calendar, Loading, ProfileModal, WelcomeBanner, Icon3D, useToast | No changes needed; extend individual components per product if needed |

### Data & API

| File | Status | What it does | What to customize |
|------|--------|--------------|------------------|
| `frontend/src/server/api.js` | 🔌 | Single API gateway, auth headers, refresh-once recovery (HTTP 401 + envelope 1010), response unwrapping, `X-Organization-Id` injection (derived from the `:orgId` path param when present, else this tab's active org), `api.orgs.*` namespace | Add product domain namespaces to the `api` object |
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
| 2 | **Input validation library** | ✅ Done — Zod is wired (`middleware/validate.js`, `validateBody(schema)` → 400 + `VALIDATION_ERROR` envelope on failure) and used at route level in `modules/auth/routes/authRoutes.js`. Add `validateBody(z.object({...}))` to new routes rather than inline checks. |
| 3 | **Centralized error handler** | ✅ Done — global error middleware in `server.js`: JSON 404, multer errors → 400, `SERVER_ERROR` fallback. Add per-domain error mappers here. |
| 4 | **Prisma Accelerate** | Not active. Enable by calling `prisma.$extends(withAccelerate())` in `config/dbConnect.js`. |
| 5 | **Cloudinary vs S3 routing** | Resolved for the generic file service: S3 via `helpers/fileStorage.js` (Cloudinary is transform/CDN-focused for images specifically, not a fit for arbitrary tenant files). Cloudinary remains an unwired config slot — wire it directly for an image-specific product feature (avatars, thumbnails) if one is added later. |
| 6 | **Email transport helper** | ✅ Done — `helpers/emailService.js` (SMTP via nodemailer, SES-compatible; dev-mode log). Password-reset OTP flow wired. |
| 7 | **Structured logging** | ✅ Done — pino logger + per-request IDs in `server.js`. Wire transports (CloudWatch, Datadog) if log aggregation needed. |
| 8 | **Test framework** | ✅ Done — `node:test` (backend, `npm test`) + Vitest (frontend, `npm test`). CI gates both in `.github/workflows/ci.yml`. |
| 9 | **Code formatter** | ESLint only. Add Prettier + `eslint-config-prettier` if team formatting standards are needed. |

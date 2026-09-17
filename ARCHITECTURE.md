# Framework Architecture

AI-agent reference for building new SaaS products on this scaffold. Read this before writing any new code.

---

## Stack

| Layer      | Technology |
|------------|-----------|
| Backend runtime | Node.js + Express 5 |
| Database   | PostgreSQL + Prisma 7 (`@prisma/adapter-pg` driver adapter) |
| Cache / Queue | Redis 5 (custom BLPOP job queue, pub/sub for WS progress) |
| Auth       | JWT (jsonwebtoken) + bcrypt + refresh-token rotation |
| File storage | AWS S3 (primary) + Cloudinary (secondary) |
| Email      | SMTP via nodemailer (`SMTP_*` env — AWS SES-compatible) |
| SMS/WhatsApp | Twilio |
| Payment    | Razorpay (plugin slot — unwire if not needed) |
| Background jobs | Custom Redis queue (`helpers/queue/jobQueue.js`) + node-cron (atomic BLMOVE claim, lease/heartbeat recovery, 3 attempts) |
| Testing    | node:test (backend) · Vitest (frontend) |
| Process manager | PM2 (cluster for API, fork for worker) |
| Frontend   | React 19 + React Router 7 + Vite 7 (SWC) |
| Styling    | Tailwind CSS 4 (Vite plugin, no config file needed) |
| State      | React Context API + useState |
| Icons      | @phosphor-icons/react + react-icons |
| Charts     | recharts |

---

## Dependency Rules

```
Frontend pages
    ↓ imports from
Frontend components/hooks/contexts
    ↓ calls
src/server/api.js  (single API gateway — no fetch() calls outside this file)
    ↓ HTTP →
Backend routes/index.js
    ↓
Module routes (middleware applied here)
    ↓
Module services (business logic lives here)
    ↓
helpers/ + config/ (no business logic, no module imports)
```

**Never** import a module's service from another module's service. Cross-module communication goes through the database or a shared helper.

---

## Folder Ownership

### Backend

```
backend/
├── server.js              Entry point. Wires middleware, routes, WS servers, crons. No business logic.
├── worker.js              Background job worker. Registers handlers. No business logic.
├── ecosystem.config.js    PM2 config. Change APP_NAME constant at top.
├── config/                Infrastructure clients (DB, Redis, S3, Cloudinary). No logic.
├── middleware/            Cross-cutting middleware. No business logic.
│   ├── verifyToken.js     JWT auth. Populates req.user.
│   ├── role.js            RBAC. Usage: role('admin', 'superAdmin')
│   ├── accessLevel.js     Read-only enforcement. Usage: requireReadWrite(['management'])
│   ├── rateLimit.js       Rate limiters (Redis-backed). Pre-built: loginLimiter, otpSendLimiter, generalLimiter.
│   └── upload.js          multer memory storage. Usage: upload.single('photo')
├── helpers/               Stateless utilities used by any module.
│   ├── apiResponse.js     Response envelope. Usage: apiResponse.response('SUCCESS', data)
│   ├── auditLogger.js     DB audit log. Usage: auditLogger('ACTION', req.user, req)
│   ├── paginate.js        Prisma pagination. Usage: const { skip, take, meta } = paginate(req.query)
│   ├── generateToken.js   JWT helpers. Usage: generateToken(user), generateRefreshToken(user)
│   ├── emailService.js    SMTP transport (dev mode logs when SMTP_HOST unset). Usage: sendEmail({...})
│   ├── ws/hub.js          Reusable WS emitter/receiver. attachWsHub(server) + emitToChannel(channel, payload)
│   └── queue/jobQueue.js  Job queue. Usage: enqueueJob('queue-name', payload)
├── globals/response.json  Response code registry. Add new codes here.
├── routes/index.js        Route aggregator. Add new module mounts here.
├── modules/               Feature modules. One folder per domain.
│   └── <module>/
│       ├── routes/<module>Routes.js    Route definitions + middleware
│       └── services/<Module>Service.js Business logic
├── jobs/                  Cron job files. One file per scheduled task.
├── workers/               Background job handlers. One file per job type.
├── prisma/schema.prisma   Data model. Framework models at top; product models below the marker.
└── scripts/               Code generators. Do not modify.
```

### Frontend

```
frontend/src/
├── main.jsx               React root mount. Do not modify.
├── App.jsx                BrowserRouter + AuthProvider + route definitions.
├── components/
│   ├── PrivateRoute.jsx   Auth guard. Props: children, allowedRoles[].
│   ├── MainLayout.jsx     Desktop sidebar shell. Define NAV_ITEMS inside.
│   ├── MobileLayout.jsx   Mobile bottom-nav shell. Define MOBILE_NAV_ITEMS inside.
│   └── common/            Reusable UI primitives (Button, Input, Modal, Table, etc.)
├── contexts/
│   └── AuthContext.jsx    Global auth state. Access via useAuth().
├── hooks/
│   ├── useDataFetch.js    Generic data-fetch hook.
│   └── useWebSocket.js    Realtime hook. Usage: useWebSocket('user:123', handler)
├── server/
│   ├── api.js             Single API gateway. All fetch() calls live here.
│   └── ws.js              Single WS client (wsClient). All new WebSocket() calls live here.
├── utils/
│   └── subdomain.js       Multi-tenant subdomain detection.
└── pages/                 Feature pages. Group by domain: pages/<feature>/<Feature>Page.jsx
```

---

## Naming Conventions

### Backend

| Thing | Convention | Example |
|-------|-----------|---------|
| Module folder | camelCase | `feeManagement` |
| Route file | `<module>Routes.js` | `feeManagementRoutes.js` |
| Service file | `<Module>Service.js` | `FeeManagementService.js` |
| Service function | camelCase verb | `getFees`, `createFee`, `updateFee`, `deleteFee` |
| Job handler file | `<domain><Action>JobHandler.js` | `feeReceiptNotifyJobHandler.js` |
| Cron file | `<domain><Action>Cron.js` | `feeReminderCron.js` |
| Queue name | `<domain>:<action>` | `fee:receipt-notify` |
| API path | `/api/v1/<actor>/<resource>` | `/api/v1/admin/fees` |
| Prisma model | PascalCase | `FeePayment` |
| Prisma field | camelCase | `dueDate`, `paidAt` |
| Env var | SCREAMING_SNAKE | `JWT_SECRET`, `REDIS_HOST` |

### Frontend

| Thing | Convention | Example |
|-------|-----------|---------|
| Page file | `<Feature>Page.jsx` | `FeesPage.jsx` |
| Page folder | `pages/<feature>/` | `pages/fees/` |
| Context file | `<Feature>Context.jsx` | `SchoolContext.jsx` |
| Hook file | `use<Feature>.js` | `useClasses.js` |
| API namespace | camelCase under `api.` | `api.fees.list(query)` |
| Component | PascalCase | `FeeCard`, `PaymentModal` |
| CSS | Tailwind utilities in JSX | No `.module.css`, no inline styles |

---

## API Response Envelope

Every backend response uses this shape:

```json
{
  "responseCode": 1000,
  "responseMessage": "Operation completed successfully.",
  "responseData": {
    "result": { }
  }
}
```

Response codes live in `globals/response.json`. The frontend `api.js` client unwraps this automatically — your page components receive `responseData.result` directly (or an `ApiError` is thrown).

**HTTP status** reflects the real semantic status, not a flat 200: `helpers/apiResponse.js`'s `send(res, key, data)` maps each `response.json` key to a real code via its `HTTP_STATUS` table (200/201/202, 400/401/403/404/409/429, 500/503) and calls `res.status(status).json(...)` itself. `response(key, data)` alone only builds the envelope object — it does not touch `res`, so callers that use it directly (e.g. `apiResponse.response('SUCCESS', data)` passed to `res.json(...)`) get whatever status Express defaults to (200). Prefer `send()` for anything that isn't a plain 200.

---

## Pagination

```js
// Backend service:
const { skip, take, meta } = paginate(req.query)
const rows  = await prisma.model.findMany({ skip, take, where })
const total = await prisma.model.count({ where })
res.json(apiResponse.response('SUCCESS', { rows, pagination: meta(total) }))
```

```js
// Frontend (api.js namespace):
api.feature.list = (query) => request('GET', '/admin/feature', {}, query)

// Page component:
const { data } = useDataFetch(() => api.feature.list({ page, limit: 20 }), [page])
// data.rows, data.pagination.{ total, page, limit, totalPages, hasNext, hasPrev }
```

---

## Creating a New Module (Loop Steps 1–8)

**Step 1 — Scaffold backend:**
```bash
npm run gen:module <moduleName>
# Creates modules/<moduleName>/routes/<moduleName>Routes.js
#         modules/<moduleName>/services/<Module>Service.js
# Auto-registers in routes/index.js
```

**Step 2 — Scaffold database model:**
```bash
npm run gen:model <ModelName> field:Type field2:Type?
# Appends model to prisma/schema.prisma
npm run gen:migration add_<model_name>_table
```

**Step 3 — Wire middleware in the route file:**
```js
router.get('/',    verifyToken, role('admin'),                     list)
router.post('/',   verifyToken, role('admin'), requireReadWrite(), create)
router.put('/:id', verifyToken, role('admin'), requireReadWrite(), update)
```

**Step 4 — Implement business logic in the service file.** Follow the pattern:
```js
async function list(req, res) {
  try {
    const { skip, take, meta } = paginate(req.query)
    const where = { /* filter from req.query */ }
    const [rows, total] = await Promise.all([
      prisma.model.findMany({ skip, take, where }),
      prisma.model.count({ where }),
    ])
    return apiResponse.send(res, 'SUCCESS', { rows, pagination: meta(total) })
  } catch (error) {
    console.error('[ModuleService.list]', error)
    return apiResponse.send(res, 'SERVER_ERROR') // HTTP 500 + envelope code 1005
  }
}
```

**Step 5 — Add API namespace to `frontend/src/server/api.js`:**
```js
api.feature = {
  list:   (query)       => request('GET',    '/admin/feature',     {}, query),
  get:    ({ id })      => request('GET',    '/admin/feature/:id', { id }),
  create: (body)        => request('POST',   '/admin/feature',     {}, {}, body),
  update: ({ id, ...b}) => request('PUT',    '/admin/feature/:id', { id }, {}, b),
  delete: ({ id })      => request('DELETE', '/admin/feature/:id', { id }),
}
```

**Step 6 — Create a page** (copy `pages/_stub.jsx`):
```
src/pages/feature/FeaturePage.jsx
```

**Step 7 — Register the route** in `App.jsx`:
```jsx
import { FeaturePage } from './pages/feature/FeaturePage'
<Route path="/admin/feature" element={<FeaturePage />} />
```

---

## Creating a Background Job

1. **Copy** `workers/_stub.js` → `workers/<domain><Action>JobHandler.js`
2. **Implement** your handler function
3. **Register** in `worker.js`: add `'<queue>:<action>': handle<Feature>` to the `handlers` map
4. **Enqueue** from any service, passing `meta.userId` — `jobWsServer.js` refuses to expose a job over WS unless `job.meta.userId` matches the requesting token, so a job enqueued without it can never be tracked by the browser: `const { jobId } = await enqueueJob('<queue>:<action>', { ...payload }, { userId: req.user.id })`
5. **Optionally stream progress** to the browser — attach `attachJobWsServer(server)` in `server.js` using `helpers/queue/jobWsServer.js`

---

## Creating a Cron Job

1. **Copy** `jobs/_stub.js` → `jobs/<domain><Action>Cron.js`
2. **Implement** the schedule + logic
3. **Register** in `server.js`: import and call `start<Feature>Cron()` at the bottom

---

## Authentication Pattern

The framework implements:
- JWT access token (24h) + **opaque** refresh token (7d, single-use rotation)
  - Refresh tokens are `randomBytes(48)` values — NOT JWTs. A deterministic JWT
    refresh token produced the same `tokenHash` on every login (multi-device
    collision) and made rotation meaningless. Expiry lives in the DB row, not the token.
- Hashed refresh tokens stored in the `RefreshToken` DB table (lookup by `tokenHash` is the only validation)
- `tokenVersion` on the `User` model — increment to force-invalidate all tokens (on logout, password reset)
- Account lockout after 5 consecutive failed logins (15-minute lock)
- Soft delete (`isDeleted`) + active flag checked on every request
- Anti-enumeration: unknown-user login burns a real bcrypt compare; forgot-password
  returns the same message + delay whether or not the email exists
- Rate limits: Redis-backed (`rl:login:`/`rl:otp:`/`rl:refresh:`/`rl:general:` keys —
  distinct prefixes so limiter counters can't collide), degrading to an in-process
  sliding window if Redis drops (never hangs or 500s). Prod refuses to boot if
  Redis is unreachable within 15s.

To add product-specific JWT claims (e.g. `tenantId`), pass them as `extraClaims` to `generateToken`:
```js
generateToken(user, null, { tenantId: user.tenantId })
```

---

## Security Checklist for Every New Module

Before marking a module done, confirm:

- [ ] All routes have `verifyToken` (except intentionally public ones)
- [ ] All routes have `role(...)` matching their actor segment
- [ ] All mutating routes (POST/PUT/PATCH/DELETE) have `requireReadWrite()`
- [ ] User input is validated before use (no trusting `req.body` blindly)
- [ ] File uploads use `upload.single/array()` with the 5 MB limit
- [ ] Sensitive actions are logged with `auditLogger()`
- [ ] No secrets appear in code or logs
- [ ] Rate limiting applied to public / abuse-prone endpoints

---

## Environment Variables

All config comes from `process.env` (loaded via `dotenv`). No hardcoded values anywhere.
Copy `.env.example` → `.env` and fill in values. The `.env` file is gitignored.

Frontend env vars are prefixed `VITE_` and injected at build time via `import.meta.env`.
Copy `.env.example` → `.env` in the frontend folder.

Optional pg pool tuning for `config/dbConnect.js` (all have working defaults):
`DB_POOL_MAX` (default 10 — per-process max connections; in PM2 cluster mode,
total = `DB_POOL_MAX` × api instances), `DB_CONNECTION_TIMEOUT_MS` (default 5000),
`DB_IDLE_TIMEOUT_MS` (default 30000).

Billing (`modules/billing`) reads two Stripe vars, both **lazily, per call**, so the
app boots without them and only billing endpoints fail:
`STRIPE_SECRET_KEY` (server-side API key — `sk_test_...` outside production) and
`STRIPE_WEBHOOK_SECRET` (the signing secret of the webhook *endpoint*, different in
test and live; without it `POST /api/v1/webhooks/stripe` rejects every delivery).
The plan → Stripe price mapping deliberately lives in the **database**
(`Plan.stripePriceId`, seeded NULL), not in env: price ids are created per
environment in the Stripe dashboard, and hardcoding a test-mode id would ship it
to production. Local testing:
`stripe listen --forward-to localhost:3000/api/v1/webhooks/stripe`.

---

## Process Model

```
PM2
├── <app>-api     cluster (instances: max)  — Express server
└── <app>-worker  fork   (instances: 1)     — Redis BLPOP job processor
```

Both read from the same `.env`. The worker uses a separate Redis connection.
Change `APP_NAME` in `ecosystem.config.js` before deploying.

The Docker image runs both apps this same way, inside one container: `start.sh`
runs migrations then `exec`s `pm2-runtime start ecosystem.config.js` as PID 1
(never `npx pm2-runtime` — npx doesn't forward signals to its child). PM2
restarts a crashed worker on its own; on `docker stop`, pm2-runtime relays the
signal to both apps, each of which drains before exiting (`worker.js`'s own
25s-bounded drain via `helpers/queue/jobQueue.js`'s `stop()`, `server.js`'s
10s HTTP drain).

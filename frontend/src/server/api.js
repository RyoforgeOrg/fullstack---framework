/**
 * Central API client. All backend calls go through this file.
 *
 * Provides:
 *  - fetch wrapper with auth headers, JSON/FormData, path params, query strings
 *  - Automatic token refresh on HTTP 401 OR envelope code 1010 (TOKEN_EXPIRED) —
 *    backend replies 200 + responseCode for auth failures, so both paths are handled.
 *    Singleton refreshPromise — no duplicate refresh calls.
 *  - ApiError class with responseCode, url, payload
 *  - Response unwrapping (responseCode 1000/1012 = success; anything else throws)
 *  - In-memory access-token store + localStorage `user` cache (the refresh token
 *    itself lives ONLY in the backend's httpOnly cookie — never in JS — see F11)
 *  - A tiny pub/sub so AuthContext can react when this module invalidates a session
 *  - Namespaced `api` object — add your product's domain methods below
 *
 * To add a new domain namespace:
 *   api.myFeature = {
 *     list:   (query)        => request('GET',    '/admin/my-feature',     {}, query),
 *     get:    ({ id })       => request('GET',    '/admin/my-feature/:id', { id }),
 *     create: (body)         => request('POST',   '/admin/my-feature',     {}, {}, body),
 *     update: ({ id, ...b }) => request('PUT',    '/admin/my-feature/:id', { id }, {}, b),
 *     delete: ({ id })       => request('DELETE', '/admin/my-feature/:id', { id }),
 *   }
 */

// Single place the base URL is assembled: <origin>/api/v1<path>. VITE_API_BASE_URL
// is normally a full backend origin (see .env.example) and defaults to '' (same
// origin) — never append a second '/api' prefix here, that was the F19 bug
// ('/api' default + '/api/v1' suffix => '/api/api/v1', matching no route).
const API_ORIGIN = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/g, '')
const API_PREFIX = '/api/v1'
const buildUrl   = (path) => `${API_ORIGIN}${API_PREFIX}${path}`

const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD'])
const REQUEST_TIMEOUT_MS   = 20_000

const STORAGE_KEYS = {
  user: 'user',
}

// ── In-memory access token (F11) ────────────────────────────────────────────────
// Owned here as the single source of truth; AuthContext reads/writes it through
// these exports rather than keeping its own copy. Deliberately NOT persisted —
// lost on a hard refresh is fine, the app silently re-derives a new one from the
// httpOnly refresh cookie on load (see AuthContext).
let accessToken = null
export function getAccessToken()      { return accessToken }
export function setAccessToken(token) { accessToken = token }

// Active organization is PER-TAB (sessionStorage), never localStorage: a user who
// belongs to several orgs must be able to run org A in one tab and org B in
// another without the two overwriting each other. The backend has no sticky
// "current org" either — it resolves tenancy per request.
const ACTIVE_ORG_KEY = 'activeOrganizationId'

let refreshPromise = null

// ── Session-invalidated pub/sub ─────────────────────────────────────────────────
// Fired only when a recovery refresh fails (session was valid, then got revoked/
// expired) — never for a login request's own 401 (wrong password is expected).
// AuthContext subscribes on mount so React state stays in sync with what this
// module knows about the session (F19).
const sessionInvalidatedHandlers = new Set()
export function onSessionInvalidated(cb) {
  sessionInvalidatedHandlers.add(cb)
  return () => sessionInvalidatedHandlers.delete(cb)
}
function notifySessionInvalidated() {
  sessionInvalidatedHandlers.forEach(cb => { try { cb() } catch { /* isolated */ } })
}

// ── Storage helpers (user cache only — no tokens) ───────────────────────────────

function hasStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function hasSessionStorage() {
  return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined'
}

export function getActiveOrganizationId() {
  if (!hasSessionStorage()) return null
  return window.sessionStorage.getItem(ACTIVE_ORG_KEY)
}

export function setActiveOrganizationId(orgId) {
  if (!hasSessionStorage()) return
  if (orgId) window.sessionStorage.setItem(ACTIVE_ORG_KEY, orgId)
  else window.sessionStorage.removeItem(ACTIVE_ORG_KEY)
}

export function getStoredUser() {
  if (!hasStorage()) return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.user)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function setStoredUser(user) {
  if (!hasStorage()) return
  if (user) window.localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(user))
  else window.localStorage.removeItem(STORAGE_KEYS.user)
}

// setAuthSession / clearAuthSession are the two entry points that change session
// state; both keep the in-memory token and the user cache consistent in one place.
export function setAuthSession({ token, user }) {
  setAccessToken(token)
  if (user) setStoredUser(user)
}

export function clearAuthSession({ notify = false } = {}) {
  setAccessToken(null)
  setStoredUser(null)
  setActiveOrganizationId(null)
  if (notify) notifySessionInvalidated()
}

// ── Request internals ──────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(message, status, url, payload) {
    super(message)
    this.name    = 'ApiError'
    this.status  = status
    this.url     = url
    this.payload = payload
  }
}

export { ApiError }

function getAuthHeaders() {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
}

function isFileLike(value) {
  return typeof File !== 'undefined' && value instanceof File
}

function normalizePath(path) {
  return path.startsWith('/') ? path : `/${path}`
}

function resolvePath(path, pathParams = {}) {
  return path.replace(/:([a-zA-Z0-9_]+)/g, (_, key) => {
    const value = pathParams[key]
    if (value === undefined || value === null)
      throw new Error(`Missing path param "${key}" for path "${path}"`)
    return encodeURIComponent(String(value))
  })
}

function withQuery(path, query = {}) {
  const searchParams = new URLSearchParams()
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return
    if (Array.isArray(value)) { value.forEach(item => searchParams.append(key, String(item))); return }
    searchParams.append(key, String(value))
  })
  const qs = searchParams.toString()
  return qs ? `${path}?${qs}` : path
}

async function parseResponseBody(response) {
  if (response.status === 204) return null
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) return response.json()
  const text = await response.text()
  return text || null
}

// Backend now sends real HTTP statuses with the envelope. Pull the human
// message out of the body so callers don't just see "HTTP 403".
async function errorMessageFrom(response, fallback) {
  try {
    const body = await parseResponseBody(response)
    return body?.responseMessage || body?.responseData?.result?.message || fallback
  } catch {
    return fallback
  }
}

export function unwrapApiResult(body, fallbackMessage = 'Request failed') {
  if (!body) throw new ApiError(fallbackMessage, 0, '', body)
  const SUCCESS_CODES = new Set([1000, 1012])
  if (!SUCCESS_CODES.has(body.responseCode)) {
    throw new ApiError(
      body.responseData?.result?.message || body.responseMessage || fallbackMessage,
      body.responseCode,
      '',
      body
    )
  }
  return body.responseData?.result ?? null
}

// credentials: 'include' — the httpOnly refresh cookie travels on every request
// that might need to trigger a refresh; harmless on requests that don't.
async function attemptRefresh() {
  try {
    const response = await fetch(buildUrl('/common/auth/refresh'), {
      method:      'POST',
      headers:     { 'Content-Type': 'application/json' },
      credentials: 'include',
      body:        JSON.stringify({}),
    })
    const body = await response.json()
    if (body?.responseCode === 1000 && body?.responseData?.result?.token) {
      setAccessToken(body.responseData.result.token)
      return true
    }
    return false
  } catch {
    return false
  }
}

// Single entry point for "trade the httpOnly refresh cookie for a fresh access
// token" — used by both 401-recovery and AuthContext's mount-time bootstrap.
// Coalesced through the same refreshPromise singleton as recovery does: refresh
// rotates the cookie (one-time use), so two concurrent callers (e.g. React 19
// StrictMode double-invoking AuthProvider's effect in dev) must not each fire
// their own request — the second would replay an already-rotated token and 401.
export function refreshSession() {
  if (!refreshPromise) refreshPromise = attemptRefresh().finally(() => { refreshPromise = null })
  return refreshPromise
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new ApiError('Request timed out', 0, url, null)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function request(method, path, pathParams = {}, query = {}, body = null, opts = {}) {
  const { skipAuthRecovery = false } = opts
  const resolvedPath = resolvePath(normalizePath(path), pathParams)
  const url          = buildUrl(withQuery(resolvedPath, query))

  // Tenant context. When the path carries :orgId the header is derived from that
  // same param, so the two can never disagree (the backend rejects a mismatch
  // with 400). Otherwise fall back to this tab's active organization.
  // `orgId: null` in opts explicitly opts out (user-scoped calls).
  const orgId = 'orgId' in opts ? opts.orgId : (pathParams.orgId ?? getActiveOrganizationId())

  const hasFileUpload =
    body instanceof FormData ||
    (body && typeof body === 'object' && Object.values(body).some(isFileLike))

  let formData
  if (hasFileUpload && !(body instanceof FormData)) {
    formData = new FormData()
    Object.entries(body).forEach(([key, value]) => formData.append(key, value))
  }

  const buildHeaders = () => ({
    ...getAuthHeaders(),
    ...(orgId ? { 'X-Organization-Id': orgId } : {}),
    ...((!hasFileUpload && !METHODS_WITHOUT_BODY.has(method)) ? { 'Content-Type': 'application/json' } : {}),
  })

  const buildBody = () => {
    if (METHODS_WITHOUT_BODY.has(method) || body === null) return undefined
    if (hasFileUpload) return formData || body
    return JSON.stringify(body)
  }

  async function doFetch() {
    return fetchWithTimeout(url, { method, headers: buildHeaders(), body: buildBody(), credentials: 'include' })
  }

  let response = await doFetch()

  // ── Auth recovery: refresh ONCE per request, never in a loop ─────────────────
  // Covers both HTTP 401 and the backend's envelope-level 1010 (it replies 200 +
  // responseCode for auth failures). If the retried request still fails auth,
  // fall through and surface the error — no unbounded refresh/retry spin.
  //
  // skipAuthRecovery calls (the refresh call itself, and login) never land here
  // with a "session was valid, now revoked" story — a failed login is a normal,
  // expected 401, not a session invalidation, so it must NOT fire the
  // sessionInvalidated pub/sub. Only the recovery-clear path below does.
  let authRecovered = false
  const recover = async () => {
    if (authRecovered) return
    authRecovered = true
    const refreshed = await refreshSession()
    if (!refreshed) {
      clearAuthSession({ notify: true })
      throw new ApiError('Session expired', response.status, url, null)
    }
    response = await doFetch()
    if (!response.ok) {
      throw new ApiError(await errorMessageFrom(response, `HTTP ${response.status}`), response.status, url, null)
    }
  }

  if (response.status === 401 && !skipAuthRecovery) {
    await recover()
    return unwrapApiResult(await parseResponseBody(response))
  }

  if (!response.ok) {
    throw new ApiError(await errorMessageFrom(response, `HTTP ${response.status}`), response.status, url, null)
  }

  let responseBody = await parseResponseBody(response)

  if (!skipAuthRecovery && !authRecovered && responseBody?.responseCode === 1010 && accessToken) {
    await recover()
    responseBody = await parseResponseBody(response)
  }

  return unwrapApiResult(responseBody)
}

// ── Public API object — add your product's namespaces here ───────────────────

const api = {
  common: {
    login:   (body)  => request('POST', '/common/auth/login',   {}, {}, body, { skipAuthRecovery: true }),
    refresh: (body)  => request('POST', '/common/auth/refresh', {}, {}, body, { skipAuthRecovery: true }),
    logout:  ()      => request('POST', '/common/auth/logout'),
    me:      ()      => request('GET',  '/common/auth/me'),
    updateProfile: (body) => request('POST', '/common/auth/profile/update', {}, {}, body),
    forgotPassword: (body) => request('POST', '/common/auth/forgot-password', {}, {}, body),
    resetPassword:  (body) => request('POST', '/common/auth/reset-password',  {}, {}, body),
  },

  // Organizations / multi-tenancy. Calls that name an :orgId are tenant-scoped;
  // list/create/accept are user-scoped.
  orgs: {
    list:   ()     => request('GET',  '/orgs', {}, {}, null, { orgId: null }),
    create: (body) => request('POST', '/orgs', {}, {}, body, { orgId: null }),
    accept: ({ token }) => request('POST', '/orgs/invitations/:token/accept', { token }, {}, null, { orgId: null }),
    members: {
      list:   ({ orgId })       => request('GET',   '/orgs/:orgId/members', { orgId }),
      invite: ({ orgId, ...b }) => request('POST',  '/orgs/:orgId/invitations', { orgId }, {}, b),
      update: ({ orgId, membershipId, ...b }) =>
        request('PATCH', '/orgs/:orgId/members/:membershipId', { orgId, membershipId }, {}, b),
    },
    delete: ({ orgId }) => request('DELETE', '/orgs/:orgId', { orgId }),
  },

  // Billing / subscription. All org-scoped — :orgId in the path makes api.js
  // send the matching X-Organization-Id automatically.
  // checkout/portal return a Stripe-hosted URL the caller must redirect to
  // (window.location.href = url); they do NOT change the plan themselves — the
  // backend only grants a plan when Stripe's webhook confirms payment.
  billing: {
    get:      ({ orgId })          => request('GET',  '/orgs/:orgId/billing',          { orgId }),
    checkout: ({ orgId, planKey }) => request('POST', '/orgs/:orgId/billing/checkout', { orgId }, {}, { planKey }),
    portal:   ({ orgId })          => request('POST', '/orgs/:orgId/billing/portal',   { orgId }, {}, {}),
    invoices: ({ orgId })          => request('GET',  '/orgs/:orgId/billing/invoices', { orgId }),
  },

  // Add your product's domain namespaces below:
  // admin: {
  //   users: {
  //     list:   (query)   => request('GET',    '/admin/users',     {}, query),
  //     get:    ({ id })  => request('GET',    '/admin/users/:id', { id }),
  //     create: (body)    => request('POST',   '/admin/users',     {}, {}, body),
  //     update: ({ id, ...b }) => request('PUT', '/admin/users/:id', { id }, {}, b),
  //     delete: ({ id })  => request('DELETE', '/admin/users/:id', { id }),
  //   },
  // },
}

export default api

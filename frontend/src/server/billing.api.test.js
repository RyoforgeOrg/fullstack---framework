// Unit tests for the api.billing.* namespace — no browser, no backend.
// Verifies the wire contract the BillingPage depends on: correct method/path,
// the tenant header derived from :orgId, and that the client sends only a plan
// KEY (never a price or an amount).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import api, { setActiveOrganizationId } from './api'

describe('api.billing', () => {
  let calls

  const memoryStorage = () => {
    const map = new Map()
    return {
      getItem:    (k) => (map.has(k) ? map.get(k) : null),
      setItem:    (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    }
  }

  const respondWith = (result) => vi.fn(async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    return {
      ok:      true,
      status:  200,
      headers: { get: () => 'application/json' },
      json:    async () => ({ responseCode: 1000, responseMessage: 'ok', responseData: { result } }),
    }
  })

  beforeEach(() => {
    calls = []
    globalThis.window = { localStorage: memoryStorage(), sessionStorage: memoryStorage() }
    globalThis.fetch  = respondWith({})
    setActiveOrganizationId(null)
  })

  afterEach(() => {
    delete globalThis.window
    delete globalThis.fetch
  })

  it('GET /orgs/:orgId/billing carries the tenant header derived from the path', async () => {
    await api.billing.get({ orgId: 'org-1' })
    expect(calls[0].url).toContain('/api/v1/orgs/org-1/billing')
    expect(calls[0].method).toBe('GET')
    expect(calls[0].headers['X-Organization-Id']).toBe('org-1')
  })

  it('checkout POSTs only the plan key — never a price or an amount', async () => {
    globalThis.fetch = respondWith({ checkout: { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' } })
    const { checkout } = await api.billing.checkout({ orgId: 'org-1', planKey: 'pro' })

    expect(calls[0].url).toContain('/orgs/org-1/billing/checkout')
    expect(calls[0].method).toBe('POST')
    // The whole point of keying on planKey: money is decided server-side from
    // the Plan row, so there is nothing here a tampered client could lower.
    expect(JSON.parse(calls[0].body)).toEqual({ planKey: 'pro' })
    expect(checkout.url).toContain('checkout.stripe.com')
  })

  it('portal POSTs with no body and returns the session URL to redirect to', async () => {
    globalThis.fetch = respondWith({ portal: { id: 'bps_1', url: 'https://billing.stripe.com/p/session/bps_1' } })
    const { portal } = await api.billing.portal({ orgId: 'org-9' })

    expect(calls[0].url).toContain('/orgs/org-9/billing/portal')
    expect(calls[0].method).toBe('POST')
    expect(portal.url).toContain('billing.stripe.com')
  })

  it('invoices is a GET and stays scoped to the org in the path', async () => {
    setActiveOrganizationId('org-from-another-tab')
    globalThis.fetch = respondWith({ invoices: [] })
    await api.billing.invoices({ orgId: 'org-in-the-url' })

    expect(calls[0].url).toContain('/orgs/org-in-the-url/billing/invoices')
    expect(calls[0].method).toBe('GET')
    // The backend 400s on a header/path mismatch — the client must never create one.
    expect(calls[0].headers['X-Organization-Id']).toBe('org-in-the-url')
  })

  it('a missing orgId fails loudly rather than sending an unscoped billing request', async () => {
    // request() is async, so resolvePath's throw surfaces as a rejection.
    await expect(api.billing.get({})).rejects.toThrow(/orgId/)
    expect(calls).toHaveLength(0)
  })
})

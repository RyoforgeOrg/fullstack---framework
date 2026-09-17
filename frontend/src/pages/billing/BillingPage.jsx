/**
 * Billing page — current plan, upgrade, and manage-at-Stripe.
 *
 * Payment UI is deliberately thin: every card number, cancellation and invoice
 * download happens on Stripe's own hosted pages, reached by redirecting to a URL
 * the backend mints. This app never renders a payment form, so it never touches
 * card data and inherits Stripe's PCI scope rather than taking on its own.
 *
 * Both buttons therefore do the same thing: ask the backend for a session URL,
 * then `window.location.href = url`. A full navigation, not fetch/router — the
 * destination is a different origin.
 */
import { useCallback, useEffect, useState } from 'react'
import api from '../../server/api'
import { useOrganization } from '../../contexts/OrganizationContext'
import { Button, Card } from '../../components/common'

const currency = (cents) =>
  cents === 0 ? 'Free' : `$${(cents / 100).toFixed(2)}/mo`

// Renders a plan's feature map without the page needing to know the keys: a plan
// added in the database shows up here with no frontend change. -1 is the
// unlimited sentinel (see backend/helpers/entitlements.js).
const FEATURE_LABELS = {
  maxMembers:      'Members',
  maxFiles:        'Files',
  apiAccess:       'API access',
  prioritySupport: 'Priority support',
}

const featureValue = (value) => {
  if (value === true)  return 'Included'
  if (value === false) return '—'
  if (value === -1)    return 'Unlimited'
  return String(value)
}

const label = (key) =>
  FEATURE_LABELS[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())

const STATUS_TONE = {
  active:     'text-emerald-300',
  trialing:   'text-sky-300',
  past_due:   'text-amber-300',
  canceled:   'text-white/40',
  incomplete: 'text-amber-300',
}

export default function BillingPage() {
  const { activeOrgId, hasOrgRole } = useOrganization()
  // One state object stamped with the org it describes. Loading is DERIVED from
  // that stamp rather than set in the effect body — switching orgs must show a
  // spinner, not the previous org's plan, and a setState in an effect body
  // triggers the cascading-render lint rule (and the re-render it warns about).
  const [loaded,  setLoaded]  = useState(null) // { orgId, billing, error }
  const [error,   setError]   = useState(null) // action errors (checkout/portal)
  // Names the plan whose button is mid-request, so only that button spins.
  const [pending, setPending] = useState(null)

  const loading   = !loaded || loaded.orgId !== activeOrgId
  const canManage = hasOrgRole('owner', 'admin')

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      let billing = null
      let failure = null
      try {
        billing = activeOrgId ? await api.billing.get({ orgId: activeOrgId }) : null
      } catch (err) {
        failure = err
      }
      if (cancelled) return
      setLoaded({ orgId: activeOrgId, billing, error: failure })
    }

    load()
    return () => { cancelled = true }
  }, [activeOrgId])

  // Shared by both buttons — the only difference is which endpoint mints the URL.
  const redirectToStripe = useCallback(async (key, mint) => {
    setPending(key)
    setError(null)
    try {
      const url = await mint()
      // Full navigation: Stripe is a different origin, so react-router cannot
      // and must not handle this.
      window.location.href = url
    } catch (err) {
      setError(err)
      setPending(null)
    }
  }, [])

  const upgrade = (planKey) => redirectToStripe(planKey, async () => {
    const { checkout } = await api.billing.checkout({ orgId: activeOrgId, planKey })
    return checkout.url
  })

  const manage = () => redirectToStripe('__portal', async () => {
    const { portal } = await api.billing.portal({ orgId: activeOrgId })
    return portal.url
  })

  if (loading) return <div className="p-6 text-white/50">Loading billing…</div>

  if (!activeOrgId) {
    return (
      <div className="p-6">
        <Card title="No organization selected">
          Pick an organization to see its plan.
        </Card>
      </div>
    )
  }

  const billing = loaded.billing

  if (!billing) {
    return (
      <div className="p-6">
        <Card title="Billing unavailable">
          {loaded.error?.message || 'Could not load billing for this organization.'}
        </Card>
      </div>
    )
  }

  const { subscription, availablePlans } = billing
  const currentKey = subscription.plan.key

  return (
    <div className="min-h-full p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Billing</h1>
        <p className="text-sm text-white/50">Manage your organization&rsquo;s plan and payment details.</p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error.message}
        </div>
      )}

      <Card
        title={`Current plan — ${subscription.plan.name}`}
        action={canManage && subscription.hasPaymentAccount ? (
          <Button variant="secondary" size="sm" onClick={manage} disabled={pending === '__portal'}>
            {pending === '__portal' ? 'Opening…' : 'Manage billing'}
          </Button>
        ) : null}
      >
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <span className="text-2xl font-bold text-white">{currency(subscription.plan.priceMonthlyCents)}</span>
          <span className={`text-sm font-semibold ${STATUS_TONE[subscription.status] || 'text-white/60'}`}>
            {subscription.status.replace('_', ' ')}
          </span>
          {subscription.currentPeriodEnd && (
            <span className="text-sm text-white/50">
              Renews {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
            </span>
          )}
        </div>

        {/* `entitled` is false while past_due/canceled: the row still names the
            paid plan, but access has already dropped to the free tier. */}
        {!subscription.entitled && (
          <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            This subscription is not active, so your organization currently has free-plan limits.
            {canManage ? ' Update your payment details to restore access.' : ' Ask an owner or admin to update the payment details.'}
          </p>
        )}

        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          {Object.entries(subscription.plan.features).map(([key, value]) => (
            <div key={key}>
              <dt className="text-xs uppercase tracking-wide text-white/40">{label(key)}</dt>
              <dd className="text-sm font-semibold text-white">{featureValue(value)}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {availablePlans.map((plan) => {
          const isCurrent = plan.key === currentKey
          return (
            <Card key={plan.key} className={isCurrent ? 'border-orange-500/40' : ''}>
              <div className="flex items-baseline justify-between">
                <h3 className="text-lg font-bold text-white">{plan.name}</h3>
                <span className="text-sm font-semibold text-white/70">{currency(plan.priceMonthlyCents)}</span>
              </div>

              <ul className="mt-4 space-y-1 text-sm text-white/60">
                {Object.entries(plan.features).map(([key, value]) => (
                  <li key={key} className="flex justify-between gap-4">
                    <span>{label(key)}</span>
                    <span className="text-white/80">{featureValue(value)}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-5">
                {isCurrent ? (
                  <Button variant="outline" size="sm" disabled>Current plan</Button>
                ) : plan.priceMonthlyCents === 0 ? (
                  // Downgrading to free is a cancellation — it happens in the
                  // Stripe portal, not here, so proration and the end-of-period
                  // date stay Stripe's to decide.
                  <Button variant="outline" size="sm" disabled>
                    {canManage ? 'Cancel in billing portal' : 'Included'}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => upgrade(plan.key)}
                    disabled={!canManage || pending !== null}
                  >
                    {pending === plan.key ? 'Redirecting…' : `Upgrade to ${plan.name}`}
                  </Button>
                )}
              </div>

              {!canManage && !isCurrent && plan.priceMonthlyCents > 0 && (
                <p className="mt-2 text-xs text-white/40">Only an owner or admin can change the plan.</p>
              )}
            </Card>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Organization switcher + inline "create organization" form.
 * Minimal on purpose — it exists so the multi-tenant API is reachable from the
 * UI. Drop it into a layout header (MainLayout / MobileLayout).
 *
 * Switching only changes THIS tab's active org (sessionStorage), so the same
 * user can keep a second tab open on a different organization.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useOrganization } from '../../contexts/OrganizationContext'
import { Select } from './Select'
import Button from './Button'
import Input from './Input'

export function OrganizationSwitcher() {
  const { organizations, activeOrgId, loading, selectOrganization, createOrganization } = useOrganization()
  const [creating, setCreating] = useState(false)
  const [name, setName]         = useState('')
  const [busy, setBusy]         = useState(false)
  const [error, setError]       = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await createOrganization({ name })
      setName('')
      setCreating(false)
    } catch (err) {
      setError(err.message || 'Could not create the organization.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="text-sm text-white/50">Loading organizations…</div>

  if (creating) {
    return (
      <form onSubmit={submit} className="flex flex-col gap-2 min-w-56">
        <Input
          label="Organization name"
          name="orgName"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Inc"
          required
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={busy || name.trim().length < 2}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => { setCreating(false); setError(null) }}>
            Cancel
          </Button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex items-center gap-2 min-w-56">
      {organizations.length > 0 && (
        <Select
          name="organization"
          value={activeOrgId || ''}
          onChange={(e) => selectOrganization(e.target.value)}
          options={organizations.map(o => ({
            value: o.id,
            label: o.status === 'active' ? `${o.name} · ${o.role}` : `${o.name} (suspended)`,
          }))}
          placeholder="Select organization"
          className="flex-1"
        />
      )}
      <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
        {organizations.length ? 'New' : 'Create organization'}
      </Button>
      {activeOrgId && (
        <Link to="/organization/settings" className="text-sm text-white/50 hover:text-white whitespace-nowrap">
          Manage
        </Link>
      )}
    </div>
  )
}

// src/pages/organization/OrganizationSettingsPage.jsx
// Minimal organization admin surface: settings/branding form, member list with
// role-change/remove actions, and a simple usage + audit-log view. Functional,
// not deeply designed — reuses the existing common/ components as-is.
//
// Reachable from OrganizationSwitcher's "Manage" link (see that component).
import { useEffect, useState } from 'react'
import { useOrganization } from '../../contexts/OrganizationContext'
import api from '../../server/api'
import { Card, Badge, Table, StatCard, Select, Input, Button } from '../../components/common'

const ROLES = ['owner', 'admin', 'member', 'viewer']

// Keyed by org.id from the parent (see OrganizationSettingsPage) so switching
// organizations remounts this form with fresh initial state instead of
// syncing props into state inside an effect.
function SettingsForm({ org, canManage, onSaved }) {
  const [name, setName]                 = useState(org.name || '')
  const [logoUrl, setLogoUrl]           = useState(org.logoUrl || '')
  const [primaryColor, setPrimaryColor] = useState(org.primaryColor || '')
  const [busy, setBusy]                 = useState(false)
  const [error, setError]               = useState(null)
  const [saved, setSaved]               = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await api.orgs.update({
        orgId:        org.id,
        name,
        logoUrl:      logoUrl || null,
        primaryColor: primaryColor || null,
      })
      setSaved(true)
      onSaved?.()
    } catch (err) {
      setError(err.message || 'Could not save organization settings.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Organization settings">
      <form onSubmit={submit} className="space-y-4 max-w-lg">
        <Input
          label="Organization name"
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          disabled={!canManage}
        />
        <Input
          label="Logo URL"
          name="logoUrl"
          value={logoUrl}
          onChange={(e) => setLogoUrl(e.target.value)}
          placeholder="https://cdn.example.com/logo.png"
          disabled={!canManage}
        />
        {/* File upload lives in the file service (A07) — a client uploads there
            and pastes the resulting URL here, or points at an external host. */}
        <Input
          label="Primary color (hex)"
          name="primaryColor"
          value={primaryColor}
          onChange={(e) => setPrimaryColor(e.target.value)}
          placeholder="#4F46E5"
          disabled={!canManage}
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        {saved && !error && <p className="text-sm text-green-400">Saved.</p>}
        {canManage && (
          <Button type="submit" disabled={busy || name.trim().length < 2}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        )}
        {!canManage && (
          <p className="text-sm text-white/40">Only an owner or admin can edit organization settings.</p>
        )}
      </form>
    </Card>
  )
}

function MembersPanel({ orgId, ownMembershipId, canManage }) {
  const [members, setMembers]     = useState([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  const [busyId, setBusyId]       = useState(null)
  // Bumped after a successful role-change/remove to re-run the fetch below,
  // rather than calling setState synchronously from an imperative load().
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    api.orgs.members.list({ orgId })
      .then((result) => { if (!cancelled) { setMembers(result.members || []); setError(null) } })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load members.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [orgId, reloadKey])

  const reload = () => setReloadKey((k) => k + 1)

  const changeRole = async (membershipId, role) => {
    setBusyId(membershipId)
    try {
      await api.orgs.members.update({ orgId, membershipId, role })
      reload()
    } catch (err) {
      setError(err.message || 'Could not change role.')
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (membershipId) => {
    setBusyId(membershipId)
    try {
      await api.orgs.members.update({ orgId, membershipId, status: 'removed' })
      reload()
    } catch (err) {
      setError(err.message || 'Could not remove member.')
    } finally {
      setBusyId(null)
    }
  }

  const columns = [
    { header: 'Name', render: (m) => m.user?.name || m.user?.userName || m.userId },
    { header: 'Email', render: (m) => m.user?.email || '—' },
    {
      header: 'Role',
      render: (m) => (
        canManage && m.id !== ownMembershipId
          ? (
            <Select
              name={`role-${m.id}`}
              value={m.role}
              onChange={(e) => changeRole(m.id, e.target.value)}
              options={ROLES.map(r => ({ value: r, label: r }))}
              disabled={busyId === m.id}
            />
          )
          : <Badge variant="primary">{m.role}</Badge>
      ),
    },
    { header: 'Status', render: (m) => <Badge variant={m.status === 'active' ? 'success' : 'warning'}>{m.status}</Badge> },
    {
      header: '',
      render: (m) => (
        canManage && m.id !== ownMembershipId
          ? (
            <Button size="sm" variant="danger" disabled={busyId === m.id} onClick={() => remove(m.id)}>
              Remove
            </Button>
          )
          : null
      ),
    },
  ]

  return (
    <Card title="Members">
      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}
      {loading ? <p className="text-white/50 text-sm">Loading members…</p> : <Table columns={columns} data={members} />}
    </Card>
  )
}

function UsagePanel({ orgId }) {
  const [usage, setUsage]     = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    api.orgs.usage({ orgId })
      .then((result) => { if (!cancelled) setUsage(result.usage || []) })
      .catch(() => { if (!cancelled) setUsage([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [orgId])

  if (loading) return <Card title="Usage"><p className="text-white/50 text-sm">Loading usage…</p></Card>

  return (
    <Card title="Usage" padding={false} className="p-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        {usage.map((u) => (
          <StatCard key={u.key} title={u.key} value={u.count} />
        ))}
      </div>
    </Card>
  )
}

function AuditLogPanel({ orgId, canView }) {
  const [entries, setEntries]       = useState([])
  const [pagination, setPagination] = useState(null)
  const [page, setPage]             = useState(1)
  // Lazy initializer keeps the "not viewable" case out of the effect body
  // entirely, instead of setState-ing it away on mount.
  const [loading, setLoading]       = useState(() => canView)
  const [error, setError]           = useState(null)

  useEffect(() => {
    if (!canView) return undefined
    let cancelled = false
    api.orgs.auditLog({ orgId, page, limit: 20 })
      .then((result) => {
        if (cancelled) return
        setEntries(result.entries || [])
        setPagination(result.pagination || null)
        setError(null)
      })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load the audit log.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [orgId, page, canView])

  if (!canView) return null

  const columns = [
    { header: 'Action', accessor: 'action' },
    { header: 'By', render: (e) => e.userName || e.userId || 'system' },
    { header: 'When', render: (e) => new Date(e.createdAt).toLocaleString() },
  ]

  return (
    <Card title="Audit log">
      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}
      {loading ? <p className="text-white/50 text-sm">Loading audit log…</p> : <Table columns={columns} data={entries} />}
      {pagination && (
        <div className="flex items-center justify-between mt-4 text-sm text-white/50">
          <span>Page {pagination.page} of {pagination.totalPages || 1} · {pagination.total} events</span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={!pagination.hasPrev} onClick={() => setPage(p => p - 1)}>Prev</Button>
            <Button size="sm" variant="secondary" disabled={!pagination.hasNext} onClick={() => setPage(p => p + 1)}>Next</Button>
          </div>
        </div>
      )}
    </Card>
  )
}

export default function OrganizationSettingsPage() {
  const { activeOrganization, activeOrgId, loading, hasOrgRole, refresh } = useOrganization()
  const canManage = hasOrgRole('owner', 'admin')

  if (loading) return <div className="min-h-full p-6"><p className="text-white/50">Loading organization…</p></div>
  if (!activeOrgId || !activeOrganization) {
    return (
      <div className="min-h-full p-6">
        <Card title="No organization selected">
          Create or select an organization from the switcher first.
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-full p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">{activeOrganization.name}</h1>
        <p className="text-sm text-white/50">Organization settings · your role: {activeOrganization.role}</p>
      </div>

      <SettingsForm key={activeOrgId} org={activeOrganization} canManage={canManage} onSaved={refresh} />
      <UsagePanel orgId={activeOrgId} />
      <MembersPanel orgId={activeOrgId} ownMembershipId={activeOrganization.membershipId} canManage={canManage} />
      <AuditLogPanel orgId={activeOrgId} canView={canManage} />
    </div>
  )
}

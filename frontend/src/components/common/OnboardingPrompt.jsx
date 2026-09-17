/**
 * "What do I do first?" prompt for a brand-new account.
 *
 * Renders NOTHING once the user is verified and belongs to at least one
 * organization, so it can be dropped at the top of any authenticated page and
 * simply disappears when onboarding is done.
 *
 * The two states it covers are exactly the two dead ends a fresh signup hits:
 *   1. Email not confirmed — organization creation is blocked server-side
 *      (backend/middleware/requireVerifiedEmail.js), so offer a resend instead of
 *      letting them press "Create organization" into a 403.
 *   2. Verified, but zero organizations — the switcher would otherwise render an
 *      empty select. Offer creation, and name the invitation path, because an
 *      invited user's first action is opening their emailed link, not creating
 *      anything.
 */
import { useState } from 'react'
import api from '../../server/api'
import { useAuth } from '../../contexts/AuthContext'
import { useOrganization } from '../../contexts/OrganizationContext'
import Card from './Card'
import Button from './Button'
import Input from './Input'
import { Modal } from './Modal'

function CreateOrganizationModal({ isOpen, onClose }) {
  const { createOrganization } = useOrganization()
  const [name, setName]   = useState('')
  const [busy, setBusy]   = useState(false)
  const [error, setError] = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await createOrganization({ name })
      setName('')
      onClose()
    } catch (err) {
      setError(err.message || 'Could not create the organization.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create your organization">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-white/50">
          An organization is your workspace. You can invite teammates into it once it exists.
        </p>
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
          <Button type="submit" disabled={busy || name.trim().length < 2}>
            {busy ? 'Creating…' : 'Create organization'}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  )
}

export function OnboardingPrompt() {
  const { user, isEmailVerified } = useAuth()
  const { organizations, loading } = useOrganization()
  const [creating, setCreating] = useState(false)
  const [resent, setResent]     = useState(false)
  const [resending, setResending] = useState(false)

  // Never flash a "you have no organizations" prompt while the list is still
  // in flight — that is the broken empty state this component exists to avoid.
  if (loading) return null

  if (!isEmailVerified) {
    const resend = async () => {
      setResending(true)
      // The endpoint is deliberately anti-enumerating and always succeeds, so
      // there is no failure branch worth showing the user beyond a network error.
      try { await api.common.resendVerification({ email: user.email }) } catch { /* ignore */ }
      setResent(true)
      setResending(false)
    }

    return (
      <Card title="Confirm your email to get started">
        <p className="text-sm text-white/60">
          We sent a confirmation link to <span className="text-white">{user?.email}</span>. Open it to
          unlock creating your first organization.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <Button variant="secondary" onClick={resend} disabled={resending || resent}>
            {resent ? 'Link sent' : resending ? 'Sending…' : 'Resend the link'}
          </Button>
          {resent && <span className="text-sm text-white/40">Check your inbox.</span>}
        </div>
      </Card>
    )
  }

  if (organizations.length === 0) {
    return (
      <>
        <Card title="Create your first organization">
          <p className="text-sm text-white/60">
            You are not in an organization yet. Create one to start working — or, if a teammate
            invited you, open the invitation link they emailed you instead.
          </p>
          <div className="mt-4">
            <Button onClick={() => setCreating(true)}>Create organization</Button>
          </div>
        </Card>
        <CreateOrganizationModal isOpen={creating} onClose={() => setCreating(false)} />
      </>
    )
  }

  return null
}

// src/pages/auth/RegisterPage.jsx
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Lock, Mail, User } from 'lucide-react'
import api from '../../server/api'
import { AuthInput, AuthLabel, AuthNotice, AuthShell, MotionButton } from './AuthShell'

/**
 * Self-serve registration. Creates an UNVERIFIED account and emails a
 * confirmation link — no session is issued here, so the user signs in explicitly
 * afterwards (see backend AuthService.register).
 *
 * The backend uses the email as the login username, which is why the login form
 * asks for "you@example.com" under Username.
 */
export default function RegisterPage() {
  const [name,     setName]     = useState('')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [done,     setDone]     = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
    setSubmitting(true)
    setError('')
    try {
      await api.common.register({ name, email, password })
      setDone(true)
    } catch (err) {
      setError(err.message || 'Could not create your account.')
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <AuthNotice
        title="Check your email"
        body={`We sent a confirmation link to ${email}. Open it to finish setting up your account.`}
        footer={
          <Link to="/login" className="text-sm text-orange-300 hover:text-orange-200 transition-colors">
            Back to sign in
          </Link>
        }
      />
    )
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Start with a workspace of your own."
      error={error}
      footer={
        <span className="text-white/50">
          Already have an account?{' '}
          <Link to="/login" className="text-orange-300 hover:text-orange-200 transition-colors">
            Sign in
          </Link>
        </span>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <AuthLabel htmlFor="name">Full name</AuthLabel>
          <AuthInput
            icon={User}
            id="name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ada Lovelace"
            required
            autoComplete="name"
          />
        </div>

        <div>
          <AuthLabel htmlFor="email">Email</AuthLabel>
          <AuthInput
            icon={Mail}
            id="email"
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            autoComplete="email"
          />
        </div>

        <div>
          <AuthLabel htmlFor="password">Password</AuthLabel>
          <AuthInput
            icon={Lock}
            id="password"
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            required
            autoComplete="new-password"
          />
        </div>

        <MotionButton
          whileTap={{ scale: 0.98 }}
          type="submit"
          disabled={submitting}
          className="w-full rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 py-3 text-sm font-semibold text-white shadow-lg shadow-orange-500/25 transition-all hover:from-orange-400 hover:to-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Creating account…' : 'Create account'}
        </MotionButton>
      </form>
    </AuthShell>
  )
}

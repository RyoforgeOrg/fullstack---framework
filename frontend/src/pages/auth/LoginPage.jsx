// src/pages/auth/LoginPage.jsx
import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Eye, EyeOff, Lock, Mail } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { AuthInput, AuthLabel, AuthShell, MotionButton } from './AuthShell'

/**
 * Login page. Uses AuthContext.login() which stores the session via setAuthSession
 * (see src/server/api.js) and redirects to the role default route.
 *
 * Expected API envelope (unwrapped by api.js):
 *   { token, refreshToken, user: { id, name, email, role, accessLevel } }
 */
export default function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [userName, setUserName] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const from = location.state?.from?.pathname || null

  const roleDefault = (role) => {
    const map = { admin: '/admin/dashboard', superAdmin: '/superadmin/dashboard' }
    return map[role] || '/dashboard'
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!userName || !password) { setError('Enter username and password.'); return }
    setSubmitting(true)
    setError('')
    try {
      const result = await login(userName, password)
      navigate(from || roleDefault(result.user.role), { replace: true })
    } catch (err) {
      setError(err.message || 'Login failed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to your account to continue"
      error={error}
      footer={
        <div className="space-y-2">
          <Link to="/forgot-password" className="block text-orange-300 hover:text-orange-200 transition-colors">
            Forgot your password?
          </Link>
          <span className="block text-white/50">
            New here?{' '}
            <Link to="/register" className="text-orange-300 hover:text-orange-200 transition-colors">
              Create an account
            </Link>
          </span>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <AuthLabel htmlFor="userName">Username</AuthLabel>
          <AuthInput
            icon={Mail}
            id="userName"
            name="userName"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            placeholder="you@example.com"
            required
            autoComplete="username"
          />
        </div>

        <div>
          <AuthLabel htmlFor="password">Password</AuthLabel>
          <div className="relative">
            <AuthInput
              icon={Lock}
              id="password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              autoComplete="current-password"
              className="pr-11"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70 transition-colors"
              tabIndex={-1}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <MotionButton
          whileTap={{ scale: 0.98 }}
          type="submit"
          disabled={submitting}
          className="w-full rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 py-3 text-sm font-semibold text-white shadow-lg shadow-orange-500/25 transition-all hover:from-orange-400 hover:to-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </MotionButton>
      </form>
    </AuthShell>
  )
}

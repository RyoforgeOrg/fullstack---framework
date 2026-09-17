// src/pages/auth/VerifyEmailPage.jsx
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import api from '../../server/api'
import { AuthNotice } from './AuthShell'

/**
 * Landing page for the emailed confirmation link (/verify-email/:token).
 * Consumes the token, then sends the user on: into the app if they already have
 * a session, otherwise to sign in.
 */
export default function VerifyEmailPage() {
  const { token } = useParams()
  const navigate  = useNavigate()
  const [status, setStatus] = useState('pending')
  const [error,  setError]  = useState('')
  // The token is single-use: React 19 StrictMode double-invokes effects in dev,
  // and the second call would consume nothing and report a bogus failure.
  const consumed = useRef(false)

  useEffect(() => {
    if (consumed.current) return
    consumed.current = true

    api.common.verifyEmail({ token })
      .then(() => setStatus('ok'))
      .catch((err) => {
        setError(err.message || 'This confirmation link is invalid or has expired.')
        setStatus('failed')
      })
  }, [token])

  if (status === 'pending') {
    return <AuthNotice title="Confirming your email…" body="One moment." />
  }

  if (status === 'failed') {
    return (
      <AuthNotice
        title="Link didn't work"
        body={error}
        footer={
          <Link to="/login" className="text-sm text-orange-300 hover:text-orange-200 transition-colors">
            Back to sign in
          </Link>
        }
      />
    )
  }

  return (
    <AuthNotice
      title="Email confirmed"
      body="Your account is ready. Sign in to create your first organization."
      footer={
        <button
          type="button"
          onClick={() => navigate('/login', { replace: true })}
          className="rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-orange-500/25 transition-all hover:from-orange-400 hover:to-orange-500"
        >
          Continue to sign in
        </button>
      }
    />
  )
}

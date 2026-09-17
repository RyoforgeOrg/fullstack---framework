/**
 * Auth context — global auth state, login, logout, token management, role/access flags.
 *
 * Pattern: silent refresh (httpOnly cookie) on mount → /me validation → automatic
 * 401 recovery. The access token itself lives in memory only (owned by api.js,
 * see F11) — a hard page refresh loses it on purpose; this mount effect silently
 * re-derives a new one from the refresh cookie, so the session still persists.
 *
 * To add role context switching (e.g. impersonation, tenant switching), extend this
 * context with switchContext / clearContext following the same pattern.
 */
/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useState } from 'react'
import api, { clearAuthSession, getStoredUser, onSessionInvalidated, refreshSession, setAuthSession, setStoredUser } from '../server/api'
import { wsClient } from '../server/ws'

const AuthContext = createContext(null)

export const useAuth = () => {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export const AuthProvider = ({ children }) => {
  const [user,    setUser]    = useState(() => getStoredUser())
  const [loading, setLoading] = useState(true)

  // Bootstrap: no access token survives a reload (it's memory-only), so silently
  // trade the httpOnly refresh cookie for a fresh one before asking /me who we are.
  useEffect(() => {
    const bootstrap = async () => {
      try {
        // Dedup'd (see refreshSession in api.js) so React 19 StrictMode's double
        // effect invocation in dev doesn't fire the cookie-rotating refresh twice.
        const refreshed = await refreshSession()
        if (!refreshed) throw new Error('no session')
        const profile = await api.common.me()
        setUser(profile)
        setStoredUser(profile)
      } catch {
        clearAuthSession()
        setUser(null)
      } finally {
        setLoading(false)
      }
    }
    bootstrap()
  }, [])

  // F19/F20: api.js is the only place that knows a session got invalidated out
  // from under React (a recovery refresh failed). Sync local state — and tear
  // down any realtime connection, which would otherwise keep retrying against a
  // dead session — the moment that happens.
  useEffect(() => {
    return onSessionInvalidated(() => {
      setUser(null)
      wsClient.disconnect()
    })
  }, [])

  const login = async (userName, password) => {
    const result = await api.common.login({ userName, password })
    setAuthSession({ token: result.token, user: result.user })
    setUser(result.user)
    return result
  }

  const logout = async () => {
    try { await api.common.logout() } catch { /* ignore */ }
    clearAuthSession()
    setUser(null)
    wsClient.disconnect()
  }

  const updateProfile = async (formData) => {
    const profile = await api.common.updateProfile(formData)
    setUser(prev => ({ ...prev, ...profile }))
    return profile
  }

  // Both of these bump the user's tokenVersion server-side, which kills EVERY
  // access token — including the one this tab is holding. The backend hands back
  // a freshly minted pair for the caller (and rotates the refresh cookie), so
  // adopt it here or the very next request would 401 its way through recovery.
  const changePassword = async ({ currentPassword, newPassword }) => {
    const result = await api.common.changePassword({ currentPassword, newPassword })
    setAuthSession({ token: result.token, user: result.user })
    setUser(result.user)
    return result
  }

  const revokeAllSessions = async () => {
    const result = await api.common.sessions.revokeAll()
    setAuthSession({ token: result.token, user: result.user })
    setUser(result.user)
    return result
  }

  // The /me payload carries emailVerifiedAt; re-reading it is how the UI learns a
  // pending verification has landed without a full sign-out/sign-in cycle.
  const refreshUser = async () => {
    const profile = await api.common.me()
    setUser(profile)
    setStoredUser(profile)
    return profile
  }

  const value = {
    user,
    loading,
    login,
    logout,
    updateProfile,
    changePassword,
    revokeAllSessions,
    refreshUser,
    isAuthenticated:  !!user,
    isEmailVerified:  !!user?.emailVerifiedAt,
    hasRole:         (...roles) => roles.includes(user?.role),
    isReadOnly:      () => user?.accessLevel === 'read_only',
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

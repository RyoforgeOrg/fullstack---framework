/**
 * Notification bell + inbox dropdown.
 * Subscribes to the caller's own `user:<id>` WS channel for live pushes
 * (backend/modules/notifications/services/NotificationService.js#notify) and
 * loads recent history via api.notifications on mount/open.
 */
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useWebSocket } from '../../hooks/useWebSocket'
import api from '../../server/api'

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default function NotificationBell() {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const rootRef = useRef(null)

  // Mirrors AuthContext's validate() pattern: the fetch is declared INSIDE the
  // effect (not as a component-level function) so the react-hooks setState
  // rule can see every setState call sits behind an await, not synchronously
  // in the effect body.
  useEffect(() => {
    if (!user?.id) return
    const loadNotifications = async () => {
      try {
        const result = await api.notifications.list({ page: 1, limit: 20 })
        setNotifications(result.notifications || [])
        setUnreadCount(result.unreadCount || 0)
      } catch {
        // inbox is a convenience surface — a failed fetch just leaves it empty
      } finally {
        setLoading(false)
      }
    }
    loadNotifications()
  }, [user?.id])

  useWebSocket(user?.id ? `user:${user.id}` : null, (payload) => {
    if (payload?.event !== 'notification' || !payload.notification) return
    setNotifications((prev) => [payload.notification, ...prev].slice(0, 20))
    setUnreadCount((prev) => prev + 1)
  }, { enabled: !!user?.id })

  useEffect(() => {
    if (!open) return
    const onClickOutside = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  const markOneRead = async (id) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: n.readAt || new Date().toISOString() } : n)))
    setUnreadCount((prev) => Math.max(0, prev - 1))
    try { await api.notifications.markRead({ id }) } catch { /* optimistic — next load reconciles */ }
  }

  const markAllRead = async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, readAt: n.readAt || new Date().toISOString() })))
    setUnreadCount(0)
    try { await api.notifications.readAll() } catch { /* optimistic — next load reconciles */ }
  }

  if (!user) return null

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        className="relative p-2 rounded-lg text-white/60 hover:bg-white/10 hover:text-white transition-colors"
      >
        <span className="text-lg">🔔</span>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-orange-500 text-white text-[10px] font-bold leading-none">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto rounded-xl bg-[#14141f] border border-white/10 shadow-2xl z-50">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <span className="font-semibold text-sm text-white">Notifications</span>
            {unreadCount > 0 && (
              <button onClick={markAllRead} className="text-xs text-orange-300 hover:text-orange-200">
                Mark all read
              </button>
            )}
          </div>

          {loading && notifications.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-white/40">Loading…</div>
          )}

          {!loading && notifications.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-white/40">You're all caught up.</div>
          )}

          <ul>
            {notifications.map((n) => (
              <li
                key={n.id}
                onClick={() => !n.readAt && markOneRead(n.id)}
                className={`px-4 py-3 border-b border-white/5 last:border-b-0 cursor-pointer transition-colors ${
                  n.readAt ? 'opacity-60' : 'bg-white/[0.03] hover:bg-white/[0.06]'
                }`}
              >
                <div className="flex items-start gap-2">
                  {!n.readAt && <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" />}
                  <div className="min-w-0">
                    <p className="text-sm text-white truncate">{n.title}</p>
                    <p className="text-xs text-white/50 truncate">{n.body}</p>
                    <p className="text-[10px] text-white/30 mt-0.5">{timeAgo(n.createdAt)}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

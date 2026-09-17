/**
 * Main desktop layout shell (sidebar + outlet).
 * To use: wrap role-specific routes with <MainLayout /> and define YOUR_NAV_ITEMS below.
 */
import { useState } from 'react'
import { Outlet, useNavigate, NavLink } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import NotificationBell from './common/NotificationBell'

// Define your product's navigation items here.
// Shape: [{ label: string, path: string, icon: ReactNode, roles: string[] }]
const NAV_ITEMS = [
  { label: 'Dashboard', path: '/dashboard', icon: null, roles: ['admin', 'superAdmin'] },
]

export const MainLayout = () => {
  const { user, logout } = useAuth()
  const navigate         = useNavigate()
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const visibleItems = NAV_ITEMS.filter(
    item => !item.roles || item.roles.includes(user?.role)
  )

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[#0B0B16]">
      {/* Sidebar */}
      <aside
        className={`${sidebarOpen ? 'w-64' : 'w-16'} transition-all duration-200 bg-white/5 backdrop-blur-xl border-r border-white/10 flex flex-col`}
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          {sidebarOpen && <span className="font-bold text-lg text-white">App Name</span>}
          <button onClick={() => setSidebarOpen(o => !o)} className="p-1 rounded text-white/60 hover:bg-white/10">
            ☰
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-2 space-y-1">
          {visibleItems.map(item => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  isActive ? 'bg-orange-500/15 text-orange-300' : 'text-white/60 hover:bg-white/10'
                }`
              }
            >
              {item.icon}
              {sidebarOpen && <span>{item.label}</span>}
            </NavLink>
          ))}
        </nav>

        <div className="p-4 border-t border-white/10">
          {sidebarOpen && (
            <div className="text-xs text-white/40 mb-2 truncate">{user?.name} ({user?.role})</div>
          )}
          <button
            onClick={handleLogout}
            className="w-full text-left text-sm text-red-400 hover:text-red-300 px-2 py-1 rounded"
          >
            {sidebarOpen ? 'Sign out' : '→'}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto flex flex-col">
        <header className="flex items-center justify-end px-4 py-2 border-b border-white/10">
          <NotificationBell />
        </header>
        <div className="flex-1">
          <Outlet />
        </div>
      </main>
    </div>
  )
}

/**
 * Mobile layout shell (bottom nav + outlet).
 * Define YOUR_MOBILE_NAV_ITEMS below (keep to 4–5 items max).
 */
import { Outlet, NavLink } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import NotificationBell from './common/NotificationBell'

// Define your product's mobile nav items here (keep to 4-5 max).
// Shape: [{ label: string, path: string, icon: ReactNode, roles: string[] }]
const MOBILE_NAV_ITEMS = [
  { label: 'Home', path: '/dashboard', icon: null, roles: ['admin', 'superAdmin'] },
]

export const MobileLayout = () => {
  const { user } = useAuth()

  const visibleItems = MOBILE_NAV_ITEMS.filter(
    item => !item.roles || item.roles.includes(user?.role)
  )

  return (
    <div className="flex flex-col h-screen bg-[#0B0B16]">
      <header className="flex items-center justify-end px-4 py-2 border-b border-white/10">
        <NotificationBell />
      </header>
      <main className="flex-1 overflow-y-auto pb-16">
        <Outlet />
      </main>

      <nav className="fixed bottom-0 left-0 right-0 bg-white/5 backdrop-blur-xl border-t border-white/10 flex justify-around py-2 z-50">
        {visibleItems.map(item => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              `flex flex-col items-center gap-0.5 text-xs px-3 py-1 rounded ${
                isActive ? 'text-orange-300' : 'text-white/50'
              }`
            }
          >
            {item.icon}
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

// src/pages/dashboard/DashboardPage.jsx
// Placeholder landing page for authenticated roles. Rendered through the real
// MainLayout/MobileLayout shells (see AppShell) — replace this body with real
// widgets once the product has some.
import { useAuth } from '../../contexts/AuthContext'
import { Card, OnboardingPrompt, OrganizationSwitcher } from '../../components/common'

export default function DashboardPage() {
  const { user } = useAuth()

  return (
    <div className="min-h-full p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">
            Welcome back, {user?.name || user?.email}
          </h1>
          <p className="text-sm text-white/50">
            Role: {user?.role} · Access: {user?.accessLevel}
          </p>
        </div>
        <OrganizationSwitcher />
      </div>

      {/* Renders nothing once the account is verified and has an organization. */}
      <OnboardingPrompt />

      <Card title="No widgets configured yet">
        This dashboard has no product widgets wired up yet. Add your own via
        the route in <code>App.jsx</code> and the nav entries in{' '}
        <code>MainLayout.jsx</code> / <code>MobileLayout.jsx</code>.
      </Card>
    </div>
  )
}

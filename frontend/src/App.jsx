/**
 * Application root — router + providers.
 *
 * How to add routes:
 *   1. Import your page component.
 *   2. Add a <Route> inside the matching role block below.
 *   3. Protect it with <PrivateRoute allowedRoles={[...]}>.
 *
 * Route convention (mirrors backend):
 *   /login               — unauthenticated
 *   /public/*            — unauthenticated public pages
 *   /admin/*             — admin role
 *   /superadmin/*        — superAdmin role
 *   /<role>/*            — other roles
 *   /dashboard           — redirects to role default after login
 */
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import './App.css'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { OrganizationProvider } from './contexts/OrganizationContext'
import { PrivateRoute } from './components/PrivateRoute'
import { AppShell } from './components/AppShell'
import { lazy, Suspense } from 'react'

// ── Page imports — add yours here (lazy = code-split per route) ─────────────
const LoginPage          = lazy(() => import('./pages/auth/LoginPage'))
const RegisterPage       = lazy(() => import('./pages/auth/RegisterPage'))
const VerifyEmailPage    = lazy(() => import('./pages/auth/VerifyEmailPage'))
const ForgotPasswordPage = lazy(() => import('./pages/auth/ForgotPasswordPage'))
const ResetPasswordPage  = lazy(() => import('./pages/auth/ResetPasswordPage'))
const DashboardPage      = lazy(() => import('./pages/dashboard/DashboardPage'))
const OrganizationSettingsPage = lazy(() => import('./pages/organization/OrganizationSettingsPage'))
const DesignGallery      = lazy(() => import('./components/designs/Gallery'))
const BillingPage        = lazy(() => import('./pages/billing/BillingPage'))

// ── Role-default route helper (implement per product) ─────────────────────────
// Replace the placeholder text below with real redirects once you have routes.
function DefaultRedirect() {
  const { user, loading } = useAuth()
  if (loading) return null
  if (!user) {
    return <Navigate to="/login" replace />
  }
  // Map roles to their default landing page:
  const roleRoutes = { admin: '/admin/dashboard', superAdmin: '/superadmin/dashboard' }
  return <Navigate to={roleRoutes[user.role] || '/dashboard'} replace />
}

function AppRoutes() {
  return (
    <Suspense fallback={<div style={{ padding: 32, background: '#0B0B16', color: '#fff', minHeight: '100vh' }}>Loading…</div>}>
      <Routes>
        {/* ── Public ──────────────────────────────────────────────────────────── */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        {/* Landing page for the emailed confirmation link — unauthenticated on
            purpose: the link is opened from a mail client with no session. */}
        <Route path="/verify-email/:token" element={<VerifyEmailPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        {/* <Route path="/public/*" element={<PublicPage />} /> */}

        {/* ── Design Gallery — browse all 10 landing page templates ───────────── */}
        <Route path="/designs" element={
          <Suspense fallback={<div style={{ padding: 32, color: '#fff', background: '#0D0D16', minHeight: '100vh' }}>Loading design gallery…</div>}>
            <DesignGallery />
          </Suspense>
        } />
        <Route path="/designs/:id" element={
          <Suspense fallback={<div style={{ padding: 32, color: '#fff', background: '#000', minHeight: '100vh' }}>Loading template…</div>}>
            <DesignGallery />
          </Suspense>
        } />

      {/* ── Protected — add role-specific routes inside PrivateRoute ─────────── */}
      {/* AppShell picks MainLayout (desktop) or MobileLayout (mobile) and renders
          matched children below via its <Outlet />. */}
      <Route
        element={
          <PrivateRoute allowedRoles={['admin', 'superAdmin']}>
            <AppShell />
          </PrivateRoute>
        }
      >
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/admin/dashboard" element={<DashboardPage />} />
        <Route path="/organization/settings" element={<OrganizationSettingsPage />} />
        {/* Billing is org-scoped via the active organization, not the URL — the
            page reads activeOrgId from OrganizationContext. */}
        <Route path="/billing" element={<BillingPage />} />
      </Route>
      <Route
        element={
          <PrivateRoute allowedRoles={['superAdmin']}>
            <AppShell />
          </PrivateRoute>
        }
      >
        <Route path="/superadmin/dashboard" element={<DashboardPage />} />
      </Route>

      {/* ── Fallback ─────────────────────────────────────────────────────────── */}
      <Route path="/unauthorized" element={<div style={{ padding: 32, background: '#0B0B16', color: '#fff', minHeight: '100vh' }}>403 — You don't have access to this page.</div>} />
      <Route path="/" element={<DefaultRedirect />} />
      {/* Do NOT redirect * back to / — that creates an infinite loop when /login
          has no route yet. Render a plain 404 instead. */}
      <Route path="*" element={<div style={{ padding: 32, background: '#0B0B16', color: '#fff', minHeight: '100vh' }}>404 — Page not found</div>} />
      </Routes>
    </Suspense>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        {/* OrganizationProvider must sit INSIDE AuthProvider — it reads isAuthenticated. */}
        <OrganizationProvider>
          {/* Add other Context providers here (e.g. ThemeProvider) */}
          <AppRoutes />
        </OrganizationProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}

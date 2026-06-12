import { useEffect, useMemo, useState } from 'react'
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  ArrowRight,
  BarChart3,
  BatteryCharging,
  ClipboardList,
  Cpu,
  Home,
  KeyRound,
  LayoutGrid,
  Menu,
  MessageSquare,
  MonitorCog,
  Sparkles,
  PanelLeft,
  ShieldCheck,
  Wand2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import llmHubLogo from '../../repo-assets/LLM-HUB.svg'
import DashboardHomePage from '@/pages/DashboardHomePage'
import AnalyticsPage from '@/pages/AnalyticsPage'
import CapabilitiesPage from '@/pages/CapabilitiesPage'
import FallbackPage from '@/pages/FallbackPage'
import IntegrationsPage from '@/pages/IntegrationsPage'
import KeysPage from '@/pages/KeysPage'
import LogsPage from '@/pages/LogsPage'
import ModelStatusPage from '@/pages/ModelStatusPage'
import PlaygroundPage from '@/pages/PlaygroundPage'
import SettingsPage from '@/pages/SettingsPage'
import { AuthGate } from '@/components/auth-gate'

const queryClient = new QueryClient()

type NavItem = {
  to: string
  icon: typeof Home
  label: string
  description: string
}

const NAV_ITEMS: NavItem[] = [
  {
    to: '/home',
    icon: Home,
    label: 'Dashboard',
    description: 'Overview and quick system health',
  },
  {
    to: '/playground',
    icon: MessageSquare,
    label: 'Playground',
    description: 'Chat, vision, speech, and more',
  },
  {
    to: '/keys',
    icon: KeyRound,
    label: 'Keys',
    description: 'Provider credentials and rotation',
  },
  {
    to: '/model-status',
    icon: BatteryCharging,
    label: 'Model Status',
    description: 'Free-tier availability and throttling',
  },
  {
    to: '/fallback',
    icon: Cpu,
    label: 'Fallback Chain',
    description: 'Prioritized routing controls',
  },
  {
    to: '/capabilities',
    icon: LayoutGrid,
    label: 'Capabilities',
    description: 'Provider support by feature',
  },
  {
    to: '/integrations',
    icon: Wand2,
    label: 'Integrations',
    description: 'SDK and HTTP usage snippets',
  },
  {
    to: '/logs',
    icon: ClipboardList,
    label: 'Logs',
    description: 'Request diagnostics and events',
  },
  {
    to: '/analytics',
    icon: BarChart3,
    label: 'Analytics',
    description: 'Traffic, latency, and usage trends',
  },
  {
    to: '/settings',
    icon: MonitorCog,
    label: 'Settings',
    description: 'Security and knowledge settings',
  },
]

const NAV_GROUPS = [
  {
    label: 'Operate',
    items: NAV_ITEMS.filter(item => ['/home', '/playground', '/fallback'].includes(item.to)),
  },
  {
    label: 'Inventory',
    items: NAV_ITEMS.filter(item => ['/keys', '/model-status', '/capabilities'].includes(item.to)),
  },
  {
    label: 'Observe',
    items: NAV_ITEMS.filter(item => ['/logs', '/analytics', '/integrations', '/settings'].includes(item.to)),
  },
]

function pageTitle(pathname: string) {
  const item = NAV_ITEMS.find(item => pathname === item.to || pathname.startsWith(`${item.to}/`))
  return item?.label ?? 'LLM Hub'
}

function Brand() {
  return (
    <div className="flex w-full min-w-0 items-center">
      <img
        src={llmHubLogo}
        alt="LLM Hub"
        className="h-20 min-w-0 w-full max-w-[15rem] shrink-0 object-contain object-left"
      />
    </div>
  )
}

function SidebarItem({
  item,
  onNavigate,
}: {
  item: NavItem
  onNavigate: () => void
}) {
  const Icon = item.icon
  return (
    <li>
      <NavLink
        to={item.to}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            'group relative flex w-full min-w-0 items-center gap-3 rounded-xl border p-2.5 text-left transition-all',
            isActive
              ? 'border-primary/45 bg-primary/12 text-foreground'
              : 'border-transparent bg-transparent text-muted-foreground hover:border-border hover:bg-muted/45 hover:text-foreground',
          )
        }
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background/55 text-primary transition-colors group-hover:border-primary/45">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{item.label}</span>
          <span className="block text-[11px] text-muted-foreground/80 truncate">{item.description}</span>
        </span>
        <ArrowRight className="size-3.5 opacity-45 transition-transform group-hover:translate-x-1" />
      </NavLink>
    </li>
  )
}

function DarkModeToggle() {
  const [dark, setDark] = useState(() => {
    if (typeof window === 'undefined') return false
    const stored = localStorage.getItem('theme')
    return stored === 'dark' || (!stored && window.matchMedia('(prefers-color-scheme: dark)').matches)
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  function toggle() {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('theme', next ? 'dark' : 'light')
  }

  return (
    <Button variant="ghost" size="sm" onClick={toggle} aria-label="Toggle theme">
      {dark ? (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" /></svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg>
      )}
    </Button>
  )
}

function AppShell() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const location = useLocation()
  const activeLabel = useMemo(() => pageTitle(location.pathname), [location.pathname])
  const navigate = useNavigate()

  return (
    <div className="relative flex min-h-dvh bg-background">
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/50 transition-opacity md:hidden',
          mobileMenuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
        onClick={() => setMobileMenuOpen(false)}
      />

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-72 min-h-0 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 py-4 shadow-2xl shadow-black/30 transition-transform md:static md:translate-x-0 md:shadow-none',
          'overflow-x-hidden',
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="mb-4 flex items-center justify-between border-b border-sidebar-border pb-3">
            <Brand />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setMobileMenuOpen(false)}
              className="md:hidden"
              aria-label="Close sidebar"
            >
              <X className="size-4" />
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            <div className="min-h-0 w-full space-y-4 overflow-y-auto overflow-x-hidden pr-1 text-sm">
              {NAV_GROUPS.map(group => (
                <nav key={group.label} aria-label={group.label}>
                  <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    {group.label}
                  </p>
                  <ul className="grid gap-1">
                    {group.items.map(item => (
                      <SidebarItem
                        key={item.to}
                        item={item}
                        onNavigate={() => setMobileMenuOpen(false)}
                      />
                    ))}
                  </ul>
                </nav>
              ))}
            </div>
          </div>

          <div className="shrink-0 space-y-2 border-t border-sidebar-border pt-3">
            <Link
              to="/health"
              className="group/security-note flex items-center gap-2 rounded-md border border-border bg-background/35 px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/8"
              onClick={() => setMobileMenuOpen(false)}
            >
              <ShieldCheck className="size-4" />
              Security note
            </Link>
            <div className="rounded-md border border-border bg-background/35 px-3 py-2 text-[11px] text-muted-foreground">
              <p className="font-semibold text-foreground">Session tuned for proxy operations</p>
              <p className="mt-1">Live telemetry, fallback tuning, and provider key control in one place.</p>
            </div>
          </div>
        </div>
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-border bg-background/92 backdrop-blur">
        <div className="flex h-14 w-full items-center gap-3 px-3 sm:px-4 lg:px-6">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setMobileMenuOpen(true)}
              className="md:hidden"
              aria-label="Open sidebar"
            >
              <Menu className="size-4" />
            </Button>
            <div className="flex items-center gap-2">
              <PanelLeft className="size-4 text-muted-foreground" />
              <h1 className="text-sm font-medium text-foreground">{activeLabel}</h1>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigate('/playground')}
                className="gap-1.5"
              >
                <Sparkles className="size-3.5" />
                Quick Run
              </Button>
              <DarkModeToggle />
            </div>
          </div>
        </header>

        <main className="relative flex min-w-0 flex-1 px-3 py-5 sm:px-4 lg:px-6 xl:px-7">
          <div className="w-full min-w-0 max-w-[1720px]">
            <Routes>
              <Route path="/" element={<Navigate to="/home" replace />} />
              <Route path="/home" element={<DashboardHomePage />} />
              <Route path="/playground" element={<PlaygroundPage />} />
              <Route path="/integrations" element={<IntegrationsPage />} />
              <Route path="/keys" element={<KeysPage />} />
              <Route path="/model-status" element={<ModelStatusPage />} />
              <Route path="/fallback" element={<FallbackPage />} />
              <Route path="/capabilities" element={<CapabilitiesPage />} />
              <Route path="/logs" element={<LogsPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/test" element={<Navigate to="/playground" replace />} />
              <Route path="/health" element={<Navigate to="/keys" replace />} />
            </Routes>
          </div>
        </main>
      </div>
    </div>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <AuthGate>
          <AppShell />
        </AuthGate>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App

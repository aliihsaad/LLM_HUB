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
  Terminal,
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
import CliPage from '@/pages/CliPage'
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
  {
    to: '/cli',
    icon: Terminal,
    label: 'CLI',
    description: 'Installation and terminal commands',
  },
]

function pageTitle(pathname: string) {
  const item = NAV_ITEMS.find(item => pathname === item.to || pathname.startsWith(`${item.to}/`))
  return item?.label ?? 'LLM-Hub Pro Max'
}

function Brand() {
  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      <img
        src={llmHubLogo}
        alt=""
        className="h-20 min-w-0 w-full max-w-[10.75rem] shrink-0 object-contain"
        aria-hidden="true"
      />
      <span
        className="ml-2 inline-flex h-5 min-w-fit shrink-0 items-center rounded-full border border-primary/40 bg-gradient-to-br from-primary/95 to-primary/65 px-2.5 py-0.5 text-[8px] font-semibold tracking-[0.24em] text-primary-foreground shadow-[0_10px_20px_rgba(59,130,246,0.25)] whitespace-nowrap"
      >
        PRO MAX
      </span>
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
              ? 'border-primary/35 bg-gradient-to-r from-primary/22 to-transparent text-foreground shadow-sm shadow-primary/20'
            : 'border-border/60 bg-card/40 text-muted-foreground hover:border-primary/35 hover:bg-muted/60 hover:text-foreground',
          )
        }
      >
        <span className="size-9 shrink-0 rounded-lg border border-primary/25 bg-background/70 text-primary flex items-center justify-center transition-colors group-hover:border-primary/45 group-hover:bg-primary/10">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{item.label}</span>
          <span className="block text-[11px] text-muted-foreground/80 truncate">{item.description}</span>
        </span>
        <ArrowRight className="size-3.5 opacity-45 transition-transform group-hover:translate-x-1" />
        <span className="pointer-events-none absolute inset-x-2 bottom-0 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
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
    <div className="relative flex min-h-screen bg-background">
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(circle_at_top,_var(--primary)/18,_transparent_42%),radial-gradient(circle_at_right_bottom,_var(--sky-500,theme(colors.sky.500))/12,_transparent_38%)] opacity-85" />

      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/50 transition-opacity md:hidden',
          mobileMenuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
        onClick={() => setMobileMenuOpen(false)}
      />

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-72 min-h-0 shrink-0 flex-col border-r border-white/10 bg-gradient-to-b from-primary/18 via-primary/8 to-sidebar px-4 py-5 shadow-xl shadow-slate-950/6 transition-transform md:static md:translate-x-0 md:border-t md:border-l-0 md:border-b-0 dark:border-sidebar-border/80 dark:from-sky-500/12 dark:via-sky-500/5 dark:to-sidebar',
          'overflow-x-hidden',
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="mb-4 flex items-center justify-between border-b border-white/10 pb-3">
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

          <p className="mb-3 text-xs uppercase tracking-[0.18em] text-muted-foreground">Navigation</p>
          <div className="min-h-0 flex-1 overflow-hidden">
            <ul className="min-h-0 w-full grid gap-2 overflow-y-auto overflow-x-hidden pr-1 text-sm">
              {NAV_ITEMS.map(item => (
                <SidebarItem
                  key={item.to}
                  item={item}
                  onNavigate={() => setMobileMenuOpen(false)}
                />
              ))}
            </ul>
          </div>

          <div className="shrink-0 pt-4 space-y-2">
            <Link
              to="/health"
              className="group/security-note mb-3 flex items-center gap-2 rounded-lg border border-dashed border-primary/20 bg-primary/5 px-3 py-2.5 text-xs text-muted-foreground transition-colors hover:bg-primary/10"
              onClick={() => setMobileMenuOpen(false)}
            >
              <ShieldCheck className="size-4" />
              Security note
            </Link>
            <div className="rounded-xl border border-border/70 bg-card/70 px-3 py-2 text-[11px] text-muted-foreground">
              <p className="font-semibold text-foreground">Session tuned for proxy operations</p>
              <p className="mt-1">Live telemetry, fallback tuning, and provider key control in one place.</p>
            </div>
          </div>
        </div>
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
        <div className="flex w-full items-center gap-3 px-2 py-3 sm:px-3 md:px-4 lg:px-5">
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

        <main className="relative flex min-w-0 flex-1 px-2 py-6 sm:px-3 md:px-4 lg:px-5 xl:px-6">
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
            <Route path="/cli" element={<CliPage />} />
            <Route path="/test" element={<Navigate to="/playground" replace />} />
            <Route path="/health" element={<Navigate to="/keys" replace />} />
          </Routes>
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

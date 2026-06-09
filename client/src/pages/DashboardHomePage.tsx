import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, Brain, KeyRound, Route, Sparkles } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/page-header'
import { apiFetch } from '@/lib/api'
import type { AnalyticsSummary, CapabilitiesResponse } from '../../../shared/types'

interface DashboardFallbackModel {
  modelDbId: number
  priority: number
  platform: string
  displayName: string
  enabled: boolean
  keyCount: number
  runtimeStatus?: 'healthy' | 'degraded' | 'unavailable'
}

interface ModelAvailability {
  id: number
  platform: string
  modelId: string
  displayName: string
  enabled: boolean
  availabilityStatus: string
  freeTierConfirmed: boolean
}

interface HomeAvailabilityResponse {
  models: ModelAvailability[]
}

const quickLinks = [
  { to: '/playground', title: 'Open playground', description: 'Run routing tests and API calls.', icon: Sparkles },
  { to: '/fallback', title: 'Tune fallback chain', description: 'Reorder and reconfigure routes.', icon: Route },
  { to: '/keys', title: 'Add keys', description: 'Enable providers and rotate tokens.', icon: KeyRound },
  { to: '/analytics', title: 'Open analytics', description: 'Inspect throughput and latency.', icon: ArrowRight },
]

function StatCard({ label, value, tone }: { label: string; value: string | number; tone?: 'success' | 'warn' | 'default' }) {
  const toneClass = {
    default: 'text-muted-foreground/85',
    success: 'text-emerald-600 dark:text-emerald-300',
    warn: 'text-amber-600 dark:text-amber-300',
  }[tone ?? 'default']

  return (
    <Card size="sm">
      <CardContent>
        <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
        <p className={`mt-2 text-xl font-semibold leading-none ${toneClass}`}>{value}</p>
      </CardContent>
    </Card>
  )
}

export default function DashboardHomePage() {
  const { data: summary } = useQuery<AnalyticsSummary>({
    queryKey: ['analytics', 'summary', '24h'],
    queryFn: () => apiFetch('/api/analytics/summary?range=24h'),
  })

  const { data: capabilityData } = useQuery<CapabilitiesResponse>({
    queryKey: ['models', 'capabilities'],
    queryFn: () => apiFetch('/api/models/capabilities'),
  })

  const { data: fallbackData = [] } = useQuery<DashboardFallbackModel[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const { data: availabilityData } = useQuery<HomeAvailabilityResponse>({
    queryKey: ['model-availability'],
    queryFn: () => apiFetch('/api/model-availability'),
  })

  const providers = capabilityData?.providers ?? []
  const capabilities = capabilityData?.capabilities ?? (['chat', 'embeddings', 'vision', 'images', 'audio'] as const)

  const overview = (() => {
    const keyCount = providers.reduce((acc, provider) => acc + provider.keyCount, 0)
    const readyCapabilities = capabilities.filter(capability =>
      providers.some(provider => provider.capabilities[capability]?.configured),
    ).length
    const enabledModels = fallbackData.filter(entry => entry.keyCount > 0).length
    const healthyModels = fallbackData.filter(
      entry => entry.keyCount > 0 && entry.enabled && (entry.runtimeStatus === 'healthy' || !entry.runtimeStatus),
    ).length
    const unhealthyModels = fallbackData.filter(
      entry => entry.keyCount > 0 && (entry.runtimeStatus === 'degraded' || entry.runtimeStatus === 'unavailable'),
    ).length
    return {
      keyCount,
      readyCapabilities,
      enabledModels,
      healthyModels,
      unhealthyModels,
    }
  })()

  const modelCounts = (() => {
    const models = availabilityData?.models ?? []
    const grouped = models.reduce<Record<string, number>>((acc, model) => {
      acc[model.availabilityStatus] = (acc[model.availabilityStatus] ?? 0) + 1
      return acc
    }, {})
    return grouped
  })()

  const freeRatio = summary ? `${summary.successRate}%` : 'N/A'

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" description="A single control surface for system health, routing, and model availability." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="24h requests"
          value={summary?.totalRequests ? summary.totalRequests.toLocaleString() : 'Loading…'}
          tone="default"
        />
        <StatCard
          label="Success rate"
          value={freeRatio}
          tone="success"
        />
        <StatCard
          label="Total keys"
          value={overview.keyCount}
          tone="default"
        />
        <StatCard
          label="Configured capabilities"
          value={`${overview.readyCapabilities}/${capabilities.length}`}
          tone="warn"
        />
      </div>

      <section className="grid gap-6 xl:grid-cols-[1fr_0.85fr]">
        <Card className="shadow-sm ring-1 ring-foreground/5">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Brain className="size-4 text-sky-500" /> AI routing status
                </CardTitle>
                <CardDescription>Model availability and routing health in the last refresh.</CardDescription>
              </div>
              <Badge variant={overview.unhealthyModels > 0 ? 'destructive' : 'outline'}>
                {overview.unhealthyModels > 0 ? `${overview.unhealthyModels} unhealthy` : 'all healthy'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-border/60 bg-background/70 p-3">
                <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Active models</p>
                <p className="mt-1 text-lg font-semibold">
                  {overview.enabledModels}
                  {overview.healthyModels ? ` / ${overview.healthyModels} healthy` : ''}
                </p>
              </div>
              <div className="rounded-xl border border-border/60 bg-background/70 p-3">
                <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Providers</p>
                <p className="mt-1 text-lg font-semibold">{providers.length}</p>
              </div>
            </div>
            <div className="grid gap-2">
              <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Model availability</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <p className="rounded-md border border-border/60 bg-background/70 px-3 py-2">
                  <span className="font-medium">Free:</span> {modelCounts.free ?? 0}
                </p>
                <p className="rounded-md border border-border/60 bg-background/70 px-3 py-2">
                  <span className="font-medium">Rate limited:</span> {modelCounts.rate_limited ?? 0}
                </p>
                <p className="rounded-md border border-border/60 bg-background/70 px-3 py-2">
                  <span className="font-medium">Deprecated:</span> {modelCounts.deprecated ?? 0}
                </p>
                <p className="rounded-md border border-border/60 bg-background/70 px-3 py-2">
                  <span className="font-medium">Error:</span> {modelCounts.error ?? modelCounts.unknown ?? 0}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm ring-1 ring-foreground/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-500" /> Quick actions
            </CardTitle>
            <CardDescription>Jump directly to common management flows.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {quickLinks.map(link => {
              const Icon = link.icon
              return (
                <Link
                  key={link.to}
                  to={link.to}
                  className="group flex items-center gap-3 rounded-xl border border-border/65 bg-background/70 p-3 transition-all hover:border-primary/30 hover:bg-muted/50"
                >
                  <span className="size-8 rounded-md bg-sky-500/10 border border-sky-500/20 text-sky-600 dark:text-sky-300 flex items-center justify-center">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-sm font-medium">{link.title}</span>
                    <span className="text-xs text-muted-foreground block truncate">{link.description}</span>
                  </span>
                  <Button size="icon-xs" variant="ghost" className="opacity-70 group-hover:opacity-100" aria-label={link.title}>
                    <ArrowRight className="size-3.5" />
                  </Button>
                </Link>
              )
            })}
          </CardContent>
        </Card>
      </section>

      <Card className="shadow-sm ring-1 ring-foreground/5">
        <CardHeader>
          <CardTitle>Capabilities at a glance</CardTitle>
          <CardDescription>
            Capability support across configured providers.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {capabilities.map(capability => {
            const configured = providers.reduce((count, provider) => {
              const bucket = provider.capabilities[capability]
              return count + (bucket?.configured ? bucket.supportedModels : 0)
            }, 0)
            const supported = providers.reduce((count, provider) => count + (provider.capabilities[capability]?.supportedModels ?? 0), 0)
            const status = supported === 0 ? 'unsupported' : configured > 0 ? 'configured' : 'missing'
            return (
              <div key={capability} className="rounded-xl border border-border/60 bg-background/80 p-3">
                <p className="text-sm font-medium capitalize">{capability}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {status === 'configured' ? `${configured} routable` : `${supported} supported`}
                </p>
              </div>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}

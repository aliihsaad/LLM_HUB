import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, KeyRound, Route, Sparkles } from 'lucide-react'
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
    success: 'text-emerald-300',
    warn: 'text-amber-300',
  }[tone ?? 'default']

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <p className={`mt-2 text-2xl font-semibold leading-none tabular-nums ${toneClass}`}>{value}</p>
    </div>
  )
}

function PipelineStage({
  label,
  value,
  detail,
  tone = 'default',
}: {
  label: string
  value: string
  detail: string
  tone?: 'default' | 'success' | 'warn'
}) {
  const dotClass = {
    default: 'bg-slate-400',
    success: 'bg-emerald-400',
    warn: 'bg-amber-400',
  }[tone]

  return (
    <div className="relative min-w-0 rounded-md border border-border bg-background/45 px-4 py-3">
      <div className="mb-3 flex items-center gap-2">
        <span className={`size-2 rounded-full ${dotClass}`} />
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      </div>
      <p className="truncate text-lg font-semibold tabular-nums text-foreground">{value}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</p>
    </div>
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
  const capabilities = capabilityData?.capabilities ?? (['chat', 'embeddings', 'vision', 'video', 'images', 'audio'] as const)

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
    <div className="w-full space-y-5">
      <PageHeader
        title="Dashboard"
        description="Live routing control, provider readiness, and model availability for the unified API."
        actions={
          <>
            <Link
              to="/logs"
              className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-background/60 px-3 text-[0.8rem] font-medium text-foreground transition-colors hover:border-primary/45 hover:bg-muted/70"
            >
              View logs
            </Link>
            <Link
              to="/playground"
              className="inline-flex h-8 items-center justify-center rounded-md border border-primary/80 bg-primary px-3 text-[0.8rem] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Quick run
            </Link>
          </>
        }
      />

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Route className="size-4 text-primary" /> Route pipeline
                </CardTitle>
                <CardDescription>The current path a request takes from unified API to a working model.</CardDescription>
              </div>
              <Badge variant={overview.unhealthyModels > 0 ? 'destructive' : 'outline'}>
                {overview.unhealthyModels > 0 ? `${overview.unhealthyModels} unhealthy` : 'nominal'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 lg:grid-cols-3">
              <PipelineStage
                label="Ingress"
                value="/v1 + /gemini"
                detail={`${summary?.totalRequests?.toLocaleString() ?? '0'} requests in the selected 24h window.`}
                tone="default"
              />
              <PipelineStage
                label="Fallback"
                value={`${overview.enabledModels} models`}
                detail={`${overview.healthyModels} healthy routes with automatic cooldown handling.`}
                tone={overview.unhealthyModels > 0 ? 'warn' : 'success'}
              />
              <PipelineStage
                label="Providers"
                value={`${providers.length} online`}
                detail={`${overview.keyCount} configured keys across active provider adapters.`}
                tone={overview.keyCount > 0 ? 'success' : 'warn'}
              />
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <p className="rounded-md border border-border bg-background/35 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Free</span>
                <span className="float-right font-semibold tabular-nums text-emerald-300">{modelCounts.free ?? 0}</span>
              </p>
              <p className="rounded-md border border-border bg-background/35 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Limited</span>
                <span className="float-right font-semibold tabular-nums text-amber-300">{modelCounts.rate_limited ?? 0}</span>
              </p>
              <p className="rounded-md border border-border bg-background/35 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Deprecated</span>
                <span className="float-right font-semibold tabular-nums">{modelCounts.deprecated ?? 0}</span>
              </p>
              <p className="rounded-md border border-border bg-background/35 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Error</span>
                <span className="float-right font-semibold tabular-nums text-red-300">{modelCounts.error ?? modelCounts.unknown ?? 0}</span>
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-500" /> Quick actions
            </CardTitle>
            <CardDescription>Jump directly to common management flows.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {quickLinks.map(link => {
              const Icon = link.icon
              return (
                <Link
                  key={link.to}
                  to={link.to}
                  className="group flex items-center gap-3 rounded-md border border-border bg-background/45 p-3 transition-colors hover:border-primary/40 hover:bg-muted/50"
                >
                  <span className="flex size-8 items-center justify-center rounded-md border border-border bg-background/60 text-primary">
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

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="24h requests"
          value={summary?.totalRequests ? summary.totalRequests.toLocaleString() : 'Loading...'}
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

      <Card>
        <CardHeader>
          <CardTitle>Capabilities at a glance</CardTitle>
          <CardDescription>
            Capability support across configured providers.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          {capabilities.map(capability => {
            const configured = providers.reduce((count, provider) => {
              const bucket = provider.capabilities[capability]
              return count + (bucket?.configured ? bucket.supportedModels : 0)
            }, 0)
            const supported = providers.reduce((count, provider) => count + (provider.capabilities[capability]?.supportedModels ?? 0), 0)
            const status = supported === 0 ? 'unsupported' : configured > 0 ? 'configured' : 'missing'
            return (
              <div key={capability} className="rounded-md border border-border bg-background/45 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium capitalize">{capability}</p>
                  <span className={`size-2 rounded-full ${status === 'configured' ? 'bg-emerald-400' : status === 'missing' ? 'bg-amber-400' : 'bg-muted-foreground/35'}`} />
                </div>
                <p className="mt-2 text-xs text-muted-foreground tabular-nums">
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

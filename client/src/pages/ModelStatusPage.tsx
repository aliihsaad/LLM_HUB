import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CheckCircle2, XCircle, AlertTriangle, Clock, RefreshCw, Loader2, Play, KeyRound, Rocket } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/page-header'

interface ModelAvailability {
  id: number
  platform: string
  modelId: string
  displayName: string
  enabled: boolean
  availabilityStatus: string
  lastCheckAt: string | null
  lastError: string | null
  freeTierConfirmed: boolean
  discoverySource: string | null
}

interface DiscoverResult {
  discoveredCount: number
  insertedCount: number
  skippedKnownCount: number
  discovered: Array<{ platform: string; modelId: string; displayName: string }>
  inserted: Array<{ platform: string; modelId: string; displayName: string }>
  skippedKnown: Array<{ platform: string; modelId: string; displayName: string }>
}

export default function ModelStatusPage() {
  const [filter, setFilter] = useState<string>('all')
  const [showDisabled, setShowDisabled] = useState(false)

  const { data, isLoading, isError, refetch, isRefetching, error } = useQuery<{
    models: ModelAvailability[]
    checkedAt: string
  }>({
    queryKey: ['model-availability'],
    queryFn: () => apiFetch('/api/model-availability'),
  })

  const allModels = data?.models ?? []
  // Disabled models cannot be routed to and are never live-checked, so counting
  // them as "unknown" only inflates the numbers. Hidden unless asked for.
  const disabledCount = allModels.filter(m => !m.enabled).length
  const models = showDisabled ? allModels : allModels.filter(m => m.enabled)

  const checkMutation = useMutation({
    mutationFn: () => apiFetch('/api/model-availability/check', { method: 'POST' }),
    onSuccess: () => refetch(),
  })
  const [discoverResult, setDiscoverResult] = useState<DiscoverResult | null>(null)
  const discoverMutation = useMutation({
    mutationFn: () => apiFetch<DiscoverResult>('/api/model-availability/discover', { method: 'POST' }),
    onSuccess: (data) => {
      setDiscoverResult(data)
      refetch()
    },
  })

  const filtered = filter === 'all'
    ? models
    : models.filter(m => m.availabilityStatus === filter)

  const stats = {
    free: models.filter(m => m.availabilityStatus === 'free').length,
    rateLimited: models.filter(m => m.availabilityStatus === 'rate_limited').length,
    deprecated: models.filter(m => m.availabilityStatus === 'deprecated').length,
    error: models.filter(m => m.availabilityStatus === 'error').length,
    unknown: models.filter(m => m.availabilityStatus === 'unknown').length,
  }

  const unknownBreakdown = models.reduce(
    (acc, model) => {
      if (model.availabilityStatus !== 'unknown') return acc

      if (!model.lastCheckAt) {
        acc.notScanned += 1
        return acc
      }

      if (model.lastError?.includes('No active API key configured for this platform')) {
        acc.noKey += 1
        return acc
      }

      acc.other += 1
      return acc
    },
    { noKey: 0, notScanned: 0, other: 0 },
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="space-y-3">
        <PageHeader
          title="Model Status"
          description="Unable to load model availability. Check server status and API auth/session."
        />
        <Card className="rounded-lg border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">{(error as Error).message}</p>
        </Card>
        <Button size="sm" onClick={() => refetch()} disabled={isRefetching}>
          <RefreshCw className={`size-3.5 mr-1.5 ${isRefetching ? 'animate-spin' : ''}`} />
          Retry
        </Button>
      </div>
    )
  }

  if (!data || data.models.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Model Status"
          description="No model availability rows found. Run a sync to populate this view."
        />
        <Card className="py-12 text-center text-muted-foreground">
          No models were returned from /api/model-availability.
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Model Status"
        description="Real-time availability of free-tier models across all providers."
      />

      {/* Stats Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          label="Free"
          count={stats.free}
          icon={<CheckCircle2 className="size-4 text-green-500" />}
          variant="green"
          active={filter === 'free'}
          onClick={() => setFilter(filter === 'free' ? 'all' : 'free')}
        />
        <StatCard
          label="Rate Limited"
          count={stats.rateLimited}
          icon={<AlertTriangle className="size-4 text-amber-500" />}
          variant="amber"
          active={filter === 'rate_limited'}
          onClick={() => setFilter(filter === 'rate_limited' ? 'all' : 'rate_limited')}
        />
        <StatCard
          label="Deprecated"
          count={stats.deprecated}
          icon={<XCircle className="size-4 text-red-500" />}
          variant="red"
          active={filter === 'deprecated'}
          onClick={() => setFilter(filter === 'deprecated' ? 'all' : 'deprecated')}
        />
        <StatCard
          label="Error"
          count={stats.error}
          icon={<XCircle className="size-4 text-red-400" />}
          variant="red"
          active={filter === 'error'}
          onClick={() => setFilter(filter === 'error' ? 'all' : 'error')}
        />
        <StatCard
          label="Unknown"
          count={stats.unknown}
          icon={<Clock className="size-4 text-muted-foreground" />}
          variant="gray"
          active={filter === 'unknown'}
          onClick={() => setFilter(filter === 'unknown' ? 'all' : 'unknown')}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isRefetching}>
          <RefreshCw className={`size-3.5 mr-1.5 ${isRefetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => checkMutation.mutate()}
          disabled={checkMutation.isPending}
        >
          <Play className={`size-3.5 mr-1.5 ${checkMutation.isPending ? 'animate-pulse' : ''}`} />
          Run live check
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => discoverMutation.mutate()}
          disabled={discoverMutation.isPending}
        >
          <Rocket className={`size-3.5 mr-1.5 ${discoverMutation.isPending ? 'animate-pulse' : ''}`} />
          Discover new models
        </Button>
        {disabledCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowDisabled(v => !v)}
            title="Disabled models cannot be routed to and are never live-checked"
          >
            {showDisabled ? `Hide disabled (${disabledCount})` : `Show disabled (${disabledCount})`}
          </Button>
        )}
        {filter !== 'all' && (
          <Badge variant="secondary" className="cursor-pointer" onClick={() => setFilter('all')}>
            Showing: {filter} — click to clear
          </Badge>
        )}
      </div>

      {discoverResult && (
        <Card className="rounded-lg border-dashed p-4">
          <p className="text-xs text-muted-foreground">
            Discovery run: {discoverResult.discoveredCount} candidates checked, {discoverResult.insertedCount} added.
            {discoverResult.skippedKnownCount > 0 ? ` ${discoverResult.skippedKnownCount} already known.` : ''}
          </p>
        </Card>
      )}

      {stats.unknown > 0 && (
        <Card className="rounded-lg border-dashed p-4">
          <p className="text-xs text-muted-foreground">
            Unknown means the model was not confirmed.{' '}
            {unknownBreakdown.noKey > 0 && `${unknownBreakdown.noKey} no key configured.`}{' '}
            {unknownBreakdown.notScanned > 0 && `${unknownBreakdown.notScanned} not scanned yet.`}{' '}
            {unknownBreakdown.other > 0 && `${unknownBreakdown.other} still pending provider confirmation.`}
          </p>
        </Card>
      )}

      {/* Model List */}
      <div className="grid gap-3">
        {filtered.length === 0 ? (
          <Card className="py-12 text-center text-muted-foreground">
            No models match the current filter.
          </Card>
        ) : (
          filtered.map(model => (
            <Card key={model.id} className="rounded-lg hover:shadow-md transition-shadow">
              <CardContent className="p-4 flex items-center gap-4">
                <StatusIndicator status={model.availabilityStatus} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-medium text-sm truncate">{model.displayName}</span>
                    <Badge variant="outline" className="text-[10px] h-4 px-1.5">{model.platform}</Badge>
                    {model.discoverySource ? (
                      <Badge variant="secondary" className="text-[10px] h-4 px-1.5">new</Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground font-mono truncate">{model.modelId}</p>
                  {model.availabilityStatus === 'unknown' && (
                    <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                      <KeyRound className="size-3" />
                      {getUnknownCause(model)}
                    </p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <AvailabilityBadge status={model.availabilityStatus} />
                  {model.lastCheckAt && (
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Checked {new Date(model.lastCheckAt).toLocaleTimeString()}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  )
}

function StatCard({
  label,
  count,
  icon,
  variant,
  active,
  onClick,
}: {
  label: string
  count: number
  icon: React.ReactNode
  variant: 'green' | 'amber' | 'red' | 'gray'
  active: boolean
  onClick: () => void
}) {
  const variantStyles = {
    green: active ? 'bg-green-50 border-green-300 dark:bg-green-950/40 dark:border-green-700' : 'hover:border-green-300 hover:bg-green-50/50',
    amber: active ? 'bg-amber-50 border-amber-300 dark:bg-amber-950/40 dark:border-amber-700' : 'hover:border-amber-300 hover:bg-amber-50/50',
    red: active ? 'bg-red-50 border-red-300 dark:bg-red-950/40 dark:border-red-700' : 'hover:border-red-300 hover:bg-red-50/50',
    gray: active ? 'bg-muted/60 border-muted-foreground' : 'hover:border-muted-foreground hover:bg-muted/30',
  }

  return (
    <Card
      className={`cursor-pointer transition-all rounded-lg ${variantStyles[variant]} ${active ? 'ring-2 ring-offset-1' : ''}`}
      onClick={onClick}
    >
      <CardContent className="p-4 flex items-center gap-3">
        {icon}
        <div>
          <p className="text-2xl font-bold leading-none">{count}</p>
          <p className="text-xs text-muted-foreground mt-1">{label}</p>
        </div>
      </CardContent>
    </Card>
  )
}

function StatusIndicator({ status }: { status: string }) {
  const colors: Record<string, string> = {
    free: 'bg-green-500',
    rate_limited: 'bg-amber-500',
    deprecated: 'bg-red-500',
    error: 'bg-red-400',
    unknown: 'bg-muted-foreground',
  }
  return (
    <div className="relative">
      <div className={`size-2.5 rounded-full ${colors[status] ?? colors.unknown}`} />
      {status === 'free' && (
        <div className="absolute inset-0 size-2.5 rounded-full bg-green-500 animate-ping opacity-40" />
      )}
    </div>
  )
}

function AvailabilityBadge({ status }: { status: string }) {
  const variants: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
    free: { label: 'Free', variant: 'default' },
    rate_limited: { label: 'Rate Limited', variant: 'secondary' },
    deprecated: { label: 'Deprecated', variant: 'destructive' },
    error: { label: 'Error', variant: 'destructive' },
    unknown: { label: 'Unknown', variant: 'outline' },
  }
  const config = variants[status] ?? variants.unknown
  return <Badge variant={config.variant}>{config.label}</Badge>
}

function getUnknownCause(model: ModelAvailability): string {
  if (!model.lastCheckAt) return 'Not scanned yet';
  if (model.lastError?.includes('No active API key configured for this platform')) return 'No active API key for this platform';
  return model.lastError ?? 'Awaiting status confirmation';
}

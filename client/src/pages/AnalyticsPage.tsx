import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  AlertCircle,
  ArrowRight,
  BadgeCheck,
  BarChart3,
  Box,
  Clock4,
  DollarSign,
  Layers,
  RefreshCw,
  ServerCog,
  TrendingUp,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/page-header'
import type {
  AnalyticsSummary,
  PlatformStats,
  TimelinePoint,
  UsageEstimateProvider,
  UsageEstimatesResponse,
  UsagePressure,
} from '../../../shared/types'

type TimeRange = '24h' | '7d' | '30d'
type AnalyticsView = 'overview' | 'models' | 'errors'
type OverviewTab = 'budget' | 'trend' | 'providers'
type ModelsTab = 'leaderboard' | 'distribution'
type ErrorsTab = 'categories' | 'providers' | 'recent'

interface UsageErrorRecord {
  id: number
  platform: string
  modelId: string
  error: string | null
  latencyMs: number
  createdAt: string
}

interface ErrorDistributionCategory {
  category: string
  count: number
}

interface ErrorDistributionPlatform {
  platform: string
  count: number
}

interface ErrorDistributionDetail {
  platform: string
  model_id: string
  error_category: string
  count: number
}

interface ErrorDistribution {
  byCategory: Array<{ category: string; count: number | string }>
  byPlatform: Array<{ platform: string; count: number | string }>
  detailed: Array<ErrorDistributionDetail>
}

interface ModelUsageRow extends PlatformStats {
  modelId: string
  displayName: string
}

type StatTone = 'primary' | 'accent' | 'success' | 'caution'

const views: Array<{ key: AnalyticsView; label: string; icon: typeof Activity }> = [
  { key: 'overview', label: 'Overview', icon: BarChart3 },
  { key: 'models', label: 'Models', icon: Layers },
  { key: 'errors', label: 'Errors', icon: AlertCircle },
]

const overviewTabs: Array<{ key: OverviewTab; label: string }> = [
  { key: 'budget', label: 'Budget' },
  { key: 'trend', label: 'Trend' },
  { key: 'providers', label: 'Providers' },
]

const modelTabs: Array<{ key: ModelsTab; label: string }> = [
  { key: 'leaderboard', label: 'Leaderboard' },
  { key: 'distribution', label: 'Distribution' },
]

const errorTabs: Array<{ key: ErrorsTab; label: string }> = [
  { key: 'categories', label: 'Categories' },
  { key: 'providers', label: 'Providers' },
  { key: 'recent', label: 'Recent' },
]

const timeOptions: TimeRange[] = ['24h', '7d', '30d']

const pressureClass: Record<UsagePressure, string> = {
  low: 'text-emerald-700 border-emerald-500/35 bg-emerald-500/12 dark:text-emerald-200',
  medium: 'text-amber-700 border-amber-500/35 bg-amber-500/12 dark:text-amber-200',
  high: 'text-orange-700 border-orange-500/35 bg-orange-500/12 dark:text-orange-200',
  critical: 'text-destructive border-destructive/35 bg-destructive/12',
}

const statToneClass: Record<StatTone, { container: string; icon: string }> = {
  primary: {
    container: 'from-primary/20 to-primary/5 border-primary/35',
    icon: 'bg-primary/20 border-primary/25 text-primary',
  },
  accent: {
    container: 'from-sky-500/20 to-sky-500/5 border-sky-500/30',
    icon: 'bg-sky-500/10 border-sky-500/20 text-sky-600 dark:text-sky-300',
  },
  success: {
    container: 'from-emerald-500/20 to-emerald-500/5 border-emerald-500/30',
    icon: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-300',
  },
  caution: {
    container: 'from-amber-500/20 to-amber-500/6 border-amber-500/30',
    icon: 'bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-300',
  },
}

const chartColors = ['#5B8DEF', '#8B5CF6', '#F59E0B', '#10B981', '#EF4444', '#14B8A6', '#F97316']

function asNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function formatTokens(n?: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatMoney(value: number): string {
  if (!value) return '$0.00'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatTime(value: string): string {
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T'))
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatTimelineLabel(timestamp: string, range: TimeRange): string {
  if (range === '24h') return timestamp.slice(11, 16)
  return timestamp.slice(5, 10)
}

function clamp01(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function StatCard({
  label,
  value,
  description,
  icon: Icon,
  tone,
}: {
  label: string
  value: string | number
  description?: string
  icon: typeof Activity
  tone: StatTone
}) {
  const classes = statToneClass[tone]
  return (
    <Card className={`bg-gradient-to-b ${classes.container} border`}> 
      <CardContent className="px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {label}
          </p>
          <span className={`size-8 rounded-lg border ${classes.icon} flex items-center justify-center`}>
            <Icon className="size-4" />
          </span>
        </div>
        <p className="mt-2 text-2xl font-semibold tabular-nums leading-none">{value}</p>
        {description && <p className="mt-1.5 text-xs text-muted-foreground">{description}</p>}
      </CardContent>
    </Card>
  )
}

function Panel({
  title,
  description,
  actions,
  className,
  children,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm">{title}</CardTitle>
            {description && <CardDescription className="mt-0.5">{description}</CardDescription>}
          </div>
          {actions && <div>{actions}</div>}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function UsageByProvider({ providers = [] }: { providers: UsageEstimateProvider[] }) {
  if (providers.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No usage estimate data yet.</p>
  }

  return (
    <div className="space-y-3">
      {providers.map(provider => (
        <Card key={provider.platform} className="overflow-hidden">
          <CardContent className="px-3 py-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium capitalize">{provider.platform}</p>
                  <span
                    className={`inline-flex rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${pressureClass[provider.pressure]}`}
                  >
                    {provider.pressure}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {provider.requests} request(s), {provider.activeKeyCount} active key(s)
                </p>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{provider.usageText}</p>
              </div>
            </div>

            <div className="mt-3">
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-sky-500 to-sky-400"
                  style={{ width: `${Math.min(100, provider.usagePercent)}%` }}
                />
              </div>
              <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>usage intensity</span>
                <span className="font-mono tabular-nums">{provider.usagePercent}%</span>
              </div>
            </div>

            {provider.topModels.length > 0 && (
              <div className="mt-3 space-y-1 border-t border-border/70 pt-2">
                {provider.topModels.slice(0, 2).map(model => (
                  <div key={`${model.platform}:${model.modelId}`} className="flex items-center justify-between gap-2 text-xs">
                    <p className="min-w-0 flex-1 truncate">{model.displayName}</p>
                    <p className="font-mono text-muted-foreground tabular-nums">
                      {formatTokens(model.usedTokens)} tokens
                    </p>
                    <Badge variant="outline" className={`border-sky-500/30`}>
                      {model.usagePercent}%
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function ErrorCard({
  category,
  count,
  total,
  maxCount,
}: {
  category: string
  count: number
  total: number
  maxCount: number
}) {
  const share = maxCount === 0 ? 0 : clamp01((count / total) * 100)
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <p className="font-medium">{category}</p>
        <p className="tabular-nums text-muted-foreground">{count}</p>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-destructive/70" style={{ width: `${share}%` }} />
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        {share.toFixed(1)}% of total failures
      </div>
    </div>
  )
}

function ViewTabs({
  value,
  onChange,
}: {
  value: AnalyticsView
  onChange: (value: AnalyticsView) => void
}) {
  const tabIdleClass =
    'border border-border/55 text-muted-foreground hover:text-foreground hover:border-primary/70 hover:bg-primary/8'
  const tabActiveClass =
    'border border-primary/70 bg-primary/15 text-foreground dark:text-primary-foreground font-semibold shadow-sm'
  return (
    <div
      role="tablist"
      aria-label="Analytics sections"
      className="flex w-full flex-nowrap overflow-x-auto gap-2 border-b border-border/70 pb-2"
    >
      {views.map(option => {
        const Icon = option.icon
        const active = value === option.key
        return (
          <Button
            key={option.key}
            role="tab"
            id={`analytics-tab-${option.key}`}
            aria-controls={`analytics-panel-${option.key}`}
            aria-selected={active}
            variant={active ? 'outline' : 'outline'}
            size="sm"
            onClick={() => onChange(option.key)}
            className={`gap-1.5 whitespace-nowrap transition-colors ${active ? tabActiveClass : tabIdleClass}`}
          >
            <Icon className="size-3.5" />
            {option.label}
          </Button>
        )
      })}
    </div>
  )
}

function SubTabs<T extends string>({
  value,
  onChange,
  items,
  baseId,
  ariaLabel,
}: {
  value: T
  onChange: (value: T) => void
  items: Array<{ key: T; label: string }>
  baseId: string
  ariaLabel: string
}) {
  const tabIdleClass =
    'border border-border/45 text-muted-foreground hover:text-foreground hover:border-primary/65 hover:bg-primary/8'
  const tabActiveClass =
    'border border-primary/70 bg-primary/15 text-foreground dark:text-primary-foreground font-semibold shadow-sm'
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex w-full flex-nowrap overflow-x-auto gap-2 border-b border-border/70 pb-2"
    >
      {items.map(item => {
        const active = value === item.key
        return (
          <Button
            key={item.key}
            role="tab"
            id={`analytics-${baseId}-tab-${item.key}`}
            aria-controls={`analytics-${baseId}-panel-${item.key}`}
            aria-selected={active}
            variant="outline"
            size="xs"
            onClick={() => onChange(item.key)}
            className={`whitespace-nowrap transition-colors ${active ? tabActiveClass : tabIdleClass}`}
          >
            {item.label}
          </Button>
        )
      })}
    </div>
  )
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<TimeRange>('7d')
  const [view, setView] = useState<AnalyticsView>('overview')
  const [overviewTab, setOverviewTab] = useState<OverviewTab>('budget')
  const [modelsTab, setModelsTab] = useState<ModelsTab>('leaderboard')
  const [errorsTab, setErrorsTab] = useState<ErrorsTab>('categories')

  const { data: summary, isLoading: summaryLoading, refetch: refetchSummary } = useQuery<AnalyticsSummary>({
    queryKey: ['analytics', 'summary', range],
    queryFn: () => apiFetch<AnalyticsSummary>(`/api/analytics/summary?range=${range}`),
  })

  const { data: byPlatform = [] } = useQuery<PlatformStats[]>({
    queryKey: ['analytics', 'by-platform', range],
    queryFn: () => apiFetch<PlatformStats[]>(`/api/analytics/by-platform?range=${range}`),
  })

  const { data: timeline = [] } = useQuery<TimelinePoint[]>({
    queryKey: ['analytics', 'timeline', range],
    queryFn: () => apiFetch<TimelinePoint[]>(`/api/analytics/timeline?range=${range}`),
  })

  const { data: byModel = [] } = useQuery<ModelUsageRow[]>({
    queryKey: ['analytics', 'by-model', range],
    queryFn: () => apiFetch<ModelUsageRow[]>(`/api/analytics/by-model?range=${range}`),
  })

  const { data: errors = [] } = useQuery<UsageErrorRecord[]>({
    queryKey: ['analytics', 'errors', range],
    queryFn: () => apiFetch<UsageErrorRecord[]>(`/api/analytics/errors?range=${range}`),
  })

  const { data: errorDist } = useQuery<ErrorDistribution>({
    queryKey: ['analytics', 'error-distribution', range],
    queryFn: () =>
      apiFetch<ErrorDistribution>(`/api/analytics/error-distribution?range=${range}`),
  })

  const { data: usageEstimates } = useQuery<UsageEstimatesResponse>({
    queryKey: ['analytics', 'usage-estimates', range],
    queryFn: () => apiFetch<UsageEstimatesResponse>(`/api/analytics/usage-estimates?range=${range}`),
  })

  const isBusy = summaryLoading

  const totalRequests = summary?.totalRequests ?? 0
  const totalTokens = asNumber(summary?.totalInputTokens) + asNumber(summary?.totalOutputTokens)
  const successRate = `${summary?.successRate ?? 0}%`
  const avgLatency = `${summary?.avgLatencyMs ?? 0} ms`
  const savings = formatMoney(summary?.estimatedCostSavings ?? 0)

  const platformRows = useMemo(
    () => byPlatform.map(platform => ({ ...platform, successRate: Number(platform.successRate.toFixed(1)) })),
    [byPlatform],
  )

  const topModels = useMemo(() => [...byModel].sort((a, b) => b.requests - a.requests).slice(0, 40), [byModel])
  const categoryRows = useMemo<ErrorDistributionCategory[]>(
    () =>
      (errorDist?.byCategory ?? []).map(row => ({
        category: row.category,
        count: asNumber(row.count),
      })),
    [errorDist],
  )
  const providerErrors = useMemo<ErrorDistributionPlatform[]>(
    () =>
      (errorDist?.byPlatform ?? []).map(row => ({
        platform: row.platform,
        count: asNumber(row.count),
      })),
    [errorDist],
  )
  const latestErrors = useMemo(() => errors.slice(0, 20), [errors])

  const errorTotal = useMemo(() => providerErrors.reduce((acc, row) => acc + row.count, 0), [providerErrors])
  const categoryMax = useMemo(() => (categoryRows.length ? Math.max(...categoryRows.map(row => row.count)) : 0), [categoryRows])
  const usageProgress = useMemo(() => (usageEstimates ? clamp01(usageEstimates.total.usagePercent) : 0), [usageEstimates])

  const chartTooltipStyle = {
    backgroundColor: 'var(--popover)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    fontSize: 12,
  }

  const renderEmpty = (label: string) => <p className="text-sm text-muted-foreground text-center py-10">{label}</p>

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Premium traffic and reliability analytics with cleaner tabular and chart views."
        actions={
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex rounded-md border border-border/65 bg-background/80 p-0.5">
                {timeOptions.map(item => (
                  <Button
                    key={item}
                    variant={range === item ? 'secondary' : 'ghost'}
                    size="xs"
                    onClick={() => setRange(item)}
                  >
                    {item}
                  </Button>
                ))}
              </div>
              <Button
                size="icon-sm"
                variant="outline"
                onClick={() => refetchSummary()}
                disabled={isBusy}
                aria-label="Refresh analytics"
              >
                <RefreshCw className={isBusy ? 'size-4 animate-spin' : 'size-4'} />
              </Button>
            </div>

            <ViewTabs value={view} onChange={setView} />
          </div>
        }
      />

      <div className="space-y-6">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard label="Requests" value={totalRequests.toLocaleString()} icon={Activity} tone="primary" />
          <StatCard
            label="Success rate"
            value={successRate}
            icon={BadgeCheck}
            tone="success"
            description="Across providers"
          />
          <StatCard
            label="Input tokens"
            value={formatTokens(summary?.totalInputTokens)}
            icon={Box}
            tone="accent"
            description="Prompt tokens"
          />
          <StatCard
            label="Output tokens"
            value={formatTokens(summary?.totalOutputTokens)}
            icon={ServerCog}
            tone="accent"
            description="Completion tokens"
          />
          <StatCard label="Latency" value={avgLatency} icon={Clock4} tone="caution" description="Average response" />
          <StatCard
            label="Cost savings"
            value={savings}
            icon={DollarSign}
            tone="primary"
            description="Estimated monthly"
          />
        </div>

        <Panel
          title="Traffic totals"
          description={`${totalTokens.toLocaleString()} total tokens handled in this range`}
          className="border-dashed border-primary/20"
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <p className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Total input + output</span>
              <span className="ml-2 font-semibold text-foreground">{formatTokens(totalTokens)}</span>
            </p>
            <p className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Active providers</span>
              <span className="ml-2 font-semibold text-foreground">{platformRows.length}</span>
            </p>
            <p className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Active models</span>
              <span className="ml-2 font-semibold text-foreground">{byModel.length}</span>
            </p>
            <p className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Distinct failures</span>
              <span className="ml-2 font-semibold text-foreground">{providerErrors.length}</span>
            </p>
          </div>
        </Panel>

        {isBusy && (
          <Card>
            <CardContent className="py-4 text-center">
              <p className="text-sm text-muted-foreground">Refreshing analytics…</p>
            </CardContent>
          </Card>
        )}

        {view === 'overview' && (
          <div
            role="tabpanel"
            id="analytics-panel-overview"
            aria-labelledby="analytics-tab-overview"
            className="space-y-6"
          >
            <SubTabs
              value={overviewTab}
              onChange={setOverviewTab}
              items={overviewTabs}
              baseId="overview"
              ariaLabel="Overview analytics sub-sections"
            />

            {overviewTab === 'budget' && (
              <section
                id="analytics-overview-panel-budget"
                role="tabpanel"
                aria-labelledby="analytics-overview-tab-budget"
              >
                <Panel
                  title="Monthly usage estimate"
                  description="How current routed traffic compares with configured monthly budgets."
                  actions={
                    usageEstimates ? (
                      <Badge variant="outline" className={pressureClass[usageEstimates.total.pressure]}>
                        {usageEstimates.total.pressure}
                      </Badge>
                    ) : null
                  }
                >
                  {usageEstimates ? (
                    <div className="space-y-4">
                      <p className="text-lg font-semibold tabular-nums">{usageEstimates.total.usageText}</p>
                      <p className="text-xs leading-relaxed text-muted-foreground">{usageEstimates.note}</p>
                      <div className="grid gap-1">
                        <div className="h-2 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-primary to-sky-500"
                            style={{ width: `${usageProgress}%` }}
                          />
                        </div>
                        <div className="flex justify-between items-center text-xs">
                          <span className="text-muted-foreground">Used budget</span>
                          <span className="font-mono tabular-nums">{formatTokens(usageEstimates.total.usedTokens)} used</span>
                        </div>
                      </div>
                      <UsageByProvider providers={usageEstimates.providers} />
                    </div>
                  ) : (
                    renderEmpty('No budget estimate data yet.')
                  )}
                </Panel>
              </section>
            )}

            {overviewTab === 'trend' && (
              <section
                id="analytics-overview-panel-trend"
                role="tabpanel"
                aria-labelledby="analytics-overview-tab-trend"
              >
                <Panel title="Token and request trend" description="Success and failure trend across the selected range.">
                  {timeline.length === 0 ? (
                    renderEmpty('No traffic events in this range.')
                  ) : (
                    <div className="h-[320px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={timeline} margin={{ top: 8, right: 10, left: -8, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" />
                          <XAxis
                            dataKey="timestamp"
                            tickFormatter={(value: string) => formatTimelineLabel(value, range)}
                            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                            tickLine={false}
                            axisLine={{ stroke: 'var(--border)' }}
                          />
                          <YAxis
                            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                            tickLine={false}
                            axisLine={false}
                          />
                          <Tooltip contentStyle={chartTooltipStyle} />
                          <Line
                            type="monotone"
                            dataKey="successCount"
                            name="Success"
                            stroke="var(--primary)"
                            strokeWidth={1.7}
                            dot={false}
                            activeDot={{ r: 3 }}
                          />
                          <Line
                            type="monotone"
                            dataKey="failureCount"
                            name="Failures"
                            stroke="var(--destructive)"
                            strokeWidth={1.7}
                            dot={false}
                            activeDot={{ r: 3 }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </Panel>
              </section>
            )}

            {overviewTab === 'providers' && (
              <section
                id="analytics-overview-panel-providers"
                role="tabpanel"
                aria-labelledby="analytics-overview-tab-providers"
                className="grid gap-6 xl:grid-cols-2"
              >
                <Panel title="Request volume by provider" description="Provider-level request counts for the selected period.">
                  {platformRows.length === 0 ? (
                    renderEmpty('No provider data for this period.')
                  ) : (
                    <div className="h-[260px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={platformRows} margin={{ top: 6, right: 8, left: -8, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" />
                          <XAxis
                            dataKey="platform"
                            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                            tickLine={false}
                            axisLine={{ stroke: 'var(--border)' }}
                          />
                          <YAxis
                            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                            tickLine={false}
                            axisLine={false}
                          />
                          <Tooltip contentStyle={chartTooltipStyle} />
                          <Bar dataKey="requests" fill="var(--primary)" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </Panel>

                <Panel title="Latency profile" description="Average response latency by provider.">
                  {platformRows.length === 0 ? (
                    renderEmpty('No latency data for this period.')
                  ) : (
                    <div className="h-[260px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={platformRows} margin={{ top: 6, right: 8, left: -8, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" />
                          <XAxis
                            dataKey="platform"
                            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                            tickLine={false}
                            axisLine={{ stroke: 'var(--border)' }}
                          />
                          <YAxis
                            unit="ms"
                            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                            tickLine={false}
                            axisLine={false}
                          />
                          <Tooltip contentStyle={chartTooltipStyle} />
                          <Bar dataKey="avgLatencyMs" name="Avg latency (ms)" fill="var(--chart-4)" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </Panel>
              </section>
            )}
          </div>
        )}

        {view === 'models' && (
          <div
            role="tabpanel"
            id="analytics-panel-models"
            aria-labelledby="analytics-tab-models"
            className="space-y-6"
          >
            <SubTabs
              value={modelsTab}
              onChange={setModelsTab}
              items={modelTabs}
              baseId="models"
              ariaLabel="Models analytics sub-sections"
            />

            {modelsTab === 'leaderboard' && (
              <section
                id="analytics-models-panel-leaderboard"
                role="tabpanel"
                aria-labelledby="analytics-models-tab-leaderboard"
              >
                <Panel
                  title="Model leaderboard"
                  description="Top models by requests, success and token usage."
                  actions={<TrendingUp className="size-3.5" />}
                >
                  {topModels.length === 0 ? (
                    renderEmpty('No model-level data for this range.')
                  ) : (
                    <div className="overflow-hidden">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="pl-4">Model</TableHead>
                            <TableHead>Provider</TableHead>
                            <TableHead className="text-right">Req</TableHead>
                            <TableHead className="text-right">Success</TableHead>
                            <TableHead className="text-right">Latency</TableHead>
                            <TableHead className="text-right">Input</TableHead>
                            <TableHead className="text-right">Output</TableHead>
                            <TableHead className="text-right pr-4">Status</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {topModels.map(model => {
                            const successRatio = model.successRate
                            const status = successRatio >= 95 ? 'Healthy' : successRatio >= 80 ? 'Warning' : 'Degraded'
                            const statusTone: UsagePressure = successRatio >= 95
                              ? 'low'
                              : successRatio >= 80
                                ? 'medium'
                                : 'critical'
                            return (
                              <TableRow key={`${model.platform}:${model.modelId}`}>
                                <TableCell className="pl-4 text-xs font-medium">{model.displayName}</TableCell>
                                <TableCell className="text-xs text-muted-foreground">{model.platform}</TableCell>
                                <TableCell className="text-right tabular-nums">{model.requests}</TableCell>
                                <TableCell className="text-right tabular-nums">{successRatio}%</TableCell>
                                <TableCell className="text-right tabular-nums">{model.avgLatencyMs} ms</TableCell>
                                <TableCell className="text-right tabular-nums">{formatTokens(model.totalInputTokens)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatTokens(model.totalOutputTokens)}</TableCell>
                                <TableCell className="pr-4 text-right">
                                  <span
                                    className={`inline-flex rounded-md border px-1.5 py-0.5 text-[11px] ${pressureClass[statusTone]}`}
                                  >
                                    {status}
                                  </span>
                                </TableCell>
                              </TableRow>
                            )
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </Panel>
              </section>
            )}

            {modelsTab === 'distribution' && (
              <section
                id="analytics-models-panel-distribution"
                role="tabpanel"
                aria-labelledby="analytics-models-tab-distribution"
              >
                <Panel title="Top model usage" description="Relative request share and token footprint.">
                  <div className="space-y-3">
                    {topModels.length === 0 ? (
                      renderEmpty('No model-level data for this range.')
                    ) : (
                      <>
                        {topModels.slice(0, 12).map(model => {
                          const modelTokens = model.totalInputTokens + model.totalOutputTokens
                          const modelShare = totalRequests === 0 ? 0 : Math.min(100, (model.requests / totalRequests) * 100)
                          return (
                            <div
                              key={`${model.platform}:${model.modelId}`}
                              className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="text-sm font-medium truncate">{model.displayName}</p>
                                  <p className="text-xs text-muted-foreground">{model.platform}</p>
                                </div>
                                <p className="text-xs tabular-nums text-muted-foreground">{formatTokens(modelTokens)} tokens</p>
                              </div>
                              <div className="mt-2 h-1.5 rounded-full bg-background overflow-hidden">
                                <div
                                  className="h-full bg-gradient-to-r from-sky-500 to-violet-500"
                                  style={{ width: `${modelShare}%` }}
                                />
                              </div>
                              <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                                <span>{model.requests} requests</span>
                                <span>
                                  {formatTokens(model.totalInputTokens)} in / {formatTokens(model.totalOutputTokens)} out
                                </span>
                              </div>
                            </div>
                          )
                        })}
                        <Button className="mt-2 w-full" variant="outline" size="sm" disabled={topModels.length === 0}>
                          <ArrowRight className="size-3.5" />
                          View full model history
                        </Button>
                      </>
                    )}
                  </div>
                </Panel>
              </section>
            )}
          </div>
        )}

        {view === 'errors' && (
          <div
            role="tabpanel"
            id="analytics-panel-errors"
            aria-labelledby="analytics-tab-errors"
            className="space-y-6"
          >
            <SubTabs
              value={errorsTab}
              onChange={setErrorsTab}
              items={errorTabs}
              baseId="errors"
              ariaLabel="Error analytics sub-sections"
            />

            {errorsTab === 'categories' && (
              <section
                id="analytics-errors-panel-categories"
                role="tabpanel"
                aria-labelledby="analytics-errors-tab-categories"
              >
                <Panel title="Error categories" description="Failures by normalized category." actions={<AlertCircle className="size-3.5 text-destructive" />}>
                  {categoryRows.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-10">No failures detected.</p>
                  ) : (
                    <div className="space-y-3">
                      {categoryRows.map(row => (
                        <ErrorCard
                          key={row.category}
                          category={row.category}
                          count={row.count}
                          total={Math.max(errorTotal, 1)}
                          maxCount={categoryMax}
                        />
                      ))}
                    </div>
                  )}
                </Panel>
              </section>
            )}

            {errorsTab === 'providers' && (
              <section
                id="analytics-errors-panel-providers"
                role="tabpanel"
                aria-labelledby="analytics-errors-tab-providers"
              >
                <Panel title="Errors by provider" description="Failure concentration by provider.">
                  {providerErrors.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-10">No failures detected.</p>
                  ) : (
                    <div className="h-[340px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={providerErrors.map((row, index) => ({
                              name: row.platform,
                              value: row.count,
                              color: chartColors[index % chartColors.length],
                            }))}
                            dataKey="value"
                            cx="50%"
                            cy="50%"
                            innerRadius={56}
                            outerRadius={92}
                            paddingAngle={2}
                            label
                            labelLine={false}
                          >
                            {providerErrors.map((entry, index) => (
                              <Cell key={entry.platform} fill={chartColors[index % chartColors.length]} />
                            ))}
                          </Pie>
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="mt-4 grid gap-1.5 sm:grid-cols-2">
                        {providerErrors.map((row, index) => (
                          <div key={row.platform} className="flex items-center gap-2 text-xs">
                            <span
                              className="size-2 rounded-full"
                              style={{ backgroundColor: chartColors[index % chartColors.length] }}
                            />
                            <span className="font-medium capitalize">{row.platform}</span>
                            <span className="ml-auto text-muted-foreground tabular-nums">{row.count}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </Panel>
              </section>
            )}

            {errorsTab === 'recent' && (
              <section
                id="analytics-errors-panel-recent"
                role="tabpanel"
                aria-labelledby="analytics-errors-tab-recent"
              >
                <Panel title="Recent failures" description="Latest failures with model and latency details.">
                  {latestErrors.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">No failures in this period.</p>
                  ) : (
                    <div className="overflow-hidden">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="pl-4">Time</TableHead>
                            <TableHead>Provider</TableHead>
                            <TableHead>Model</TableHead>
                            <TableHead className="text-right">Latency</TableHead>
                            <TableHead className="pr-4">Message</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {latestErrors.map(error => (
                            <TableRow key={error.id}>
                              <TableCell className="pl-4 text-xs tabular-nums text-muted-foreground">
                                {formatTime(error.createdAt)}
                              </TableCell>
                              <TableCell className="text-xs font-medium">{error.platform}</TableCell>
                              <TableCell className="text-xs text-muted-foreground max-w-[220px] truncate">{error.modelId}</TableCell>
                              <TableCell className="text-right text-xs tabular-nums">{error.latencyMs} ms</TableCell>
                              <TableCell className="pr-4 max-w-[440px]">
                                <p className="truncate text-xs" title={error.error ?? 'N/A'}>
                                  {error.error ? error.error : 'Unknown'}
                                </p>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </Panel>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

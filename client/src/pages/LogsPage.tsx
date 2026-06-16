import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BarChart3, ClipboardList, Flag, RefreshCw } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/page-header'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type {
  DiagnosticSeverity,
  LogEntry,
  LogErrorCategory,
  LogsDiagnosticsResponse,
  ProviderRanking,
} from '../../../shared/types'

type TimeRange = '24h' | '7d' | '30d'
type StatusFilter = 'all' | 'success' | 'error'
type LogsView = 'rankings' | 'flags' | 'recent'

const categoryLabels: Record<LogErrorCategory, string> = {
  zero_quota: 'Zero quota',
  rate_limit: 'Rate limit',
  auth: 'Auth',
  forbidden: 'Forbidden',
  not_found: 'Missing model',
  timeout: 'Timeout',
  provider: 'Provider',
  routing: 'Routing',
  other: 'Other',
}

const severityClass: Record<DiagnosticSeverity, string> = {
  critical: 'text-destructive bg-destructive/10 border-destructive/20',
  warning: 'text-amber-600 dark:text-amber-300 bg-amber-500/10 border-amber-500/20',
  info: 'text-muted-foreground bg-muted border-border',
}

const providerStatusClass: Record<ProviderRanking['status'], string> = {
  excellent: 'text-emerald-600 dark:text-emerald-300 bg-emerald-500/10 border-emerald-500/20',
  good: 'text-sky-600 dark:text-sky-300 bg-sky-500/10 border-sky-500/20',
  degraded: 'text-amber-600 dark:text-amber-300 bg-amber-500/10 border-amber-500/20',
  blocked: 'text-destructive bg-destructive/10 border-destructive/20',
  idle: 'text-muted-foreground bg-muted border-border',
}

const statusLabels: Record<StatusFilter, string> = {
  all: 'All',
  success: 'Success',
  error: 'Errors',
}

const logsTabs: Array<{ key: LogsView; label: string; icon: typeof BarChart3 }> = [
  { key: 'rankings', label: 'Provider ranking', icon: BarChart3 },
  { key: 'flags', label: 'Diagnosis flags', icon: Flag },
  { key: 'recent', label: 'Recent logs', icon: ClipboardList },
]

function formatTokens(n?: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
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

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="px-3 py-3">
        <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
        <p className="text-xl font-semibold tabular-nums mt-1">{value}</p>
      </CardContent>
    </Card>
  )
}

function Panel({
  title,
  actions,
  children,
}: {
  title: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-sm">{title}</CardTitle>
          {actions && <div>{actions}</div>}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function SeverityBadge({ severity }: { severity: DiagnosticSeverity }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium capitalize ${severityClass[severity]}`}>
      {severity}
    </span>
  )
}

function ProviderStatusBadge({ status }: { status: ProviderRanking['status'] }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium capitalize ${providerStatusClass[status]}`}>
      {status}
    </span>
  )
}

function LogsTabs({
  value,
  onChange,
  counts,
}: {
  value: LogsView
  onChange: (value: LogsView) => void
  counts: Record<LogsView, number>
}) {
  const tabIdleClass =
    'border border-border/55 text-muted-foreground hover:text-foreground hover:border-primary/70 hover:bg-primary/8'
  const tabActiveClass =
    'border border-primary/70 bg-primary/15 text-foreground dark:text-primary-foreground font-semibold shadow-sm'

  return (
    <div
      role="tablist"
      aria-label="Logs sections"
      className="flex w-full flex-nowrap gap-2 overflow-x-auto border-b border-border/70 pb-2"
    >
      {logsTabs.map(option => {
        const Icon = option.icon
        const active = value === option.key
        return (
          <Button
            key={option.key}
            role="tab"
            id={`logs-tab-${option.key}`}
            aria-controls={`logs-panel-${option.key}`}
            aria-selected={active}
            variant="outline"
            size="sm"
            onClick={() => onChange(option.key)}
            className={`gap-1.5 whitespace-nowrap transition-colors ${active ? tabActiveClass : tabIdleClass}`}
          >
            <Icon className="size-3.5" />
            {option.label}
            <span className="ml-1 rounded bg-background/50 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
              {counts[option.key]}
            </span>
          </Button>
        )
      })}
    </div>
  )
}

function buildLogsPath(range: TimeRange, status: StatusFilter, platform: string): string {
  const params = new URLSearchParams({ range, status, limit: '150' })
  if (platform !== 'all') params.set('platform', platform)
  return `/api/logs?${params.toString()}`
}

export default function LogsPage() {
  const [range, setRange] = useState<TimeRange>('24h')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [platform, setPlatform] = useState('all')
  const [view, setView] = useState<LogsView>('rankings')

  const { data, isLoading, refetch, isFetching } = useQuery<LogsDiagnosticsResponse>({
    queryKey: ['logs', range, status, platform],
    queryFn: () => apiFetch(buildLogsPath(range, status, platform)),
  })

  const platforms = useMemo(() => {
    const names = new Set<string>()
    data?.rankings.forEach(row => names.add(String(row.platform)))
    data?.recent.forEach(row => names.add(String(row.platform)))
    if (platform !== 'all') names.add(platform)
    return Array.from(names).sort()
  }, [data, platform])

  const summary = data?.summary
  const rankings = data?.rankings ?? []
  const flags = data?.flags ?? []
  const recent = data?.recent ?? []
  const tabCounts = {
    rankings: rankings.length,
    flags: flags.length,
    recent: recent.length,
  }

  return (
    <div>
      <PageHeader
        title="Logs"
        description="Diagnostics, provider ranking, and recent API events."
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="flex gap-1 rounded-md border p-0.5">
              {(['24h', '7d', '30d'] as TimeRange[]).map(item => (
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
            <Select value={status} onValueChange={(value) => setStatus((value ?? 'all') as StatusFilter)}>
              <SelectTrigger size="sm" className="w-[112px]">
                <span>{statusLabels[status]}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="success">Success</SelectItem>
                <SelectItem value="error">Errors</SelectItem>
              </SelectContent>
            </Select>
            <Select value={platform} onValueChange={(value) => setPlatform(value ?? 'all')}>
              <SelectTrigger size="sm" className="w-[152px]">
                <span className="truncate">{platform === 'all' ? 'All providers' : platform}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All providers</SelectItem>
                {platforms.map(name => (
                  <SelectItem key={name} value={name}>{name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon-sm" onClick={() => refetch()} disabled={isFetching} aria-label="Refresh logs">
              <RefreshCw className={isFetching ? 'animate-spin' : ''} />
            </Button>
          </div>
        }
      />

      <div className="space-y-6">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label="Requests" value={summary?.totalRequests ?? 0} />
          <Stat label="Success" value={`${summary?.successRate ?? 0}%`} />
          <Stat label="Errors" value={summary?.errorCount ?? 0} />
          <Stat label="Latency" value={`${summary?.avgLatencyMs ?? 0} ms`} />
          <Stat label="Providers" value={summary?.activeProviders ?? 0} />
          <Stat label="Tokens" value={formatTokens(summary?.totalTokens)} />
        </div>

        <LogsTabs value={view} onChange={setView} counts={tabCounts} />

        {view === 'rankings' && (
          <section id="logs-panel-rankings" role="tabpanel" aria-labelledby="logs-tab-rankings">
            <Panel title="Provider ranking">
              {isLoading ? (
                <p className="text-sm text-muted-foreground py-8 text-center">Loading...</p>
              ) : rankings.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">No request data for this filter.</p>
              ) : (
                <div className="-mx-4 max-h-[420px] overflow-y-auto px-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4 w-12">Rank</TableHead>
                        <TableHead>Provider</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Score</TableHead>
                        <TableHead className="text-right">Requests</TableHead>
                        <TableHead className="text-right">Success</TableHead>
                        <TableHead className="text-right">Latency</TableHead>
                        <TableHead className="text-right pr-4">Keys</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rankings.map(row => (
                        <TableRow key={row.platform}>
                          <TableCell className="pl-4 text-xs tabular-nums text-muted-foreground">#{row.rank}</TableCell>
                          <TableCell>
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">{row.platform}</p>
                              <p className="text-xs text-muted-foreground truncate">
                                {row.topFlag ? categoryLabels[row.topFlag] : 'No flags'}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell><ProviderStatusBadge status={row.status} /></TableCell>
                          <TableCell className="text-right tabular-nums">{row.score}</TableCell>
                          <TableCell className="text-right tabular-nums">{row.requests}</TableCell>
                          <TableCell className="text-right tabular-nums">{row.successRate}%</TableCell>
                          <TableCell className="text-right tabular-nums">{row.avgLatencyMs} ms</TableCell>
                          <TableCell className="text-right tabular-nums pr-4">
                            {row.healthyKeys}/{row.keyCount}
                            {row.invalidKeys > 0 && <span className="text-destructive ml-1">+{row.invalidKeys}</span>}
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

        {view === 'flags' && (
          <section id="logs-panel-flags" role="tabpanel" aria-labelledby="logs-tab-flags">
            <Panel title="Diagnosis flags">
              {flags.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">No flags for this filter.</p>
              ) : (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {flags.map(flag => (
                    <Card key={flag.id} className="overflow-hidden rounded-lg">
                      <CardContent className="px-3 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <SeverityBadge severity={flag.severity} />
                          <Badge variant="outline">{categoryLabels[flag.category]}</Badge>
                          <span className="ml-auto text-xs tabular-nums text-muted-foreground">{flag.count}</span>
                        </div>
                        <p className="mt-2 text-sm font-medium">{flag.title}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{flag.platform}{flag.modelId ? ` / ${flag.modelId}` : ''}</p>
                        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{flag.recommendation}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </Panel>
          </section>
        )}

        {view === 'recent' && (
          <section id="logs-panel-recent" role="tabpanel" aria-labelledby="logs-tab-recent">
            <Panel title="Recent logs">
              {recent.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">No logs for this filter.</p>
              ) : (
                <div className="-mx-4 max-h-[520px] overflow-y-auto px-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">Time</TableHead>
                        <TableHead>Provider</TableHead>
                        <TableHead>Model</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Flag</TableHead>
                        <TableHead className="text-right">Latency</TableHead>
                        <TableHead className="text-right">Tokens</TableHead>
                        <TableHead className="pr-4">Message</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recent.map((entry: LogEntry) => (
                        <TableRow key={entry.id}>
                          <TableCell className="pl-4 text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                            {formatTime(entry.createdAt)}
                          </TableCell>
                          <TableCell className="text-xs font-medium">{entry.platform}</TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[180px] truncate">{entry.modelId}</TableCell>
                          <TableCell>
                            <Badge variant={entry.status === 'success' ? 'secondary' : 'destructive'}>
                              {entry.status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {entry.errorCategory ? (
                              <Badge variant="outline">{categoryLabels[entry.errorCategory]}</Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">-</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{entry.latencyMs} ms</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(entry.inputTokens + entry.outputTokens)}</TableCell>
                          <TableCell className="pr-4 text-xs max-w-[340px]">
                            <div className="truncate" title={entry.error ?? entry.suggestion}>
                              {entry.error ?? entry.suggestion}
                            </div>
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
    </div>
  )
}

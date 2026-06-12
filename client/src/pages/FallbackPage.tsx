import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

interface FallbackEntry {
  modelDbId: number
  priority: number
  effectivePriority: number
  penalty: number
  rateLimitHits: number
  enabled: boolean
  platform: string
  providerDisplayName: string
  modelId: string
  displayName: string
  intelligenceRank: number
  speedRank: number
  sizeLabel: string
  rpmLimit: number | null
  rpdLimit: number | null
  monthlyTokenBudget: string
  baseBudget: number
  effectiveBudget: number
  keyCount: number
  runtimeStatus: 'healthy' | 'degraded' | 'unavailable'
  runtimeBlockedUntil: string | null
  lastErrorCategory: string | null
  lastError: string | null
  failureCount: number
  requiresConfirmation: boolean
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

interface TokenUsageData {
  totalBudget: number
  totalUsed: number
  models: {
    modelDbId: number
    displayName: string
    platform: string
    providerDisplayName: string
    modelId: string
    monthlyTokenBudget: string
    baseBudget: number
    keyCount: number
    effectiveBudget: number
    budget: number
    runtimeStatus: string
    capabilities?: string[]
  }[]
}

type FallbackView = 'chain' | 'health' | 'budget'

const platformColors: Record<string, string> = {
  google:      '#4285f4',
  groq:        '#f55036',
  cerebras:    '#8b5cf6',
  sambanova:   '#14b8a6',
  nvidia:      '#76b900',
  mistral:     '#f59e0b',
  openrouter:  '#ec4899',
  github:      '#6e7b8b',
  cohere:      '#d946ef',
  cloudflare:  '#f38020',
  zhipu:       '#06b6d4',
  ollama:      '#000000',
  kilo:        '#7c3aed',
  pollinations: '#a855f7',
  llm7:        '#0ea5e9',
  huggingface: '#ff9d00',
}

function formatBudgetLabel(monthlyTokenBudget: string, keyCount: number, effectiveBudget: number): string {
  const base = `${monthlyTokenBudget} tok/mo`
  if (keyCount > 1 && effectiveBudget > 0) return `${base} x ${keyCount} keys = ${formatTokens(effectiveBudget)}`
  if (keyCount > 1) return `${base} x ${keyCount} keys`
  return base
}

function formatRuntimeStatus(entry: FallbackEntry): string | null {
  if (entry.runtimeStatus === 'healthy' && !entry.runtimeBlockedUntil) return null
  if (entry.runtimeStatus === 'unavailable') return 'Unavailable'
  if (entry.runtimeBlockedUntil) return 'Cooling down'
  return 'Degraded'
}

function formatHealthReason(entry: FallbackEntry): string {
  if (entry.lastErrorCategory === 'zero_quota') return 'zero quota'
  if (entry.lastErrorCategory) return entry.lastErrorCategory.replace('_', ' ')
  if (entry.runtimeBlockedUntil) return 'cooldown'
  if (!entry.enabled) return 'manual fallback off'
  return 'healthy'
}

function formatBlockedUntil(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value.replace(' ', 'T'))
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function budgetStatus(remainingPct: number) {
  if (remainingPct >= 35) {
    return {
      label: 'healthy',
      tone: 'text-emerald-500 border-emerald-500/30 bg-emerald-500/10',
      bar: 'from-emerald-500/30 to-emerald-400/60',
    }
  }
  if (remainingPct >= 15) {
    return {
      label: 'attention',
      tone: 'text-amber-500 border-amber-500/30 bg-amber-500/10',
      bar: 'from-amber-500/30 to-amber-400/60',
    }
  }
  return {
    label: 'critical',
    tone: 'text-destructive border-destructive/30 bg-destructive/10',
    bar: 'from-destructive/30 to-destructive/70',
  }
}

const fallbackTabs: Array<{ key: FallbackView; label: string }> = [
  { key: 'chain', label: 'Chain' },
  { key: 'health', label: 'Health' },
  { key: 'budget', label: 'Budget' },
]

function FallbackTabs({
  value,
  onChange,
}: {
  value: FallbackView
  onChange: (value: FallbackView) => void
}) {
  const tabIdleClass =
    'border border-border/55 text-muted-foreground hover:text-foreground hover:border-primary/70 hover:bg-primary/8'
  const tabActiveClass =
    'border border-primary/70 bg-primary/15 text-foreground dark:text-primary-foreground font-semibold shadow-sm'
  return (
    <div
      role="tablist"
      aria-label="Fallback chain sections"
      className="flex w-full flex-nowrap overflow-x-auto gap-2 border-b border-border/70 pb-2"
    >
      {fallbackTabs.map(option => {
        const active = value === option.key
        return (
          <Button
            key={option.key}
            role="tab"
            id={`fallback-tab-${option.key}`}
            aria-controls={`fallback-panel-${option.key}`}
            aria-selected={active}
            variant="outline"
            size="sm"
            onClick={() => onChange(option.key)}
            className={`gap-1.5 whitespace-nowrap transition-colors ${active ? tabActiveClass : tabIdleClass}`}
          >
            {option.label}
          </Button>
        )
      })}
    </div>
  )
}

function ModelHealthPanel({
  entries,
  onRetry,
  onEnable,
  retryingId,
  toggling,
}: {
  entries: FallbackEntry[]
  onRetry: (entry: FallbackEntry) => void
  onEnable: (modelDbId: number) => void
  retryingId: number | null
  toggling: boolean
}) {
  const routableEntries = entries.filter(entry => entry.keyCount > 0)
  const quarantined = routableEntries.filter(entry =>
    entry.runtimeStatus !== 'healthy' || entry.runtimeBlockedUntil || entry.lastErrorCategory,
  )
  const manuallyDisabled = routableEntries.filter(entry =>
    !entry.enabled && !quarantined.some(item => item.modelDbId === entry.modelDbId),
  )
  const hasIssues = quarantined.length > 0 || manuallyDisabled.length > 0

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Model health</CardTitle>
        <CardDescription>System quarantines and manual fallback disables.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div />
          <div className="flex gap-2 text-xs tabular-nums">
            <span className="rounded-full border px-2 py-1">{quarantined.length} quarantined</span>
            <span className="rounded-full border px-2 py-1">{manuallyDisabled.length} manual off</span>
          </div>
        </div>

        {!hasIssues ? (
          <p className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            All fallback models are healthy.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            {quarantined.length > 0 && (
              <HealthGroup
                title="System quarantined"
                entries={quarantined}
                actionLabel="Retry now"
                onAction={onRetry}
                busyId={retryingId}
              />
            )}
            {manuallyDisabled.length > 0 && (
              <HealthGroup
                title="Manual fallback off"
                entries={manuallyDisabled}
                actionLabel="Enable"
                onAction={(entry) => onEnable(entry.modelDbId)}
                busyId={toggling ? -1 : null}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function HealthGroup({
  title,
  entries,
  actionLabel,
  onAction,
  busyId,
}: {
  title: string
  entries: FallbackEntry[]
  actionLabel: string
  onAction: (entry: FallbackEntry) => void
  busyId: number | null
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-xs font-medium uppercase text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="divide-y rounded-md border border-border/50">
          {entries.map(entry => (
            <div key={`${title}:${entry.modelDbId}`} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{entry.displayName}</span>
                  <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                    {entry.providerDisplayName}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatHealthReason(entry)}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-mono">{entry.modelId}</span>
                  {entry.failureCount > 0 && <span>{entry.failureCount} failures</span>}
                  {entry.requiresConfirmation && <span>confirmation required</span>}
                  {formatBlockedUntil(entry.runtimeBlockedUntil) && (
                    <span>blocked until {formatBlockedUntil(entry.runtimeBlockedUntil)}</span>
                  )}
                </div>
                {entry.lastError && (
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{entry.lastError}</p>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onAction(entry)}
                disabled={busyId === entry.modelDbId || busyId === -1}
              >
                {busyId === entry.modelDbId || busyId === -1
                  ? 'Working…'
                  : entry.requiresConfirmation && actionLabel === 'Retry now'
                    ? 'Confirm retry'
                    : actionLabel}
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function TokenUsageBar({ data }: { data: TokenUsageData }) {
  const { totalBudget, totalUsed, models } = data
  const remaining = Math.max(0, totalBudget - totalUsed)
  const remainingPct = totalBudget > 0 ? Math.round((remaining / totalBudget) * 100) : 0
  const usedPct = totalBudget > 0 ? Math.min(100, (totalUsed / totalBudget) * 100) : 0
  const status = budgetStatus(remainingPct)
  const totalModelBudget = models.reduce((sum, item) => sum + Math.max(0, item.effectiveBudget), 0)
  const remainingForModels = Math.max(0, totalModelBudget - totalUsed)

  const modelsWithWidth = models
    .map(item => ({
      ...item,
      effectiveBudget: Math.max(0, item.effectiveBudget),
      keyCount: Math.max(1, item.keyCount || 1),
    }))
    .filter(item => item.effectiveBudget > 0)
    .sort((a, b) => b.effectiveBudget - a.effectiveBudget)

  const hasRemaining = remaining > 0 && totalModelBudget > 0
  const remainingPool = hasRemaining ? remaining : 0
  const modelBudgetTotal = modelsWithWidth.reduce((sum, item) => sum + item.effectiveBudget, 0) || 1
  const cardModels = models
    .map(item => ({
      ...item,
      effectiveBudget: Math.max(0, item.effectiveBudget),
      keyCount: Math.max(1, item.keyCount || 1),
    }))
    .sort((a, b) => b.effectiveBudget - a.effectiveBudget || a.displayName.localeCompare(b.displayName))

  const modelsWithSegments = modelsWithWidth.map(item => ({
    ...item,
    share: item.effectiveBudget / modelBudgetTotal,
    widthPercent: hasRemaining ? (item.effectiveBudget / modelBudgetTotal) * (100 - usedPct) : 0,
    remainingTokens: hasRemaining ? (item.effectiveBudget / modelBudgetTotal) * remainingPool : 0,
  }))

  let accumulatedWidth = 0
  for (let i = 0; i < Math.max(0, modelsWithSegments.length - 1); i += 1) {
    accumulatedWidth += modelsWithSegments[i].widthPercent
  }
  if (modelsWithSegments.length > 0) {
    modelsWithSegments[modelsWithSegments.length - 1].widthPercent = Math.max(
      0,
      100 - usedPct - accumulatedWidth,
    )
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm">Configured model budget</CardTitle>
            <CardDescription>Monitor chat and endpoint-specific models configured for this cycle.</CardDescription>
          </div>
          <Badge variant="outline" className={`text-[10px] uppercase ${status.tone}`}>
            {status.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-border/70 px-3 py-2">
            <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Budget</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{formatTokens(totalBudget)} tok/mo</p>
          </div>
          <div className="rounded-lg border border-border/70 px-3 py-2">
            <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Used</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">
              {formatTokens(totalUsed)}
              <span className="ml-1 text-xs text-muted-foreground">({usedPct.toFixed(0)}%)</span>
            </p>
          </div>
          <div className="rounded-lg border border-border/70 px-3 py-2">
            <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Remaining</p>
            <p className="mt-1 text-sm font-semibold tabular-nums text-primary">{formatTokens(remaining)}</p>
          </div>
          <div className="rounded-lg border border-border/70 px-3 py-2">
            <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Configured pool</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{formatTokens(remainingForModels)}</p>
          </div>
        </div>

        <div className="flex h-3.5 overflow-hidden rounded-full border border-border/70 bg-muted/80">
          {usedPct > 0 && (
            <div
              title={`Used: ${formatTokens(totalUsed)} (${usedPct.toFixed(0)}%)`}
              className={`h-full bg-gradient-to-r ${status.bar}`}
              style={{ width: `${usedPct}%` }}
            />
          )}
          {modelsWithSegments.map((model, i) => (
            <div
              key={i}
              title={`${model.displayName} (${model.platform}) · ${(model.share * 100).toFixed(0)}% · ${formatTokens(model.remainingTokens)} remaining`}
              className="h-full"
              style={{
                width: `${Math.max(0, model.widthPercent)}%`,
                backgroundColor: platformColors[model.platform] ?? '#94a3b8',
              }}
            />
          ))}
        </div>

        {cardModels.length === 0 ? (
          <p className="text-xs text-muted-foreground">No model budget data available yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {cardModels.map((model, i) => {
              const segment = modelsWithSegments.find(item => item.modelDbId === model.modelDbId)
              const share = segment?.share ?? 0
              const remainingTokens = segment?.remainingTokens ?? 0
              const hasNumericBudget = model.effectiveBudget > 0
              return (
                <div
                  key={`${model.platform}-${model.displayName}-${i}`}
                  className="rounded-md border border-border/65 bg-background/45 px-2.5 py-2 text-xs"
                >
                  <div className="mb-1 flex min-w-0 items-center gap-2">
                    <span
                      className="size-2.5 flex-shrink-0 rounded-sm"
                      style={{ backgroundColor: platformColors[model.platform] ?? '#94a3b8' }}
                    />
                    <span className="min-w-0 truncate text-sm font-medium">{model.displayName}</span>
                    <span className="ml-auto text-muted-foreground tabular-nums">
                      {hasNumericBudget ? `${(share * 100).toFixed(0)}%` : 'credits'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-muted-foreground">
                    <span className="truncate">{model.providerDisplayName ?? model.platform}</span>
                    <span className="font-mono tabular-nums">
                      {hasNumericBudget ? `${formatTokens(remainingTokens)} left` : model.monthlyTokenBudget}
                    </span>
                  </div>
                  <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground/80">
                    {model.modelId}
                  </div>
                  {model.capabilities && model.capabilities.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {model.capabilities.slice(0, 3).map(capability => (
                        <span
                          key={capability}
                          className="rounded-full border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {capability}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted/50">
                    <div
                      className="h-full bg-foreground/40"
                      style={{ width: `${hasNumericBudget ? Math.max(1, share * 100) : 100}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SortableModelRow({
  entry,
  index,
  onToggle,
}: {
  entry: FallbackEntry
  index: number
  onToggle: (modelDbId: number, enabled: boolean) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.modelDbId,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex items-center gap-3 px-4 py-3 bg-card ${isDragging ? 'opacity-50' : ''} ${entry.enabled ? '' : 'opacity-50'}`}
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-foreground transition-colors"
        aria-label="Drag to reorder"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
          <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
          <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
        </svg>
      </button>
      <span className="text-xs font-mono text-muted-foreground w-5 tabular-nums">{index + 1}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{entry.displayName}</span>
          <span className="text-xs text-muted-foreground">{entry.platform}</span>
          {entry.penalty > 0 && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              −{entry.penalty} penalty
            </span>
          )}
          {formatRuntimeStatus(entry) && (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
              {formatRuntimeStatus(entry)}
            </span>
          )}
        </div>
        <div className="flex gap-3 mt-0.5 text-xs text-muted-foreground tabular-nums">
          <span>Intel #{entry.intelligenceRank}</span>
          <span>Speed #{entry.speedRank}</span>
          {entry.rpmLimit && <span>{entry.rpmLimit} rpm</span>}
          {entry.rpdLimit && <span>{entry.rpdLimit} rpd</span>}
          <span>{formatBudgetLabel(entry.monthlyTokenBudget, entry.keyCount, entry.effectiveBudget)}</span>
          {entry.lastErrorCategory && (
            <span>{entry.lastErrorCategory.replace('_', ' ')}</span>
          )}
        </div>
      </div>
      <Switch
        checked={entry.enabled}
        onCheckedChange={(checked) => onToggle(entry.modelDbId, checked)}
      />
    </div>
  )
}

export default function FallbackPage() {
  const queryClient = useQueryClient()
  const [localEntries, setLocalEntries] = useState<FallbackEntry[] | null>(null)
  const [retryingId, setRetryingId] = useState<number | null>(null)
  const [view, setView] = useState<FallbackView>('chain')

  const { data: entries = [], isLoading } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const { data: tokenUsage } = useQuery<TokenUsageData>({
    queryKey: ['fallback', 'token-usage'],
    queryFn: () => apiFetch('/api/fallback/token-usage'),
  })

  const saveMutation = useMutation({
    mutationFn: (data: { modelDbId: number; priority: number; enabled: boolean }[]) =>
      apiFetch('/api/fallback', { method: 'PUT', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setLocalEntries(null)
    },
  })

  const toggleMutation = useMutation({
    mutationFn: ({ modelDbId, enabled }: { modelDbId: number; enabled: boolean }) =>
      apiFetch(`/api/fallback/${modelDbId}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })

  const retryMutation = useMutation({
    mutationFn: ({ modelDbId, confirm }: { modelDbId: number; confirm: boolean }) =>
      apiFetch(`/api/fallback/${modelDbId}/retry`, {
        method: 'POST',
        body: JSON.stringify({ confirm }),
      }),
    onMutate: ({ modelDbId }) => {
      setRetryingId(modelDbId)
    },
    onSettled: () => {
      setRetryingId(null)
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })

  const sortMutation = useMutation({
    mutationFn: (preset: string) =>
      apiFetch(`/api/fallback/sort/${preset}`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setLocalEntries(null)
    },
  })

  const allEntries = localEntries ?? entries
  const displayEntries = allEntries.filter(e => e.keyCount > 0)
  const unconfiguredPlatforms = [...new Set(allEntries.filter(e => e.keyCount === 0).map(e => e.platform))]
  const hasTokenData = !!tokenUsage && tokenUsage.models.length > 0
  const noData = !isLoading && allEntries.length === 0

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = displayEntries.findIndex(e => e.modelDbId === active.id)
    const newIndex = displayEntries.findIndex(e => e.modelDbId === over.id)
    const reorderedVisible = arrayMove(displayEntries, oldIndex, newIndex)
    const unconfigured = allEntries.filter(e => e.keyCount === 0)
    const merged = [
      ...reorderedVisible.map((e, i) => ({ ...e, priority: i + 1 })),
      ...unconfigured.map((e, i) => ({ ...e, priority: reorderedVisible.length + i + 1 })),
    ]
    setLocalEntries(merged)
  }

  function handleToggle(modelDbId: number, enabled: boolean) {
    const updated = allEntries.map(e =>
      e.modelDbId === modelDbId ? { ...e, enabled } : e
    )
    if (localEntries) {
      setLocalEntries(updated)
    } else {
      queryClient.setQueryData<FallbackEntry[]>(['fallback'], old =>
        old?.map(e => e.modelDbId === modelDbId ? { ...e, enabled } : e)
      )
    }
    toggleMutation.mutate({ modelDbId, enabled })
  }

  function handleRetry(entry: FallbackEntry) {
    if (entry.requiresConfirmation) {
      const confirmed = window.confirm(
        `${entry.displayName} was quarantined because the provider reported zero quota. Retry only after confirming this account or project has quota for ${entry.modelId}.`
      )
      if (!confirmed) return
    }

    const modelDbId = entry.modelDbId
    queryClient.setQueryData<FallbackEntry[]>(['fallback'], old =>
      old?.map(e => e.modelDbId === modelDbId
        ? {
          ...e,
          runtimeStatus: 'healthy',
          runtimeBlockedUntil: null,
          lastErrorCategory: null,
          lastError: null,
          failureCount: 0,
          requiresConfirmation: false,
        }
        : e)
    )
    retryMutation.mutate({ modelDbId, confirm: entry.requiresConfirmation })
  }

  function handleSave() {
    if (!localEntries) return
    saveMutation.mutate(
      allEntries.map(e => ({
        modelDbId: e.modelDbId,
        priority: e.priority,
        enabled: e.enabled,
      }))
    )
  }

  const hasChanges = localEntries !== null
  const sortButtons = (
    <>
      <Button variant="outline" size="sm" onClick={() => sortMutation.mutate('intelligence')} disabled={sortMutation.isPending}>
        Sort by intelligence
      </Button>
      <Button variant="outline" size="sm" onClick={() => sortMutation.mutate('speed')} disabled={sortMutation.isPending}>
        Sort by speed
      </Button>
      <Button variant="outline" size="sm" onClick={() => sortMutation.mutate('budget')} disabled={sortMutation.isPending}>
        Sort by budget
      </Button>
    </>
  )

  return (
    <div>
      <PageHeader
        title="Fallback chain"
        description="Drag to reorder. Requests try models top-to-bottom until one succeeds."
        actions={view === 'chain' ? sortButtons : null}
      />

      <div className="space-y-6">
        <FallbackTabs value={view} onChange={setView} />

        {view === 'chain' && (
          <section id="fallback-panel-chain" role="tabpanel" aria-labelledby="fallback-tab-chain">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : noData ? (
              <div className="rounded-lg border border-dashed p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  No models available. Add API keys on the <a href="/keys" className="underline text-foreground">Keys page</a> first.
                </p>
              </div>
            ) : (
              <>
                <div className="rounded-lg border divide-y overflow-hidden">
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <SortableContext
                      items={displayEntries.map(e => e.modelDbId)}
                      strategy={verticalListSortingStrategy}
                    >
                      {displayEntries.map((entry, index) => (
                        <SortableModelRow
                          key={entry.modelDbId}
                          entry={entry}
                          index={index}
                          onToggle={handleToggle}
                        />
                      ))}
                    </SortableContext>
                  </DndContext>
                </div>

                {hasChanges && (
                  <div className="mt-3 flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setLocalEntries(null)}>
                      Discard
                    </Button>
                    <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>
                      {saveMutation.isPending ? 'Saving…' : 'Save order'}
                    </Button>
                  </div>
                )}

                {unconfiguredPlatforms.length > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Hidden (no keys): {unconfiguredPlatforms.join(', ')}
                  </p>
                )}
              </>
            )}
          </section>
        )}

        {view === 'health' && (
          <section id="fallback-panel-health" role="tabpanel" aria-labelledby="fallback-tab-health">
            {!isLoading && allEntries.length > 0 ? (
              <ModelHealthPanel
                entries={allEntries}
                onRetry={handleRetry}
                onEnable={(modelDbId) => handleToggle(modelDbId, true)}
                retryingId={retryingId}
                toggling={toggleMutation.isPending}
              />
            ) : isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                No model health data available yet.
              </p>
            )}
          </section>
        )}

        {view === 'budget' && (
          <section id="fallback-panel-budget" role="tabpanel" aria-labelledby="fallback-tab-budget">
            {hasTokenData ? <TokenUsageBar data={tokenUsage!} /> : (
              <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                No budget allocation data available for this period.
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  )
}

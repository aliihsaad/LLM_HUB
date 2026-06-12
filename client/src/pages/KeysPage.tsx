import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/page-header'
import { ProviderHelperLinks } from '@/components/provider-helper-links'
import { Badge } from '@/components/ui/badge'
import { Activity, Info, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import type { ApiKey, Platform, ProviderMetadata, ProvidersResponse } from '../../../shared/types'

const FALLBACK_PROVIDERS: ProviderMetadata[] = [
  { platform: 'google', displayName: 'Google AI Studio', docsUrl: '', apiBaseUrl: '', requiresKey: true },
  { platform: 'groq', displayName: 'Groq', docsUrl: '', apiBaseUrl: '', requiresKey: true },
  { platform: 'cerebras', displayName: 'Cerebras', docsUrl: '', apiBaseUrl: '', requiresKey: true },
  { platform: 'sambanova', displayName: 'SambaNova', docsUrl: '', apiBaseUrl: '', requiresKey: true },
  { platform: 'nvidia', displayName: 'NVIDIA NIM', docsUrl: '', apiBaseUrl: '', requiresKey: true },
  { platform: 'mistral', displayName: 'Mistral', docsUrl: '', apiBaseUrl: '', requiresKey: true },
  { platform: 'openrouter', displayName: 'OpenRouter', docsUrl: '', apiBaseUrl: '', requiresKey: true },
  { platform: 'github', displayName: 'GitHub Models', docsUrl: '', apiBaseUrl: '', requiresKey: true },
  { platform: 'cohere', displayName: 'Cohere', docsUrl: '', apiBaseUrl: '', requiresKey: true },
  { platform: 'cloudflare', displayName: 'Cloudflare Workers AI', docsUrl: '', apiBaseUrl: '', requiresKey: true },
  { platform: 'huggingface', displayName: 'Hugging Face Inference Providers', docsUrl: '', apiBaseUrl: '', requiresKey: true },
  { platform: 'vercel', displayName: 'Vercel AI Gateway', docsUrl: '', apiBaseUrl: '', requiresKey: true },
  { platform: 'modelscope', displayName: 'ModelScope API Inference', docsUrl: '', apiBaseUrl: '', requiresKey: true },
  { platform: 'qwen', displayName: 'Qwen Cloud / DashScope', docsUrl: '', apiBaseUrl: '', requiresKey: true },
  { platform: 'siliconflow', displayName: 'SiliconFlow', docsUrl: '', apiBaseUrl: '', requiresKey: true },
  { platform: 'ovhcloud', displayName: 'OVHcloud AI Endpoints', docsUrl: '', apiBaseUrl: '', requiresKey: true },
  { platform: 'zhipu', displayName: 'Zhipu AI', docsUrl: '', apiBaseUrl: '', requiresKey: true },
  { platform: 'ollama', displayName: 'Ollama Cloud', docsUrl: '', apiBaseUrl: '', requiresKey: true },
  { platform: 'kilo', displayName: 'Kilo Gateway', docsUrl: '', apiBaseUrl: '', requiresKey: false },
  { platform: 'pollinations', displayName: 'Pollinations', docsUrl: '', apiBaseUrl: '', requiresKey: false },
  { platform: 'llm7', displayName: 'LLM7', docsUrl: '', apiBaseUrl: '', requiresKey: false },
]

const statusDot: Record<string, string> = {
  healthy: 'bg-emerald-500',
  rate_limited: 'bg-amber-500',
  invalid: 'bg-rose-500',
  error: 'bg-rose-500',
  unknown: 'bg-muted-foreground/40',
}

const statusLabel: Record<string, string> = {
  healthy: 'healthy',
  rate_limited: 'rate-limited',
  invalid: 'invalid',
  error: 'error',
  unknown: 'unchecked',
}

interface HealthPlatform {
  platform: string
  totalKeys: number
  healthyKeys: number
  rateLimitedKeys: number
  invalidKeys: number
  errorKeys: number
  unknownKeys: number
}

interface HealthData {
  platforms: HealthPlatform[]
  keys: { id: number; platform: string; status: string; lastCheckedAt: string | null }[]
}

export default function KeysPage() {
  const queryClient = useQueryClient()
  const [platform, setPlatform] = useState<Platform | ''>('')
  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState('')
  const [label, setLabel] = useState('')

  const { data: keys = [], isLoading } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const { data: providersData } = useQuery<ProvidersResponse>({
    queryKey: ['models', 'providers'],
    queryFn: () => apiFetch('/api/models/providers'),
  })

  const { data: healthData } = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: () => apiFetch('/api/health'),
    refetchInterval: 30000,
  })

  const addKey = useMutation({
    mutationFn: (body: { platform: string; key: string; label?: string }) =>
      apiFetch('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setPlatform('')
      setApiKey('')
      setAccountId('')
      setLabel('')
    },
  })

  const deleteKey = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
  })

  const checkAll = useMutation({
    mutationFn: () => apiFetch('/api/health/check-all', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  const checkKey = useMutation({
    mutationFn: (keyId: number) => apiFetch(`/api/health/check/${keyId}`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  const needsAccountId = platform === 'cloudflare'

  const providers = providersData?.providers ?? FALLBACK_PROVIDERS
  const selectedProvider = platform ? providers.find(p => p.platform === platform) : undefined

  const grouped = providers.map(p => ({
    ...p,
    keys: keys.filter(k => k.platform === p.platform),
  })).filter(p => p.keys.length > 0)

  const keyByPlatform = new Map<string, HealthPlatform | undefined>()
  for (const k of healthData?.platforms ?? []) keyByPlatform.set(k.platform, k)

  const healthyCount = keyByPlatform.size
  const totalKeys = keys.length
  const platformWithKeys = grouped.length

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!platform || !apiKey) return
    if (needsAccountId && !accountId) return
    const key = needsAccountId ? `${accountId}:${apiKey}` : apiKey
    addKey.mutate({ platform, key, label: label || undefined })
  }

  return (
    <div className="w-full">
      <PageHeader
        title="Keys"
        description="Provider credentials, health checks, and key rotation."
        actions={
          keys.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => checkAll.mutate()} disabled={checkAll.isPending}>
              {checkAll.isPending ? 'Checking…' : 'Check all'}
            </Button>
          )
        }
      />

      <div className="grid gap-5 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md border border-border bg-card px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Keys</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{totalKeys}</p>
            </div>
            <div className="rounded-md border border-border bg-card px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Providers</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{platformWithKeys}</p>
            </div>
            <div className="rounded-md border border-border bg-card px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Health</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{healthyCount}</p>
            </div>
          </div>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <span className="flex size-8 items-center justify-center rounded-md border border-border bg-background/45 text-primary">
                  <Plus className="size-4" />
                </span>
                <div>
                  <CardTitle>Add credential</CardTitle>
                  <CardDescription>Unlock routing capacity by provider.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-md border border-border bg-background/35 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                <div className="flex items-start gap-2">
                  <Info className="mt-0.5 size-3.5 flex-shrink-0 text-foreground/70" aria-hidden="true" />
                  <p>Use separate provider accounts or projects when possible; same-account keys may still share upstream quota.</p>
                </div>
              </div>
              <form onSubmit={handleSubmit} className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Platform</Label>
                <Select value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map(p => (
                      <SelectItem key={p.platform} value={p.platform}>{p.displayName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedProvider && (
                  <ProviderHelperLinks provider={selectedProvider} className="mt-1" />
                )}
              </div>
              {needsAccountId && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Account ID</Label>
                  <Input
                    value={accountId}
                    onChange={e => setAccountId(e.target.value)}
                    placeholder="a1b2c3d4…"
                    className="w-full font-mono text-xs"
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-xs">{needsAccountId ? 'API token' : 'API key'}</Label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder={needsAccountId ? 'Bearer token' : 'paste key here'}
                  className="w-full font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Label</Label>
                <Input
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  placeholder="optional"
                />
              </div>
              <Button type="submit" size="sm" className="w-full" disabled={!platform || !apiKey || (needsAccountId && !accountId) || addKey.isPending}>
                <KeyRound className="size-3.5" />
                  {addKey.isPending ? 'Adding…' : 'Add key'}
              </Button>
              {addKey.isError && (
                <p className="text-destructive text-xs">{(addKey.error as Error).message}</p>
              )}
            </form>
            </CardContent>
          </Card>
        </aside>

        <section className="min-w-0 space-y-3">
          <div className="flex min-w-0 flex-col gap-1 border-b border-border pb-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Provider inventory</h2>
              <p className="text-xs text-muted-foreground">{keys.length === 0 ? 'No keys yet' : `${keys.length} total keys loaded across ${platformWithKeys} providers`}</p>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-emerald-500" />healthy</span>
              <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-amber-500" />limited</span>
              <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-rose-500" />error</span>
            </div>
          </div>

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : keys.length === 0 ? (
            <Card>
              <CardContent className="flex min-h-[20rem] items-center justify-center text-center text-sm text-muted-foreground">
                <div>
                  <ShieldCheck className="mx-auto mb-3 size-8 text-muted-foreground/60" />
                  No provider keys yet. Add one from the credential panel to start routing.
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3">
              {grouped.map(group => {
                const stats = keyByPlatform.get(group.platform)
                const healthy = stats?.healthyKeys ?? 0
                const problemCount = (stats?.rateLimitedKeys ?? 0) + (stats?.invalidKeys ?? 0) + (stats?.errorKeys ?? 0)
                return (
                  <Card key={group.platform}>
                    <CardHeader>
                      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                        <div className="min-w-0">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="flex size-8 items-center justify-center rounded-md border border-border bg-background/45 text-primary">
                              <Activity className="size-4" />
                            </span>
                            <CardTitle className="text-sm">{group.displayName}</CardTitle>
                            <ProviderHelperLinks provider={group} className="mt-0.5" />
                            <Badge variant={problemCount > 0 ? 'secondary' : 'outline'}>{problemCount > 0 ? `${problemCount} attention` : 'ready'}</Badge>
                          </div>
                          <p className="mt-2 text-xs text-muted-foreground tabular-nums">
                            {healthy}/{group.keys.length} healthy · {group.keys.length} keys · {stats?.unknownKeys ?? 0} unchecked
                          </p>
                        </div>
                        <div className="grid min-w-[14rem] grid-cols-3 overflow-hidden rounded-md border border-border text-center text-xs tabular-nums">
                          <div className="border-r border-border px-3 py-2">
                            <p className="text-muted-foreground">Healthy</p>
                            <p className="mt-1 font-semibold text-emerald-300">{healthy}</p>
                          </div>
                          <div className="border-r border-border px-3 py-2">
                            <p className="text-muted-foreground">Limited</p>
                            <p className="mt-1 font-semibold text-amber-300">{stats?.rateLimitedKeys ?? 0}</p>
                          </div>
                          <div className="px-3 py-2">
                            <p className="text-muted-foreground">Invalid</p>
                            <p className="mt-1 font-semibold text-rose-300">{(stats?.invalidKeys ?? 0) + (stats?.errorKeys ?? 0)}</p>
                          </div>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="px-3 pb-3 pt-0">
                      <div className="overflow-hidden rounded-md border border-border">
                        {group.keys.map(k => {
                          const h = healthData?.keys?.find(item => item.id === k.id)
                          const status = h?.status ?? k.status
                          const lastChecked = h?.lastCheckedAt
                          return (
                            <div key={k.id} className="grid gap-3 border-b border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/35 md:grid-cols-[auto_10rem_minmax(0,1fr)_auto_auto] md:items-center">
                              <span className={`size-1.5 rounded-full flex-shrink-0 ${statusDot[status] ?? statusDot.unknown}`} />
                              <code className="text-xs font-mono">{k.maskedKey}</code>
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge variant="outline" className="h-5 text-[10px]">{statusLabel[status] ?? status}</Badge>
                                  {k.label && <span className="truncate text-xs text-muted-foreground">{k.label}</span>}
                                </div>
                                {lastChecked && (
                                  <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                                    checked {new Date(lastChecked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                  </p>
                                )}
                              </div>
                              <Button variant="outline" size="xs" onClick={() => checkKey.mutate(k.id)} disabled={checkKey.isPending}>
                                Check
                              </Button>
                              <Button
                                variant="outline"
                                size="icon-xs"
                                className="text-muted-foreground hover:text-destructive"
                                onClick={() => deleteKey.mutate(k.id)}
                                disabled={deleteKey.isPending}
                                aria-label="Remove key"
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </div>
                          )
                        })}
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

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
import { Info } from 'lucide-react'
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

  const addState = isLoading && keys.length === 0 ? 'initial' : 'ready'

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
    <div>
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

      <div className="space-y-8">
        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardContent className="px-3 py-3">
              <p className="text-xs text-muted-foreground">Total keys</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{totalKeys}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="px-3 py-3">
              <p className="text-xs text-muted-foreground">Configured providers</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{platformWithKeys}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="px-3 py-3">
              <p className="text-xs text-muted-foreground">Health coverage</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{healthyCount}</p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Add a provider key</CardTitle>
            <CardDescription>Add credentials by platform to unlock provider routing and failover.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border bg-muted/25 px-3 py-2.5 text-xs text-muted-foreground">
              <div className="flex items-start gap-2">
                <Info className="mt-0.5 size-3.5 flex-shrink-0 text-foreground/70" aria-hidden="true" />
                <p>
                  For higher usable quota, add keys from separate provider accounts or projects. Keys from the same account may still share provider-side limits even if this proxy rotates and tracks them separately.
                </p>
              </div>
            </div>
            <form onSubmit={handleSubmit} className="grid gap-3 lg:grid-cols-2">
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
              <div className="space-y-1.5 lg:col-span-2">
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
              <div className="flex items-end lg:justify-end">
                <Button type="submit" size="sm" disabled={!platform || !apiKey || (needsAccountId && !accountId) || addKey.isPending}>
                  {addKey.isPending ? 'Adding…' : 'Add key'}
                </Button>
              </div>
              {addKey.isError && (
                <p className="text-destructive text-xs col-span-full">{(addKey.error as Error).message}</p>
              )}
            </form>
          </CardContent>
        </Card>

        <div className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle>Configured providers</CardTitle>
              <CardDescription>{keys.length === 0 ? 'No keys yet' : `${keys.length} total keys loaded`}</CardDescription>
            </CardHeader>
          </Card>

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : keys.length === 0 ? (
            <Card>
              <CardContent className="text-sm text-muted-foreground">
                No provider keys yet. Add one above to start routing.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {grouped.map(group => {
                const stats = keyByPlatform.get(group.platform)
                const healthy = stats?.healthyKeys ?? 0
                return (
                  <Card key={group.platform}>
                    <CardHeader>
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <CardTitle className="text-sm">{group.displayName}</CardTitle>
                            <ProviderHelperLinks provider={group} className="mt-0.5" />
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {healthy}/{group.keys.length} healthy · {group.keys.length} keys
                          </p>
                        </div>
                        <Badge variant={healthy === group.keys.length ? 'outline' : 'secondary'}>
                          {addState === 'initial' ? 'Ready' : `${group.keys.length} key${group.keys.length === 1 ? '' : 's'}`}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="px-3 pb-3 pt-0">
                      <div className="rounded-lg border divide-y overflow-hidden">
                        {group.keys.map(k => {
                          const h = healthData?.keys?.find(item => item.id === k.id)
                          const status = h?.status ?? k.status
                          const lastChecked = h?.lastCheckedAt
                          return (
                            <div key={k.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
                              <span className={`size-1.5 rounded-full flex-shrink-0 ${statusDot[status] ?? statusDot.unknown}`} />
                              <code className="text-xs font-mono flex-shrink-0">{k.maskedKey}</code>
                              {k.label && <span className="text-xs text-muted-foreground">{k.label}</span>}
                              <Badge variant="outline" className="h-5 text-[10px]">{statusLabel[status] ?? status}</Badge>
                              {lastChecked && (
                                <span className="text-[11px] text-muted-foreground tabular-nums ml-auto">
                                  {new Date(lastChecked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </span>
                              )}
                              <Button variant="outline" size="xs" onClick={() => checkKey.mutate(k.id)} disabled={checkKey.isPending}>
                                Check
                              </Button>
                              <Button
                                variant="outline"
                                size="xs"
                                className="text-muted-foreground hover:text-destructive"
                                onClick={() => deleteKey.mutate(k.id)}
                                disabled={deleteKey.isPending}
                              >
                                Remove
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
        </div>
      </div>
    </div>
  )
}

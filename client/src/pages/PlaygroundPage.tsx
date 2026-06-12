import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FlaskConical, MessageSquare, RefreshCw } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/page-header'
import { PlaygroundChatPanel } from '@/components/playground-chat-panel'
import { RealtimeSessionPanel } from '@/components/realtime-session-panel'
import { cn } from '@/lib/utils'
import {
  getConfiguredProviderCount,
  getPlaygroundMode,
  getSupportedModelCount,
  isPlaygroundModeConfigured,
  PLAYGROUND_MODES,
  type PlaygroundCapabilityMode,
} from '../../../shared/playground'
import type { CapabilitiesResponse, ModelSweepJob } from '../../../shared/types'

interface FallbackEntry {
  modelDbId: number
  priority: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  sizeLabel: string
  keyCount: number
  runtimeStatus?: 'healthy' | 'degraded' | 'unavailable'
}

interface CatalogModelEntry {
  modelDbId: number
  id?: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  keyCount: number
  capabilities?: string[]
}

interface PlaygroundResult {
  id: number
  mode: PlaygroundCapabilityMode
  title: string
  content: string
  status: 'success' | 'error'
  meta?: {
    platform?: string
    model?: string
    latency?: number
    endpoint?: string
    fallbackAttempts?: number
  }
  imageSrc?: string
  audioSrc?: string
  raw?: unknown
}

type PlaygroundSurface = 'chat' | 'test-lab'

const defaultPrompt: Record<PlaygroundCapabilityMode, string> = {
  chat: 'Explain what this LLM-Hub proxy can do in two short sentences.',
  gemini_generate: 'Explain this Gemini-compatible route in one sentence.',
  gemini_stream: 'Stream a short answer from the Gemini-compatible route.',
  vision: 'What is shown in this image?',
  embeddings: 'LLM-Hub routes embeddings through configured providers.',
  image_generation: 'A clean black-and-white app icon for a local AI gateway dashboard.',
  image_edit: 'Replace the background with a clean white studio backdrop.',
  image_variation: 'Create a clean visual variation of this image.',
  speech: 'LLM-Hub speech routing is working.',
  transcription: '',
  translation: '',
  realtime: 'You are concise and helpful.',
}

const responseFormatOptions = ['json', 'text', 'verbose_json'] as const

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2)
}

function isGeminiMode(mode: PlaygroundCapabilityMode) {
  return mode === 'gemini_generate' || mode === 'gemini_stream'
}

function geminiEndpointFor(mode: PlaygroundCapabilityMode, modelOverride: string) {
  const model = modelOverride.trim() || 'gemini-2.5-flash'
  const action = mode === 'gemini_stream' ? 'streamGenerateContent' : 'generateContent'
  return `/gemini/v1beta/models/${encodeURIComponent(model)}:${action}`
}

function geminiTextFromCandidate(data: any) {
  const parts = data?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return undefined
  const text = parts.map(part => part?.text).filter(Boolean).join('')
  return text || undefined
}

function geminiStreamSummary(raw: string) {
  const lines = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(line => line && line !== '[DONE]')

  const text = lines
    .map(line => {
      try {
        return geminiTextFromCandidate(JSON.parse(line))
      } catch {
        return undefined
      }
    })
    .filter(Boolean)
    .join('')

  return text || raw.slice(0, 2000) || 'Stream completed without text output.'
}

function errorMessageFromBody(body: any): string {
  const error = body?.error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') return error.message ?? JSON.stringify(error)
  return 'Provider returned an error response.'
}

function routedViaFrom(res: Response, data: any) {
  const header = res.headers.get('X-Routed-Via')
  const via = data?._routed_via ?? (header ? {
    platform: header.split('/')[0],
    model: header.split('/').slice(1).join('/'),
  } : undefined)

  return {
    platform: via?.platform,
    model: via?.model,
  }
}

function modeStatus(data: CapabilitiesResponse | undefined, mode: PlaygroundCapabilityMode) {
  const configured = isPlaygroundModeConfigured(data, mode)
  const supportedModels = getSupportedModelCount(data, mode)
  if (configured) return 'configured'
  if (supportedModels > 0) return 'missing_key'
  return 'unsupported'
}

function formatDuration(ms: number | null | undefined) {
  if (ms == null) return 'calculating'
  if (ms < 1000) return '<1s'
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
}

export default function PlaygroundPage() {
  const queryClient = useQueryClient()
  const [surface, setSurface] = useState<PlaygroundSurface>('chat')
  const [mode, setMode] = useState<PlaygroundCapabilityMode>('chat')
  const [selectedModel, setSelectedModel] = useState<string>('auto')
  const [modelOverride, setModelOverride] = useState('')
  const [prompt, setPrompt] = useState(defaultPrompt.chat)
  const [imageUrl, setImageUrl] = useState('')
  const [visionFileName, setVisionFileName] = useState('')
  const [voice, setVoice] = useState('alloy')
  const [speechFormat, setSpeechFormat] = useState('wav')
  const [audioTextFormat, setAudioTextFormat] = useState<(typeof responseFormatOptions)[number]>('json')
  const [language, setLanguage] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [maskFile, setMaskFile] = useState<File | null>(null)
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [audioUrl, setAudioUrl] = useState('')
  const [results, setResults] = useState<PlaygroundResult[]>([])
  const [loading, setLoading] = useState(false)
  const [sweepId, setSweepId] = useState<string | null>(null)
  const [sweepStarting, setSweepStarting] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const fallbackQuery = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })
  const fallbackEntries = fallbackQuery.data ?? []

  const capabilityQuery = useQuery<CapabilitiesResponse>({
    queryKey: ['models', 'capabilities'],
    queryFn: () => apiFetch('/api/models/capabilities'),
  })
  const capabilityData = capabilityQuery.data

  const modelCatalogQuery = useQuery<CatalogModelEntry[]>({
    queryKey: ['models', 'catalog'],
    queryFn: () => apiFetch('/api/models'),
  })
  const modelCatalog = modelCatalogQuery.data ?? []

  const sweepQuery = useQuery<ModelSweepJob>({
    queryKey: ['model-sweep', sweepId],
    enabled: Boolean(sweepId),
    queryFn: () => apiFetch(`/api/model-sweeps/${sweepId}`),
    refetchInterval: query => query.state.data?.status === 'running' ? 1000 : false,
  })
  const sweepJob = sweepQuery.data

  const availableModels = fallbackEntries.filter(e => e.keyCount > 0 && e.enabled && e.runtimeStatus !== 'unavailable')
  const realtimeModels = useMemo(
    () => modelCatalog
      .filter(model => model.enabled && model.keyCount > 0 && model.capabilities?.includes('realtime_audio'))
      .map(model => ({
        modelDbId: model.modelDbId ?? model.id ?? 0,
        platform: model.platform,
        modelId: model.modelId,
        displayName: model.displayName,
        keyCount: model.keyCount,
        capabilities: model.capabilities,
      })),
    [modelCatalog],
  )
  const definition = getPlaygroundMode(mode)
  const configuredProviders = getConfiguredProviderCount(capabilityData, mode)
  const supportedModels = getSupportedModelCount(capabilityData, mode)
  const currentStatus = modeStatus(capabilityData, mode)
  const lastResult = results[0]
  const sweepRunning = sweepJob?.status === 'running'
  const sweepProgressPercent = sweepJob && sweepJob.total > 0
    ? Math.round((sweepJob.completed / sweepJob.total) * 100)
    : 0
  const sweepFailures = sweepJob?.results.filter(result => result.status === 'failed').slice(-4).reverse() ?? []
  const activeChatModelLabel = selectedModel === 'auto'
    ? 'Auto (fallback chain)'
    : availableModels.find(m => m.modelId === selectedModel)?.displayName ?? selectedModel
  const activeRealtimeModelLabel = modelOverride.trim()
    ? realtimeModels.find(model => model.modelId === modelOverride.trim())?.displayName ?? modelOverride.trim()
    : 'Auto (verified realtime default)'
  const endpoint = isGeminiMode(mode) ? geminiEndpointFor(mode, modelOverride) : definition.endpoint

  const activeModel = useMemo(() => {
    if (mode === 'chat' && selectedModel !== 'auto') return selectedModel
    if (isGeminiMode(mode)) return undefined
    return modelOverride.trim() || undefined
  }, [mode, modelOverride, selectedModel])

  useEffect(() => {
    setPrompt(defaultPrompt[mode])
    setModelOverride('')
    setSelectedModel('auto')
    inputRef.current?.focus()
  }, [mode])

  useEffect(() => {
    return () => {
      for (const result of results) {
        if (result.audioSrc) URL.revokeObjectURL(result.audioSrc)
      }
    }
  }, [results])

  useEffect(() => {
    if (sweepJob?.status !== 'completed') return
    void fallbackQuery.refetch()
    void capabilityQuery.refetch()
  }, [sweepJob?.id, sweepJob?.status])

  async function startSweep() {
    if (sweepStarting || sweepRunning) return

    setSweepStarting(true)
    try {
      const job = await apiFetch<ModelSweepJob>('/api/model-sweeps', { method: 'POST' })
      queryClient.setQueryData(['model-sweep', job.id], job)
      setSweepId(job.id)
    } catch (error: any) {
      pushResult({
        mode,
        title: 'Model sweep failed',
        content: error.message,
        status: 'error',
        meta: { endpoint: '/api/model-sweeps' },
      })
    } finally {
      setSweepStarting(false)
    }
  }

  async function execute() {
    if (loading) return

    const headers: Record<string, string> = {}
    if (keyData?.apiKey) headers.Authorization = `Bearer ${keyData.apiKey}`

    let init: RequestInit
    try {
      init = buildRequest(headers)
    } catch (error: any) {
      pushResult({
        mode,
        title: 'Input required',
        content: error.message,
        status: 'error',
        meta: { endpoint },
      })
      return
    }

    setLoading(true)
    const start = Date.now()
    try {
      const res = await fetch(endpoint, init)
      const latency = Date.now() - start
      const fallbackAttempts = res.headers.get('X-Fallback-Attempts')

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        pushResult({
          mode,
          title: `${definition.label} failed`,
          content: body?.error?.message ?? `HTTP ${res.status}`,
          status: 'error',
          meta: { endpoint, latency },
          raw: body,
        })
        return
      }

      if (mode === 'speech') {
        const blob = await res.blob()
        const audioSrc = URL.createObjectURL(blob)
        pushResult({
          mode,
          title: 'Speech audio generated',
          content: `${blob.type || 'audio'} · ${Math.round(blob.size / 1024)} KB`,
          status: 'success',
          meta: { endpoint, latency, fallbackAttempts: fallbackAttempts ? Number(fallbackAttempts) : undefined },
          audioSrc,
        })
        return
      }

      if (mode === 'gemini_stream') {
        const raw = await res.text()
        const routed = routedViaFrom(res, null)
        pushResult({
          mode,
          title: successTitle(null),
          content: geminiStreamSummary(raw),
          status: 'success',
          meta: {
            endpoint,
            latency,
            platform: routed.platform,
            model: routed.model,
            fallbackAttempts: fallbackAttempts ? Number(fallbackAttempts) : undefined,
          },
          raw,
        })
        return
      }

      const data = await res.json()
      const routed = routedViaFrom(res, data)
      if (data?.error) {
        pushResult({
          mode,
          title: `${definition.label} failed`,
          content: errorMessageFromBody(data),
          status: 'error',
          meta: {
            endpoint,
            latency,
            platform: routed.platform,
            model: routed.model,
            fallbackAttempts: fallbackAttempts ? Number(fallbackAttempts) : undefined,
          },
          raw: data,
        })
        return
      }

      pushResult({
        mode,
        title: successTitle(data),
        content: resultSummary(data),
        status: 'success',
        meta: {
          endpoint,
          latency,
          platform: routed.platform,
          model: routed.model,
          fallbackAttempts: fallbackAttempts ? Number(fallbackAttempts) : undefined,
        },
        imageSrc: imageSrcFrom(data),
        raw: data,
      })
    } catch (error: any) {
      pushResult({
        mode,
        title: `${definition.label} failed`,
        content: error.message,
        status: 'error',
        meta: { endpoint },
      })
    } finally {
      setLoading(false)
    }
  }

  function pushResult(result: Omit<PlaygroundResult, 'id'>) {
    setResults(current => [{ id: Date.now(), ...result }, ...current].slice(0, 8))
  }

  function buildRequest(headers: Record<string, string>): RequestInit {
    if (definition.requestKind === 'multipart') {
      const form = new FormData()
      if (activeModel) form.append('model', activeModel)

      if (mode === 'image_edit') {
        if (!imageFile) throw new Error('Choose an image file to edit.')
        if (!prompt.trim()) throw new Error('Enter an edit prompt.')
        form.append('image', imageFile)
        if (maskFile) form.append('mask', maskFile)
        form.append('prompt', prompt.trim())
        form.append('response_format', 'b64_json')
      } else if (mode === 'image_variation') {
        if (!imageFile) throw new Error('Choose an image file for variation.')
        form.append('image', imageFile)
        form.append('response_format', 'b64_json')
      } else if (mode === 'transcription' || mode === 'translation') {
        if (audioFile) form.append('file', audioFile)
        if (audioUrl.trim()) form.append('url', audioUrl.trim())
        if (!audioFile && !audioUrl.trim()) throw new Error('Choose an audio file or provide an audio URL.')
        if (prompt.trim()) form.append('prompt', prompt.trim())
        form.append('response_format', audioTextFormat)
        if (mode === 'transcription' && language.trim()) form.append('language', language.trim())
      }

      return { method: 'POST', headers, body: form }
    }

    const body: Record<string, unknown> = {}
    if (isGeminiMode(mode)) {
      if (!prompt.trim()) throw new Error('Enter a Gemini prompt.')
      body.contents = [{ role: 'user', parts: [{ text: prompt.trim() }] }]

      return {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    }

    if (activeModel) body.model = activeModel

    if (mode === 'chat') {
      if (!prompt.trim()) throw new Error('Enter a chat message.')
      body.messages = [{ role: 'user', content: prompt.trim() }]
    } else if (mode === 'vision') {
      if (!prompt.trim()) throw new Error('Enter a vision prompt.')
      if (!imageUrl.trim()) throw new Error('Provide a local image, data URL, or remote http(s) image URL.')
      body.messages = [{
        role: 'user',
        content: [
          { type: 'text', text: prompt.trim() },
          { type: 'image_url', image_url: { url: imageUrl.trim() } },
        ],
      }]
    } else if (mode === 'embeddings') {
      if (!prompt.trim()) throw new Error('Enter text to embed.')
      body.input = prompt.trim()
    } else if (mode === 'image_generation') {
      if (!prompt.trim()) throw new Error('Enter an image prompt.')
      body.prompt = prompt.trim()
      body.response_format = 'b64_json'
      body.size = '1024x1024'
    } else if (mode === 'speech') {
      if (!prompt.trim()) throw new Error('Enter text for speech.')
      body.input = prompt.trim()
      body.voice = voice.trim() || 'alloy'
      body.response_format = speechFormat
    } else if (mode === 'realtime') {
      body.instructions = prompt.trim() || defaultPrompt.realtime
      body.voice = voice.trim() || 'alloy'
      body.response_modalities = ['AUDIO']
      body.input_audio_transcription = true
      body.output_audio_transcription = true
    }

    return {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  }

  function successTitle(data: any) {
    if (mode === 'gemini_generate') return 'Gemini response received'
    if (mode === 'gemini_stream') return 'Gemini stream received'
    if (mode === 'embeddings') return `Embedding returned ${data.data?.[0]?.embedding?.length ?? 0} dimensions`
    if (mode === 'image_generation') return 'Image generated'
    if (mode === 'image_edit') return 'Image edit generated'
    if (mode === 'image_variation') return 'Image variation generated'
    if (mode === 'realtime') return 'Realtime session minted'
    if (mode === 'transcription') return 'Transcription completed'
    if (mode === 'translation') return 'Translation completed'
    return 'Response received'
  }

  function resultSummary(data: any) {
    if (mode === 'gemini_generate') {
      return geminiTextFromCandidate(data) ?? formatJson(data)
    }
    if (mode === 'chat' || mode === 'vision') {
      return data.choices?.[0]?.message?.content ?? formatJson(data)
    }
    if (mode === 'embeddings') {
      const embedding = data.data?.[0]?.embedding
      return `model=${data.model ?? 'unknown'}; dimensions=${Array.isArray(embedding) ? embedding.length : 'base64'}; tokens=${data.usage?.total_tokens ?? '-'}`
    }
    if (mode === 'realtime') {
      return `expires_at=${new Date((data.expires_at ?? 0) * 1000).toLocaleString()}\nconnect_url=${data.connect_url}\nclient_secret=${data.client_secret?.value ? data.client_secret.value.slice(0, 16) + '...' : '-'}`
    }
    if (mode === 'transcription' || mode === 'translation') {
      return typeof data.text === 'string' ? data.text : formatJson(data)
    }
    return data.data?.[0]?.revised_prompt ?? 'Open the image preview or raw JSON below.'
  }

  function imageSrcFrom(data: any) {
    const item = data.data?.[0]
    if (item?.url) return item.url
    if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`
    return undefined
  }

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Could not read image file.'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image file.'))
    reader.readAsDataURL(file)
  })
}
  async function loadVisionFile(file: File | null) {
    if (!file) {
      setVisionFileName('')
      return
    }
    if (!file.type.startsWith('image/')) {
      pushResult({
        mode: 'vision',
        title: 'Input required',
        content: 'Vision currently accepts local image files only.',
        status: 'error',
        meta: { endpoint: '/v1/chat/completions' },
      })
      return
    }
    try {
      const dataUrl = await fileToDataUrl(file)
      setImageUrl(dataUrl)
      setVisionFileName(file.name)
    } catch (error: any) {
      pushResult({
        mode: 'vision',
        title: 'Input required',
        content: error.message ?? 'Could not read image file.',
        status: 'error',
        meta: { endpoint: '/v1/chat/completions' },
      })
    }
  }
  const statusDot = currentStatus === 'configured'
    ? 'bg-emerald-500'
    : currentStatus === 'missing_key'
      ? 'bg-amber-500'
      : 'bg-muted-foreground/25'

  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col">
      <PageHeader
        title="Playground"
        description="Use live capabilities in Chat or run endpoint diagnostics in Test Lab."
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {mode === 'chat' && (
              <Select value={selectedModel} onValueChange={(v) => setSelectedModel(v ?? 'auto')}>
                <SelectTrigger className="w-[260px]">
                  <span className="truncate">{activeChatModelLabel}</span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto (fallback chain)</SelectItem>
                  {availableModels.map(m => (
                    <SelectItem key={m.modelDbId} value={m.modelId}>
                      <span className="flex items-center gap-2">
                        <span>{m.displayName}</span>
                        <span className="text-xs text-muted-foreground">{m.platform}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              variant="outline"
              onClick={startSweep}
              disabled={sweepStarting || sweepRunning}
              className="gap-2"
            >
              <RefreshCw className={cn('size-4', (sweepStarting || sweepRunning) && 'animate-spin')} />
              {sweepRunning ? 'Testing models...' : 'Test all models'}
            </Button>
          </div>
        }
      />

      <div className="mb-4 grid gap-3 rounded-lg border border-border bg-card p-3 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-center">
        <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-background/35 p-1">
          <button
            type="button"
            onClick={() => setSurface('chat')}
            className={cn(
              'inline-flex h-9 items-center justify-center gap-2 rounded-sm px-4 text-sm font-medium transition-colors',
              surface === 'chat' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            <MessageSquare className="size-4" />
            Chat
          </button>
          <button
            type="button"
            onClick={() => setSurface('test-lab')}
            className={cn(
              'inline-flex h-9 items-center justify-center gap-2 rounded-sm px-4 text-sm font-medium transition-colors',
              surface === 'test-lab' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            <FlaskConical className="size-4" />
            Test Lab
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-md border border-border bg-background/35 px-3 py-2">
            <p className="text-muted-foreground">Chat routes</p>
            <p className="mt-1 font-semibold tabular-nums text-foreground">{availableModels.length}</p>
          </div>
          <div className="rounded-md border border-border bg-background/35 px-3 py-2">
            <p className="text-muted-foreground">Realtime</p>
            <p className="mt-1 font-semibold tabular-nums text-foreground">{realtimeModels.length}</p>
          </div>
          <div className="rounded-md border border-border bg-background/35 px-3 py-2">
            <p className="text-muted-foreground">Capability</p>
            <p className="mt-1 truncate font-semibold text-foreground">{definition.label}</p>
          </div>
        </div>
      </div>

      {surface === 'chat' ? (
        <div className="rounded-lg border border-border bg-card p-3">
          <PlaygroundChatPanel
            apiKey={keyData?.apiKey}
            models={availableModels}
            realtimeModels={realtimeModels}
            capabilityData={capabilityData}
          />
        </div>
      ) : (
        <div className="grid min-h-0 gap-4 xl:grid-cols-[16rem_minmax(0,1fr)]">
          <aside className="min-w-0 xl:sticky xl:top-20 xl:self-start">
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold">Capabilities</h2>
                  <p className="text-xs text-muted-foreground">Pick an endpoint surface.</p>
                </div>
                <Badge variant="outline">{PLAYGROUND_MODES.length}</Badge>
              </div>
          <div className="grid gap-1">
            {PLAYGROUND_MODES.map(item => {
              const status = modeStatus(capabilityData, item.id)
              const active = item.id === mode
              const supported = getSupportedModelCount(capabilityData, item.id)
              const configured = getConfiguredProviderCount(capabilityData, item.id)
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setMode(item.id)}
                  className={cn(
                    'rounded-md border px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-muted/45',
                    active ? 'border-primary/55 bg-primary/12' : 'border-transparent bg-transparent',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      'size-2 rounded-full',
                      status === 'configured' ? 'bg-emerald-500' : status === 'missing_key' ? 'bg-amber-500' : 'bg-muted-foreground/25',
                    )} />
                    <span className="truncate text-xs font-medium">{item.label}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                    {configured}/{supported} routable
                  </div>
                </button>
              )
            })}
              </div>
            </div>
          </aside>

          <section className="min-w-0">

      {sweepJob && (
        <Card className="mb-4">
          <CardContent className="space-y-0 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-medium">Model sweep</h2>
                  <Badge variant={sweepJob.status === 'completed' ? 'default' : sweepJob.status === 'failed' ? 'destructive' : 'outline'}>
                    {sweepJob.status}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{sweepJob.note}</p>
                {sweepJob.currentModel && (
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    current: {sweepJob.currentModel}
                  </p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-right text-xs tabular-nums md:grid-cols-4">
                <span className="text-muted-foreground">Progress</span>
                <span>{sweepJob.completed}/{sweepJob.total}</span>
                <span className="text-muted-foreground">Passed</span>
                <span>{sweepJob.passed}</span>
                <span className="text-muted-foreground">Quarantined</span>
                <span>{sweepJob.quarantined}</span>
                <span className="text-muted-foreground">ETA</span>
                <span>{formatDuration(sweepJob.estimatedRemainingMs)}</span>
              </div>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: `${sweepProgressPercent}%` }}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 border-t px-4 pb-4 pt-2 text-xs text-muted-foreground">
              <span>{sweepProgressPercent}% complete</span>
              <span>elapsed {formatDuration(sweepJob.elapsedMs)}</span>
              <span>{sweepJob.failed} failed</span>
            </div>
            {sweepFailures.length > 0 && (
              <div className="space-y-2 border-t pt-3 px-4 pb-4">
                <h3 className="text-xs font-medium text-muted-foreground">Recent failures</h3>
                {sweepFailures.map(result => (
                  <div key={`${result.modelDbId}-${result.status}`} className="flex flex-wrap items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-xs">
                    <Badge variant="destructive">{result.errorCategory ?? 'error'}</Badge>
                    <span className="font-medium">{result.providerDisplayName}</span>
                    <code className="break-all text-muted-foreground">{result.modelId}</code>
                    <span className="min-w-0 break-words text-muted-foreground">{result.error}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid flex-1 min-h-0 gap-4 lg:grid-cols-[24rem_minmax(0,1fr)]">
        <Card className="min-w-0">
          <CardContent className="space-y-0 p-4">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">{definition.label}</h2>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{endpoint}</p>
            </div>
            <Badge variant={currentStatus === 'configured' ? 'default' : 'outline'} className="gap-1">
              <span className={cn('size-1.5 rounded-full', statusDot)} />
              {configuredProviders}/{supportedModels}
            </Badge>
          </div>

          <div className="space-y-4">
            {mode === 'realtime' ? (
              <div className="space-y-1.5">
                <Label className="text-xs">Realtime model</Label>
                <Select
                  value={modelOverride.trim() || 'auto'}
                  onValueChange={(value) => setModelOverride(value === 'auto' ? '' : value ?? '')}
                >
                  <SelectTrigger className="w-full min-w-0">
                    <span className="truncate">{activeRealtimeModelLabel}</span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto (verified realtime default)</SelectItem>
                    {realtimeModels.map(model => (
                      <SelectItem key={`${model.platform}-${model.modelDbId}`} value={model.modelId}>
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate">{model.displayName}</span>
                          <span className="text-xs text-muted-foreground">{model.platform}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : mode !== 'chat' && (
              <div className="space-y-1.5">
                <Label className="text-xs">{isGeminiMode(mode) ? 'Gemini model path' : 'Model override'}</Label>
                <Input
                  value={modelOverride}
                  onChange={e => setModelOverride(e.target.value)}
                  placeholder={isGeminiMode(mode) ? 'gemini-2.5-flash' : 'auto'}
                  className="font-mono text-xs"
                />
              </div>
            )}

            {mode !== 'image_variation' && (
              <div className="space-y-1.5">
                <Label className="text-xs">
                  {mode === 'embeddings' ? 'Text' : mode === 'realtime' ? 'Instructions' : 'Prompt'}
                </Label>
                <Textarea
                  ref={inputRef}
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  rows={mode === 'speech' || mode === 'embeddings' ? 4 : 5}
                  className="text-sm"
                />
              </div>
            )}

            {mode === 'vision' && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Local image</Label>
                  <Input type="file" accept="image/*" onChange={e => void loadVisionFile(e.target.files?.[0] ?? null)} />
                  {visionFileName && <p className="truncate text-xs text-muted-foreground">Loaded {visionFileName}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Image URL</Label>
                  <Input
                    value={visionFileName && imageUrl.startsWith('data:') ? '' : imageUrl}
                    onChange={e => {
                      setImageUrl(e.target.value)
                      setVisionFileName('')
                    }}
                    placeholder={visionFileName ? 'Local image loaded; paste a URL to replace it.' : 'https://... or data:image/png;base64,...'}
                    className="font-mono text-xs"
                  />
                </div>
              </div>
            )}

            {(mode === 'image_edit' || mode === 'image_variation') && (
              <div className="space-y-1.5">
                <Label className="text-xs">Image file</Label>
                <Input type="file" accept="image/*" onChange={e => setImageFile(e.target.files?.[0] ?? null)} />
              </div>
            )}

            {mode === 'image_edit' && (
              <div className="space-y-1.5">
                <Label className="text-xs">Mask file</Label>
                <Input type="file" accept="image/*" onChange={e => setMaskFile(e.target.files?.[0] ?? null)} />
              </div>
            )}

            {(mode === 'speech' || mode === 'realtime') && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Voice</Label>
                  <Input value={voice} onChange={e => setVoice(e.target.value)} />
                </div>
                {mode === 'speech' && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Format</Label>
                    <Select value={speechFormat} onValueChange={(v) => setSpeechFormat(v ?? 'wav')}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="wav">wav</SelectItem>
                        <SelectItem value="pcm">pcm</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}

            {(mode === 'transcription' || mode === 'translation') && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs">Audio file</Label>
                  <Input type="file" accept="audio/*" onChange={e => setAudioFile(e.target.files?.[0] ?? null)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Audio URL</Label>
                  <Input
                    value={audioUrl}
                    onChange={e => setAudioUrl(e.target.value)}
                    placeholder="https://..."
                    className="font-mono text-xs"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Response</Label>
                    <Select value={audioTextFormat} onValueChange={(v) => setAudioTextFormat(v as typeof audioTextFormat)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {responseFormatOptions.map(format => (
                          <SelectItem key={format} value={format}>{format}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {mode === 'transcription' && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">Language</Label>
                      <Input value={language} onChange={e => setLanguage(e.target.value)} placeholder="en" />
                    </div>
                  )}
                </div>
              </>
            )}

            {mode !== 'realtime' && (
              <div className="flex items-center gap-2 pt-1">
                <Button onClick={execute} disabled={loading}>
                  {loading ? 'Testing...' : `Test ${definition.label}`}
                </Button>
                {results.length > 0 && (
                  <Button variant="outline" onClick={() => setResults([])} disabled={loading}>
                    Clear
                  </Button>
                )}
              </div>
            )}
          </div>
          </CardContent>
        </Card>

        {mode === 'realtime' ? (
          <Card className="flex min-h-[520px] min-w-0 flex-col overflow-hidden">
            <RealtimeSessionPanel
              apiKey={keyData?.apiKey}
              model={activeModel}
              instructions={prompt}
              voice={voice}
            />
          </Card>
        ) : (
          <Card className="flex min-h-[520px] min-w-0 flex-col overflow-hidden">
            <div className="border-b px-4 py-3">
              <h2 className="text-sm font-medium">Result</h2>
            </div>
            <div className="min-w-0 flex-1 overflow-y-auto p-4">
              {!lastResult ? (
                <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
                  Pick a capability, fill the required inputs, and run a request.
                </div>
              ) : (
                <div className="min-w-0 space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={lastResult.status === 'success' ? 'default' : 'destructive'}>{lastResult.status}</Badge>
                    <span className="text-sm font-medium">{lastResult.title}</span>
                    {lastResult.meta?.platform && <Badge variant="outline">{lastResult.meta.platform}</Badge>}
                    {lastResult.meta?.model && <code className="break-all text-xs text-muted-foreground">{lastResult.meta.model}</code>}
                    {lastResult.meta?.latency != null && <span className="text-xs text-muted-foreground tabular-nums">{lastResult.meta.latency} ms</span>}
                  </div>

                  <pre className="max-h-[220px] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background/55 p-3 text-xs leading-relaxed">
                    {lastResult.content}
                  </pre>

                  {lastResult.imageSrc && (
                    <div className="overflow-hidden rounded-md border border-border bg-background/55">
                      <img src={lastResult.imageSrc} alt="Generated result" className="max-h-[420px] w-full object-contain" />
                    </div>
                  )}

                  {lastResult.audioSrc && (
                    <audio controls src={lastResult.audioSrc} className="w-full" />
                  )}

                  {lastResult.raw != null && (
                    <details className="min-w-0 overflow-hidden rounded-md border border-border bg-background/55">
                      <summary className="cursor-pointer px-3 py-2 text-xs font-medium">Raw JSON</summary>
                      <pre className="max-h-[320px] max-w-full overflow-auto whitespace-pre-wrap break-words p-3 text-xs font-mono">{formatJson(lastResult.raw)}</pre>
                    </details>
                  )}

                  {results.length > 1 && (
                    <div className="space-y-2 border-t pt-3">
                      <h3 className="text-xs font-medium text-muted-foreground">Recent runs</h3>
                      {results.slice(1).map(result => (
                        <button
                          key={result.id}
                          type="button"
                          onClick={() => setResults(current => [result, ...current.filter(item => item.id !== result.id)])}
                          className="block w-full rounded-md border border-border bg-muted/20 px-3 py-2 text-left text-xs hover:bg-muted/50"
                        >
                          <span className="font-medium">{getPlaygroundMode(result.mode).label}</span>
                          <span className="ml-2 text-muted-foreground">{result.title}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </Card>
        )}
      </div>
          </section>
        </div>
      )}
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Clipboard,
  FileAudio,
  ImageIcon,
  Loader2,
  MessageSquare,
  Mic,
  Radio,
  SendHorizontal,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { RealtimeSessionPanel } from '@/components/realtime-session-panel'
import { cn } from '@/lib/utils'
import {
  getConfiguredProviderCount,
  getPlaygroundMode,
  getSupportedModelCount,
  isPlaygroundModeConfigured,
  type PlaygroundCapabilityMode,
} from '../../../shared/playground'
import type { CapabilitiesResponse } from '../../../shared/types'

interface PlaygroundChatModelOption {
  modelDbId: number
  platform: string
  modelId: string
  displayName: string
  keyCount: number
  capabilities?: string[]
}

interface PlaygroundChatPanelProps {
  apiKey?: string
  models: PlaygroundChatModelOption[]
  realtimeModels?: PlaygroundChatModelOption[]
  capabilityData?: CapabilitiesResponse
}

type MessageRole = 'user' | 'assistant' | 'system'

interface ChatMessageItem {
  id: number
  role: MessageRole
  content: string
  status?: 'success' | 'error'
  imageUrl?: string
  imageSrc?: string
  audioSrc?: string
  meta?: {
    platform?: string
    model?: string
    latency?: number
    endpoint?: string
    fallbackAttempts?: number
    mode?: PlaygroundCapabilityMode
  }
}

const STORAGE_KEY = 'llmhub.playground.chat.messages.v1'

const CHAT_ACTIONS: Array<{
  id: PlaygroundCapabilityMode
  label: string
  icon: typeof MessageSquare
  helper: string
}> = [
  { id: 'chat', label: 'Chat', icon: MessageSquare, helper: 'Send text through the fallback chain.' },
  { id: 'vision', label: 'Vision', icon: ImageIcon, helper: 'Ask about an image URL, data URL, or local image.' },
  { id: 'embeddings', label: 'Embeddings', icon: Sparkles, helper: 'Generate an embedding summary for text.' },
  { id: 'image_generation', label: 'Image', icon: ImageIcon, helper: 'Generate an image from the prompt.' },
  { id: 'image_edit', label: 'Edit image', icon: Upload, helper: 'Upload an image and prompt an edit.' },
  { id: 'image_variation', label: 'Variation', icon: Upload, helper: 'Upload an image and request a variation.' },
  { id: 'speech', label: 'Speech', icon: Volume2, helper: 'Read the text aloud.' },
  { id: 'transcription', label: 'Transcribe', icon: FileAudio, helper: 'Upload audio and extract text.' },
  { id: 'translation', label: 'Translate', icon: FileAudio, helper: 'Upload audio and translate to English.' },
  { id: 'realtime', label: 'Realtime', icon: Radio, helper: 'Open the live audio session panel.' },
]

function nextId() {
  return Date.now() + Math.random()
}

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2)
}

function isPersistentImageUrl(value: unknown): value is string {
  return typeof value === 'string' && !value.startsWith('data:') && !value.startsWith('blob:')
}

function loadMessages(): ChatMessageItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(item => ['user', 'assistant', 'system'].includes(item?.role) && typeof item?.content === 'string')
      .slice(-40)
      .map(item => ({
        id: typeof item.id === 'number' ? item.id : nextId(),
        role: item.role,
        content: item.content,
        status: item.status === 'error' ? 'error' : item.status === 'success' ? 'success' : undefined,
        imageUrl: isPersistentImageUrl(item.imageUrl) ? item.imageUrl : undefined,
        imageSrc: isPersistentImageUrl(item.imageSrc) ? item.imageSrc : undefined,
        meta: item.meta && typeof item.meta === 'object' ? item.meta : undefined,
      }))
  } catch {
    return []
  }
}

function serializableMessages(messages: ChatMessageItem[]) {
  return messages.map(({ audioSrc: _audioSrc, imageUrl, imageSrc, ...message }) => ({
    ...message,
    imageUrl: isPersistentImageUrl(imageUrl) ? imageUrl : undefined,
    imageSrc: isPersistentImageUrl(imageSrc) ? imageSrc : undefined,
  })).slice(-40)
}

function modeStatus(data: CapabilitiesResponse | undefined, mode: PlaygroundCapabilityMode) {
  const configured = isPlaygroundModeConfigured(data, mode)
  const supportedModels = getSupportedModelCount(data, mode)
  if (configured) return 'configured'
  if (supportedModels > 0) return 'missing_key'
  return 'unsupported'
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
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

function errorMessageFromBody(body: any): string {
  const error = body?.error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') return error.message ?? JSON.stringify(error)
  return 'Provider returned an error response.'
}

function imageSrcFrom(data: any) {
  const item = data?.data?.[0]
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
async function readJsonResponse(res: Response) {
  return res.json().catch(() => null)
}

export function PlaygroundChatPanel({ apiKey, models, realtimeModels = [], capabilityData }: PlaygroundChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessageItem[]>(loadMessages)
  const [action, setAction] = useState<PlaygroundCapabilityMode>('chat')
  const [selectedModel, setSelectedModel] = useState('auto')
  const [input, setInput] = useState('Explain what this LLM-Hub proxy can do in two short sentences.')
  const [imageUrl, setImageUrl] = useState('')
  const [visionFileName, setVisionFileName] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [maskFile, setMaskFile] = useState<File | null>(null)
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [voice, setVoice] = useState('alloy')
  const [speechFormat, setSpeechFormat] = useState('wav')
  const [language, setLanguage] = useState('')
  const [responseFormat, setResponseFormat] = useState('json')
  const [busy, setBusy] = useState(false)
  const [speakingId, setSpeakingId] = useState<number | null>(null)
  const [showRealtime, setShowRealtime] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  const activeAction = CHAT_ACTIONS.find(item => item.id === action) ?? CHAT_ACTIONS[0]
  const activeDefinition = getPlaygroundMode(action)
  const modelOptions = action === 'realtime' ? realtimeModels : models
  const activeModelLabel = selectedModel === 'auto'
    ? 'Auto (fallback chain)'
    : modelOptions.find(model => model.modelId === selectedModel)?.displayName ?? selectedModel

  const history = useMemo(() => {
    return messages
      .filter(message => (message.role === 'user' || message.role === 'assistant') && message.content.trim())
      .slice(-10)
      .map(message => ({ role: message.role, content: message.content }))
  }, [messages])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serializableMessages(messages)))
    } catch {
      localStorage.removeItem(STORAGE_KEY)
    }
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  useEffect(() => {
    return () => {
      for (const message of messages) {
        if (message.audioSrc) URL.revokeObjectURL(message.audioSrc)
      }
    }
  }, [])

  useEffect(() => {
    if (selectedModel === 'auto') return
    if (!modelOptions.some(model => model.modelId === selectedModel)) {
      setSelectedModel('auto')
    }
  }, [action, modelOptions, selectedModel])

  async function runAction() {
    if (busy) return
    if (action === 'realtime') {
      setShowRealtime(true)
      return
    }

    setBusy(true)
    try {
      if (action === 'chat') await runChat(false)
      else if (action === 'vision') await runChat(true)
      else if (action === 'embeddings') await runEmbeddings()
      else if (action === 'image_generation') await runImageGeneration()
      else if (action === 'image_edit') await runImageEdit()
      else if (action === 'image_variation') await runImageVariation()
      else if (action === 'speech') await runSpeechFromInput()
      else if (action === 'transcription' || action === 'translation') await runAudioText()
    } catch (error: any) {
      appendMessage({
        role: 'assistant',
        content: error.message ?? 'Request failed.',
        status: 'error',
        meta: { mode: action, endpoint: activeDefinition.endpoint },
      })
    } finally {
      setBusy(false)
    }
  }

  async function runChat(withVision: boolean) {
    const text = input.trim()
    if (!text) throw new Error('Enter a message.')
    if (withVision && !imageUrl.trim()) throw new Error('Provide an image URL, data URL, or local image file.')

    const userMessage: ChatMessageItem = {
      id: nextId(),
      role: 'user',
      content: text,
      imageUrl: withVision && !imageUrl.startsWith('data:') ? imageUrl.trim() : undefined,
      meta: { mode: action, endpoint: activeDefinition.endpoint },
    }
    setMessages(current => [...current, userMessage])

    const bodyMessages = [
      ...history,
      withVision
        ? {
            role: 'user',
            content: [
              { type: 'text', text },
              { type: 'image_url', image_url: { url: imageUrl.trim() } },
            ],
          }
        : { role: 'user', content: text },
    ]

    const { data, meta } = await postJson('/v1/chat/completions', {
      model: selectedModel,
      messages: bodyMessages,
    })

    appendMessage({
      role: 'assistant',
      content: data?.choices?.[0]?.message?.content ?? formatJson(data),
      status: 'success',
      meta: { ...meta, mode: action, endpoint: '/v1/chat/completions' },
    })
    setInput('')
  }

  async function runEmbeddings() {
    const text = input.trim()
    if (!text) throw new Error('Enter text to embed.')
    appendMessage({ role: 'user', content: text, meta: { mode: action, endpoint: activeDefinition.endpoint } })

    const { data, meta } = await postJson('/v1/embeddings', {
      model: selectedModel,
      input: text,
    })
    const embedding = data?.data?.[0]?.embedding
    const dimensions = Array.isArray(embedding) ? embedding.length : 'base64'
    appendMessage({
      role: 'assistant',
      content: `Embedding returned ${dimensions} dimensions. Tokens: ${data?.usage?.total_tokens ?? '-'}.`,
      status: 'success',
      meta: { ...meta, mode: action, endpoint: activeDefinition.endpoint },
    })
  }

  async function runImageGeneration() {
    const prompt = input.trim()
    if (!prompt) throw new Error('Enter an image prompt.')
    appendMessage({ role: 'user', content: prompt, meta: { mode: action, endpoint: activeDefinition.endpoint } })

    const { data, meta } = await postJson('/v1/images/generations', {
      model: selectedModel,
      prompt,
      response_format: 'b64_json',
      size: '1024x1024',
    })
    appendMessage({
      role: 'assistant',
      content: data?.data?.[0]?.revised_prompt ?? 'Image generated.',
      status: 'success',
      imageSrc: imageSrcFrom(data),
      meta: { ...meta, mode: action, endpoint: activeDefinition.endpoint },
    })
  }

  async function runImageEdit() {
    const prompt = input.trim()
    if (!imageFile) throw new Error('Choose an image file to edit.')
    if (!prompt) throw new Error('Enter an edit prompt.')
    appendMessage({ role: 'user', content: prompt, meta: { mode: action, endpoint: activeDefinition.endpoint } })

    const form = new FormData()
    form.append('model', selectedModel)
    form.append('image', imageFile)
    if (maskFile) form.append('mask', maskFile)
    form.append('prompt', prompt)
    form.append('response_format', 'b64_json')
    const { data, meta } = await postMultipart('/v1/images/edits', form)

    appendMessage({
      role: 'assistant',
      content: data?.data?.[0]?.revised_prompt ?? 'Image edit generated.',
      status: 'success',
      imageSrc: imageSrcFrom(data),
      meta: { ...meta, mode: action, endpoint: activeDefinition.endpoint },
    })
  }

  async function runImageVariation() {
    if (!imageFile) throw new Error('Choose an image file for variation.')
    appendMessage({
      role: 'user',
      content: input.trim() || `Create a variation of ${imageFile.name}.`,
      meta: { mode: action, endpoint: activeDefinition.endpoint },
    })

    const form = new FormData()
    form.append('model', selectedModel)
    form.append('image', imageFile)
    form.append('response_format', 'b64_json')
    const { data, meta } = await postMultipart('/v1/images/variations', form)

    appendMessage({
      role: 'assistant',
      content: data?.data?.[0]?.revised_prompt ?? 'Image variation generated.',
      status: 'success',
      imageSrc: imageSrcFrom(data),
      meta: { ...meta, mode: action, endpoint: activeDefinition.endpoint },
    })
  }

  async function runSpeechFromInput() {
    const text = input.trim()
    if (!text) throw new Error('Enter text to convert to speech.')
    appendMessage({ role: 'user', content: text, meta: { mode: action, endpoint: activeDefinition.endpoint } })

    const { blob, meta } = await postSpeech(text)
    const audioSrc = URL.createObjectURL(blob)
    appendMessage({
      role: 'assistant',
      content: `${blob.type || 'audio'} generated. Size: ${Math.round(blob.size / 1024)} KB.`,
      status: 'success',
      audioSrc,
      meta: { ...meta, mode: action, endpoint: activeDefinition.endpoint },
    })
  }

  async function runAudioText() {
    if (!audioFile) throw new Error('Choose an audio file.')
    appendMessage({
      role: 'user',
      content: input.trim() || `${activeDefinition.label}: ${audioFile.name}`,
      meta: { mode: action, endpoint: activeDefinition.endpoint },
    })

    const form = new FormData()
    form.append('model', selectedModel)
    form.append('file', audioFile)
    if (input.trim()) form.append('prompt', input.trim())
    form.append('response_format', responseFormat)
    if (action === 'transcription' && language.trim()) form.append('language', language.trim())

    const { data, meta } = await postMultipart(activeDefinition.endpoint, form)
    appendMessage({
      role: 'assistant',
      content: typeof data?.text === 'string' ? data.text : formatJson(data),
      status: 'success',
      meta: { ...meta, mode: action, endpoint: activeDefinition.endpoint },
    })
  }

  async function speakMessage(message: ChatMessageItem) {
    if (speakingId || !message.content.trim()) return
    setSpeakingId(message.id)
    try {
      const { blob } = await postSpeech(message.content)
      const audioSrc = URL.createObjectURL(blob)
      setMessages(current => current.map(item => {
        if (item.id !== message.id) return item
        if (item.audioSrc) URL.revokeObjectURL(item.audioSrc)
        return { ...item, audioSrc }
      }))
    } catch (error: any) {
      appendMessage({
        role: 'system',
        content: error.message ?? 'Speech generation failed.',
        status: 'error',
        meta: { mode: 'speech', endpoint: '/v1/audio/speech' },
      })
    } finally {
      setSpeakingId(null)
    }
  }

  async function postJson(endpoint: string, body: Record<string, unknown>) {
    const start = Date.now()
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await readJsonResponse(res)
    const meta = {
      ...routedViaFrom(res, data),
      latency: Date.now() - start,
      fallbackAttempts: Number(res.headers.get('X-Fallback-Attempts') ?? '') || undefined,
    }
    if (!res.ok || data?.error) {
      const error = new Error(data?.error?.message ?? errorMessageFromBody(data) ?? `HTTP ${res.status}`)
      ;(error as any).meta = meta
      throw error
    }
    return { data, meta }
  }

  async function postMultipart(endpoint: string, body: FormData) {
    const start = Date.now()
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body,
    })
    const data = await readJsonResponse(res)
    const meta = {
      ...routedViaFrom(res, data),
      latency: Date.now() - start,
      fallbackAttempts: Number(res.headers.get('X-Fallback-Attempts') ?? '') || undefined,
    }
    if (!res.ok || data?.error) throw new Error(data?.error?.message ?? errorMessageFromBody(data) ?? `HTTP ${res.status}`)
    return { data, meta }
  }

  async function postSpeech(text: string) {
    const start = Date.now()
    const res = await fetch('/v1/audio/speech', {
      method: 'POST',
      headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: selectedModel,
        input: text,
        voice: voice.trim() || 'alloy',
        response_format: speechFormat,
      }),
    })
    if (!res.ok) {
      const data = await readJsonResponse(res)
      throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
    }
    return {
      blob: await res.blob(),
      meta: {
        latency: Date.now() - start,
        fallbackAttempts: Number(res.headers.get('X-Fallback-Attempts') ?? '') || undefined,
      },
    }
  }

  function appendMessage(message: Omit<ChatMessageItem, 'id'>) {
    setMessages(current => [...current, { id: nextId(), ...message }].slice(-60))
  }

  function clearMessages() {
    for (const message of messages) {
      if (message.audioSrc) URL.revokeObjectURL(message.audioSrc)
    }
    setMessages([])
  }

  function copyMessage(content: string) {
    void navigator.clipboard?.writeText(content)
  }

  async function loadVisionFile(file: File | null) {
    if (!file) {
      setVisionFileName('')
      return
    }
    if (!file.type.startsWith('image/')) {
      appendMessage({
        role: 'system',
        content: 'Vision currently accepts local image files only.',
        status: 'error',
        meta: { mode: 'vision', endpoint: '/v1/chat/completions' },
      })
      return
    }
    try {
      const dataUrl = await fileToDataUrl(file)
      setImageUrl(dataUrl)
      setVisionFileName(file.name)
    } catch (error: any) {
      appendMessage({
        role: 'system',
        content: error.message ?? 'Could not read image file.',
        status: 'error',
        meta: { mode: 'vision', endpoint: '/v1/chat/completions' },
      })
    }
  }

  return (
    <div className="grid min-h-0 gap-4 lg:h-[calc(100vh-15rem)] lg:min-h-[620px] lg:grid-cols-[340px_minmax(0,1fr)]">
      <Card className="min-w-0 border border-border/70 bg-card/95 shadow-sm lg:max-h-full">
        <CardContent className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">Chat workspace</h2>
            <p className="mt-1 text-xs text-muted-foreground">{activeAction.helper}</p>
          </div>
          <Badge variant={modeStatus(capabilityData, action) === 'configured' ? 'default' : 'outline'}>
            {getConfiguredProviderCount(capabilityData, action)}/{getSupportedModelCount(capabilityData, action)}
          </Badge>
        </div>

        <div className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Model</Label>
            <Select value={selectedModel} onValueChange={(value) => setSelectedModel(value ?? 'auto')}>
              <SelectTrigger className="w-full min-w-0">
                <span className="truncate">{activeModelLabel}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  {action === 'realtime' ? 'Auto (verified realtime default)' : 'Auto (fallback chain)'}
                </SelectItem>
                {modelOptions.map(model => (
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

          <div className="grid grid-cols-2 gap-2">
            {CHAT_ACTIONS.map(item => {
              const Icon = item.icon
              const status = modeStatus(capabilityData, item.id)
              const active = item.id === action
              return (
            <button
              key={item.id}
              type="button"
              onClick={() => setAction(item.id)}
              className={cn(
                    'rounded-xl border border-border/60 px-2.5 py-2 text-left transition-all hover:border-primary/40 hover:bg-background',
                    active ? 'border-primary bg-primary/10 text-foreground' : 'bg-card/40',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Icon className="size-3.5 text-muted-foreground" />
                    <span className="truncate text-xs font-medium">{item.label}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className={cn(
                      'size-1.5 rounded-full',
                      status === 'configured' ? 'bg-emerald-500' : status === 'missing_key' ? 'bg-amber-500' : 'bg-muted-foreground/25',
                    )} />
                    <span>{getConfiguredProviderCount(capabilityData, item.id)}/{getSupportedModelCount(capabilityData, item.id)}</span>
                  </div>
                </button>
              )
            })}
          </div>

          {action === 'vision' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Local image</Label>
                <Input type="file" accept="image/*" onChange={event => void loadVisionFile(event.target.files?.[0] ?? null)} />
                {visionFileName && <p className="truncate text-xs text-muted-foreground">Loaded {visionFileName}</p>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Image URL</Label>
                <Input
                  value={visionFileName && imageUrl.startsWith('data:') ? '' : imageUrl}
                  onChange={event => {
                    setImageUrl(event.target.value)
                    setVisionFileName('')
                  }}
                  placeholder={visionFileName ? 'Local image loaded; paste a URL to replace it.' : 'https://... or data:image/png;base64,...'}
                  className="font-mono text-xs"
                />
              </div>
            </div>
          )}

          {(action === 'image_edit' || action === 'image_variation') && (
            <div className="space-y-1.5">
              <Label className="text-xs">Image file</Label>
              <Input type="file" accept="image/*" onChange={event => setImageFile(event.target.files?.[0] ?? null)} />
            </div>
          )}

          {action === 'image_edit' && (
            <div className="space-y-1.5">
              <Label className="text-xs">Mask file</Label>
              <Input type="file" accept="image/*" onChange={event => setMaskFile(event.target.files?.[0] ?? null)} />
            </div>
          )}

          {(action === 'transcription' || action === 'translation') && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">Audio file</Label>
                <Input type="file" accept="audio/*" onChange={event => setAudioFile(event.target.files?.[0] ?? null)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Response</Label>
                  <Select value={responseFormat} onValueChange={(value) => setResponseFormat(value ?? 'json')}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="json">json</SelectItem>
                      <SelectItem value="text">text</SelectItem>
                      <SelectItem value="verbose_json">verbose_json</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {action === 'transcription' && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Language</Label>
                    <Input value={language} onChange={event => setLanguage(event.target.value)} placeholder="en" />
                  </div>
                )}
              </div>
            </>
          )}

          {(action === 'speech' || action === 'realtime') && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Voice</Label>
                <Input value={voice} onChange={event => setVoice(event.target.value)} />
              </div>
              {action === 'speech' && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Format</Label>
                  <Select value={speechFormat} onValueChange={(value) => setSpeechFormat(value ?? 'wav')}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="wav">wav</SelectItem>
                      <SelectItem value="pcm">pcm</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={clearMessages} disabled={busy || messages.length === 0} className="gap-2">
              <Trash2 className="size-3.5" />
              Clear
            </Button>
            <Badge variant="outline" className="font-mono">{activeDefinition.endpoint}</Badge>
          </div>
        </div>
        </CardContent>
      </Card>

      <Card className="flex min-h-[620px] min-w-0 flex-col overflow-hidden border border-border/70 bg-card/95 shadow-sm lg:min-h-0 lg:max-h-full">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-medium">Conversation</h2>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {activeAction.label} via {activeModelLabel}
            </p>
          </div>
          {showRealtime && (
            <Button variant="outline" size="sm" onClick={() => setShowRealtime(false)}>
              Hide realtime
            </Button>
          )}
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
              Choose a capability, send a request, and responses will stay here for the session.
            </div>
          ) : (
            <div className="space-y-3">
              {messages.map(message => (
                <div
                  key={message.id}
                  className={cn(
                    'max-w-[88%] rounded-xl border px-3 py-2 shadow-sm',
                    message.role === 'user' ? 'ml-auto border-foreground/20 bg-foreground/5' : message.role === 'system' ? 'mx-auto bg-background/50' : 'bg-card',
                    message.status === 'error' && 'border-destructive/50 bg-destructive/10',
                  )}
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge variant={message.role === 'assistant' ? 'default' : 'outline'}>{message.role}</Badge>
                    {message.status === 'error' && <Badge variant="destructive">error</Badge>}
                    {message.meta?.platform && <Badge variant="outline">{message.meta.platform}</Badge>}
                    {message.meta?.model && <code className="break-all text-[11px] text-muted-foreground">{message.meta.model}</code>}
                    {message.meta?.latency != null && <span className="text-[11px] text-muted-foreground tabular-nums">{message.meta.latency} ms</span>}
                    {message.role === 'assistant' && (
                      <div className="ml-auto flex items-center gap-1">
                        <Button variant="ghost" size="icon-xs" title="Copy" onClick={() => copyMessage(message.content)}>
                          <Clipboard className="size-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          title="Speak"
                          disabled={speakingId != null}
                          onClick={() => speakMessage(message)}
                        >
                          {speakingId === message.id ? <Loader2 className="size-3 animate-spin" /> : <Volume2 className="size-3" />}
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</div>
                  {message.imageUrl && (
                    <div className="mt-2 overflow-hidden rounded-lg border border-border/60 bg-background/70">
                      <img src={message.imageUrl} alt="Vision input" className="max-h-[260px] w-full object-contain" />
                    </div>
                  )}
                  {message.imageSrc && (
                    <div className="mt-2 overflow-hidden rounded-lg border border-border/60 bg-background/70">
                      <img src={message.imageSrc} alt="Generated result" className="max-h-[360px] w-full object-contain" />
                    </div>
                  )}
                  {message.audioSrc && <audio controls src={message.audioSrc} className="mt-2 w-full" />}
                </div>
              ))}
              <div ref={endRef} />
            </div>
          )}
        </div>

        {showRealtime && (
          <div className="border-t">
            <RealtimeSessionPanel
              apiKey={apiKey}
              model={selectedModel === 'auto' ? undefined : selectedModel}
              instructions={input}
              voice={voice}
              variant="voice"
            />
          </div>
        )}

        <div className="border-t p-4">
          <div className="space-y-2">
            <Label className="text-xs">
              {action === 'realtime' ? 'Realtime instructions' : action === 'speech' ? 'Text to speak' : action === 'embeddings' ? 'Text' : 'Message'}
            </Label>
            <Textarea
              value={input}
              onChange={event => setInput(event.target.value)}
              rows={3}
              placeholder={activeAction.helper}
              className="max-h-40 resize-none text-sm"
              onKeyDown={event => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  void runAction()
                }
              }}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {action === 'realtime' ? <Mic className="size-3.5" /> : <SendHorizontal className="size-3.5" />}
              <span>{action === 'realtime' ? 'Open the panel, then connect and start mic.' : 'Ctrl+Enter sends the current action.'}</span>
            </div>
            <Button onClick={runAction} disabled={busy} className="gap-2">
              {busy ? <Loader2 className="size-4 animate-spin" /> : action === 'realtime' ? <Radio className="size-4" /> : <SendHorizontal className="size-4" />}
              {action === 'realtime' ? 'Open realtime' : `Run ${activeAction.label}`}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}

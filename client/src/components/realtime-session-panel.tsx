import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Loader2, Mic, MicOff, PlugZap, Radio, SendHorizontal, Unplug, Volume2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  base64ToPcm16Float32,
  createRealtimeAudioInputMessage,
  createRealtimeAudioStreamEndMessage,
  createRealtimeClientContentMessage,
  createRealtimeSetupMessage,
  float32ToPcm16Base64,
  parsePcmMimeTypeSampleRate,
  summarizeRealtimeServerMessage,
  type RealtimeAudioChunk,
} from '../../../shared/realtime'
import type { RealtimeSessionResponse } from '../../../shared/types'

type RealtimeStatus = 'idle' | 'minting' | 'connecting' | 'connected' | 'recording' | 'error'
type RealtimeLogLevel = 'info' | 'error' | 'audio' | 'text'

interface RealtimeSessionPanelProps {
  apiKey?: string
  model?: string
  instructions: string
  voice: string
  variant?: 'default' | 'voice'
}

interface RealtimeLogEntry {
  id: number
  at: string
  level: RealtimeLogLevel
  text: string
}

export function RealtimeSessionPanel({ apiKey, model, instructions, voice, variant = 'default' }: RealtimeSessionPanelProps) {
  const [status, setStatus] = useState<RealtimeStatus>('idle')
  const [session, setSession] = useState<RealtimeSessionResponse | null>(null)
  const [textInput, setTextInput] = useState('')
  const [logs, setLogs] = useState<RealtimeLogEntry[]>([])
  const [lastError, setLastError] = useState<string | null>(null)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const muteGainRef = useRef<GainNode | null>(null)
  const nextPlaybackTimeRef = useRef(0)
  const logIdRef = useRef(0)
  const speakingTimeoutRef = useRef<number | null>(null)

  const isConnected = status === 'connected' || status === 'recording'
  const canSend = isConnected && wsRef.current?.readyState === WebSocket.OPEN
  const voiceActive = status === 'recording' || isSpeaking
  const voiceLabel = isSpeaking ? 'Talking' : status === 'recording' ? 'Listening' : isConnected ? 'Ready' : status
  const audioWireFormat = session?.model === 'gemini-3.1-flash-live-preview' ? 'audio' : 'mediaChunks'

  useEffect(() => {
    return () => {
      if (speakingTimeoutRef.current) window.clearTimeout(speakingTimeoutRef.current)
      disconnect()
    }
  }, [])

  async function connect() {
    if (status === 'minting' || status === 'connecting' || isConnected) return

    setStatus('minting')
    setLastError(null)
    appendLog('info', 'Minting realtime session')

    try {
      const res = await fetch('/v1/realtime/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: model ?? 'auto',
          instructions: instructions.trim() || undefined,
          voice: voice.trim() || 'alloy',
          response_modalities: ['AUDIO'],
          input_audio_transcription: true,
          output_audio_transcription: true,
        }),
      })

      const body = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
      }

      const nextSession = body as RealtimeSessionResponse
      setSession(nextSession)
      appendLog('info', `Session ${nextSession.id} routed to ${nextSession.provider}/${nextSession.model}`)
      openSocket(nextSession)
    } catch (error: any) {
      fail(error.message ?? 'Failed to mint realtime session')
    }
  }

  function openSocket(nextSession: RealtimeSessionResponse) {
    closeSocket()
    setStatus('connecting')
    const socket = new WebSocket(nextSession.connect_url)
    socket.binaryType = 'arraybuffer'
    wsRef.current = socket

    socket.onopen = () => {
      socket.send(JSON.stringify(createRealtimeSetupMessage({
        model: nextSession.model,
        responseModalities: nextSession.config.response_modalities,
        instructions: nextSession.config.instructions,
        inputAudioTranscription: nextSession.config.input_audio_transcription,
        outputAudioTranscription: nextSession.config.output_audio_transcription,
        temperature: nextSession.config.temperature,
      })))
      appendLog('info', 'WebSocket connected; setup sent')
    }

    socket.onmessage = async (event) => {
      try {
        const text = await decodeSocketData(event.data)
        const payload = JSON.parse(text)
        const summary = summarizeRealtimeServerMessage(payload)

        if (summary.setupComplete) {
          setStatus('connected')
          appendLog('info', 'Setup complete')
        }
        if (summary.inputTranscription) appendLog('text', `Input: ${summary.inputTranscription}`)
        if (summary.outputTranscription) appendLog('text', `Output: ${summary.outputTranscription}`)
        if (summary.text) appendLog('text', summary.text)
        if (summary.interrupted) {
          nextPlaybackTimeRef.current = audioContextRef.current?.currentTime ?? 0
          appendLog('info', 'Playback interrupted')
        }
        if (summary.audioChunks.length > 0) markSpeaking()
        for (const chunk of summary.audioChunks) {
          playAudioChunk(chunk)
        }
        if (summary.audioChunks.length > 0) appendLog('audio', `${summary.audioChunks.length} audio chunk(s)`)
        if (summary.turnComplete) appendLog('info', 'Turn complete')
        if (summary.usage) appendLog('info', `Usage ${JSON.stringify(summary.usage)}`)
        if (summary.labels.length === 0) appendLog('info', text.slice(0, 180))
      } catch (error: any) {
        appendLog('error', error.message ?? 'Failed to read realtime event')
      }
    }

    socket.onerror = () => {
      fail('Realtime WebSocket error')
    }

    socket.onclose = (event) => {
      wsRef.current = null
      stopMic(false)
      setStatus(current => current === 'error' ? current : 'idle')
      appendLog('info', `WebSocket closed (${event.code || 'no code'}${event.reason ? `: ${event.reason}` : ''})`)
    }
  }

  async function startMic() {
    if (!canSend) return
    if (!navigator.mediaDevices?.getUserMedia) {
      fail('Microphone capture is not available in this browser')
      return
    }

    try {
      const context = getAudioContext()
      if (context.state === 'suspended') await context.resume()

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      const source = context.createMediaStreamSource(stream)
      const processor = context.createScriptProcessor(4096, 1, 1)
      const muteGain = context.createGain()
      muteGain.gain.value = 0

      processor.onaudioprocess = (event) => {
        const socket = wsRef.current
        if (!socket || socket.readyState !== WebSocket.OPEN) return
        const input = event.inputBuffer.getChannelData(0)
        const data = float32ToPcm16Base64(input, context.sampleRate, 16000)
        socket.send(JSON.stringify(createRealtimeAudioInputMessage(data, 16000, audioWireFormat)))
      }

      source.connect(processor)
      processor.connect(muteGain)
      muteGain.connect(context.destination)

      streamRef.current = stream
      sourceRef.current = source
      processorRef.current = processor
      muteGainRef.current = muteGain
      setStatus('recording')
      appendLog('audio', 'Microphone streaming')
    } catch (error: any) {
      fail(error.message ?? 'Failed to start microphone')
    }
  }

  function stopMic(sendEnd = true) {
    processorRef.current?.disconnect()
    sourceRef.current?.disconnect()
    muteGainRef.current?.disconnect()
    processorRef.current = null
    sourceRef.current = null
    muteGainRef.current = null

    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null

    if (sendEnd && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(createRealtimeAudioStreamEndMessage()))
      appendLog('audio', 'Audio stream ended')
    }

    setStatus(current => current === 'recording' ? 'connected' : current)
  }

  function sendText() {
    const value = textInput.trim()
    if (!value || !canSend) return

    wsRef.current?.send(JSON.stringify(createRealtimeClientContentMessage(value)))
    appendLog('text', `You: ${value}`)
    setTextInput('')
  }

  function disconnect() {
    stopMic(false)
    closeSocket()
    if (audioContextRef.current?.state !== 'closed') {
      void audioContextRef.current?.close()
    }
    audioContextRef.current = null
    setStatus('idle')
  }

  function closeSocket() {
    if (wsRef.current && wsRef.current.readyState < WebSocket.CLOSING) {
      wsRef.current.close()
    }
    wsRef.current = null
  }

  function playAudioChunk(chunk: RealtimeAudioChunk) {
    const samples = base64ToPcm16Float32(chunk.data)
    if (samples.length === 0) return

    const context = getAudioContext()
    const sampleRate = parsePcmMimeTypeSampleRate(chunk.mimeType)
    const buffer = context.createBuffer(1, samples.length, sampleRate)
    buffer.copyToChannel(samples, 0)

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)

    const startTime = Math.max(context.currentTime, nextPlaybackTimeRef.current)
    source.start(startTime)
    nextPlaybackTimeRef.current = startTime + buffer.duration
  }

  function markSpeaking() {
    setIsSpeaking(true)
    if (speakingTimeoutRef.current) window.clearTimeout(speakingTimeoutRef.current)
    speakingTimeoutRef.current = window.setTimeout(() => setIsSpeaking(false), 1200)
  }

  function getAudioContext() {
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      audioContextRef.current = new AudioContext()
      nextPlaybackTimeRef.current = audioContextRef.current.currentTime
    }
    return audioContextRef.current
  }

  function appendLog(level: RealtimeLogLevel, text: string) {
    const id = logIdRef.current + 1
    logIdRef.current = id
    setLogs(current => [{
      id,
      at: new Date().toLocaleTimeString(),
      level,
      text,
    }, ...current].slice(0, 80))
  }

  function fail(message: string) {
    setLastError(message)
    setStatus('error')
    appendLog('error', message)
  }

  if (variant === 'voice') {
    return (
      <Card className="flex min-h-[320px] flex-col overflow-hidden">
        <style>{`
          @keyframes realtime-voice-wave {
            0%, 100% { transform: scaleY(0.28); opacity: 0.45; }
            50% { transform: scaleY(1); opacity: 1; }
          }
        `}</style>
        <CardHeader>
          <CardTitle className="text-sm">Realtime voice</CardTitle>
          <p className="font-mono text-xs text-muted-foreground">
            {session ? `${session.provider}/${session.model}` : '/v1/realtime/sessions'}
          </p>
          <div className="mt-2">
            <Badge variant={status === 'error' ? 'destructive' : isConnected ? 'default' : 'outline'} className="gap-1">
              {status === 'minting' || status === 'connecting' ? <Loader2 className="size-3 animate-spin" /> : <Radio className="size-3" />}
              {voiceLabel}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-4 px-4 pb-5">
          <div className="grid gap-2">
          {lastError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{lastError}</span>
            </div>
          )}
          <div className="rounded-lg border bg-background px-5 py-6">
            <div className={cn(
              'mx-auto flex h-28 w-full max-w-md items-center justify-center gap-1 rounded-lg border px-5',
              isSpeaking && 'border-emerald-500/40 bg-emerald-500/5',
              status === 'recording' && !isSpeaking && 'border-sky-500/40 bg-sky-500/5',
            )}>
              {Array.from({ length: 24 }).map((_, index) => (
                <span
                  key={index}
                  className={cn(
                    'h-16 w-1 origin-center rounded-full transition-colors',
                    isSpeaking ? 'bg-emerald-500' : status === 'recording' ? 'bg-sky-500' : 'bg-muted-foreground/35',
                  )}
                  style={{
                    animationName: voiceActive ? 'realtime-voice-wave' : undefined,
                    animationDuration: voiceActive ? '900ms' : undefined,
                    animationTimingFunction: voiceActive ? 'ease-in-out' : undefined,
                    animationIterationCount: voiceActive ? 'infinite' : undefined,
                    animationDelay: `${(index % 8) * 80}ms`,
                    transform: voiceActive ? undefined : `scaleY(${0.22 + (index % 5) * 0.07})`,
                  }}
                />
              ))}
            </div>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              {!isConnected ? (
                <Button onClick={connect} disabled={status === 'minting' || status === 'connecting'} className="gap-2">
                  <PlugZap className="size-4" />
                  Connect
                </Button>
              ) : (
                <Button variant="outline" onClick={disconnect} className="gap-2">
                  <Unplug className="size-4" />
                  Disconnect
                </Button>
              )}

              {status === 'recording' ? (
                <Button variant="outline" onClick={() => stopMic()} className="gap-2">
                  <MicOff className="size-4" />
                  Stop mic
                </Button>
              ) : (
                <Button variant="outline" onClick={startMic} disabled={!isConnected} className="gap-2">
                  <Mic className="size-4" />
                  Start mic
                </Button>
              )}
            </div>
          </div>
        </div>
        </CardContent>
        <CardContent className="pt-0">
          <div className="grid gap-2 md:grid-cols-[1fr_auto]">
            <Input
              value={textInput}
              onChange={event => setTextInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') sendText()
              }}
              placeholder="Send text into the live session"
              disabled={!isConnected}
            />
            <Button variant="outline" onClick={sendText} disabled={!textInput.trim() || !isConnected} className="gap-2">
              <SendHorizontal className="size-4" />
              Send
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }
  return (
    <Card className="flex h-full min-h-[420px] flex-col">
      <CardHeader>
        <CardTitle className="text-sm">Realtime session</CardTitle>
        <p className="font-mono text-xs text-muted-foreground">
          {session ? `${session.provider}/${session.model}` : '/v1/realtime/sessions'}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <Badge variant={status === 'error' ? 'destructive' : isConnected ? 'default' : 'outline'} className="gap-1">
            {status === 'minting' || status === 'connecting' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Radio className="size-3" />
            )}
            {status}
          </Badge>
          {session && (
            <Badge variant="outline" className="font-mono">
              expires {new Date(session.expires_at * 1000).toLocaleTimeString()}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 md:grid-cols-[auto_auto_1fr_auto]">
          {!isConnected ? (
            <Button onClick={connect} disabled={status === 'minting' || status === 'connecting'} className="gap-2">
              <PlugZap className="size-4" />
              Connect
            </Button>
          ) : (
            <Button variant="outline" onClick={disconnect} className="gap-2">
              <Unplug className="size-4" />
              Disconnect
            </Button>
          )}

          {status === 'recording' ? (
            <Button variant="outline" onClick={() => stopMic()} className="gap-2">
              <MicOff className="size-4" />
              Stop mic
            </Button>
          ) : (
            <Button variant="outline" onClick={startMic} disabled={!isConnected} className="gap-2">
              <Mic className="size-4" />
              Start mic
            </Button>
          )}

          <Input
            value={textInput}
            onChange={event => setTextInput(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') sendText()
            }}
            placeholder="Send text into the live session"
            disabled={!isConnected}
          />
          <Button variant="outline" onClick={sendText} disabled={!textInput.trim() || !isConnected} className="gap-2">
            <SendHorizontal className="size-4" />
            Send
          </Button>
        </div>
        {lastError && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{lastError}</span>
          </div>
        )}
      </CardContent>
      <CardContent className="flex flex-1 min-h-0 flex-col">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Event stream</span>
          <span className="text-xs text-muted-foreground tabular-nums">{logs.length} events buffered</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {logs.length === 0 ? (
            <div className="flex h-full items-center justify-center rounded-lg border bg-muted/20 p-6 text-sm text-muted-foreground">
              Realtime events will appear here.
            </div>
          ) : (
            <div className="space-y-2">
              {logs.map(log => (
                <div key={log.id} className="rounded-md border bg-background px-3 py-2 text-xs">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="font-mono text-muted-foreground">{log.at}</span>
                    <span className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium',
                      log.level === 'error' && 'bg-destructive/10 text-destructive',
                      log.level === 'audio' && 'bg-emerald-500/10 text-emerald-600',
                      log.level === 'text' && 'bg-sky-500/10 text-sky-600',
                      log.level === 'info' && 'bg-muted text-muted-foreground',
                    )}>
                      {log.level === 'audio' && <Volume2 className="size-3" />}
                      {log.level}
                    </span>
                  </div>
                  <pre className="whitespace-pre-wrap font-sans leading-relaxed">{log.text}</pre>
                </div>
              ))}
            </div>
          )}
          </div>
      </CardContent>
    </Card>
  )
}

async function decodeSocketData(data: unknown) {
  if (typeof data === 'string') return data
  if (data instanceof Blob) return data.text()
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
  }
  return String(data)
}

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

interface Voice { id: string; display_name: string; available: number }
interface Key { id: number; platform: string; label: string; enabled: boolean; status: string }

export function CustomVoices({ onSelect }: { onSelect: (id: string) => void }) {
  const client = useQueryClient()
  const { data: voices = [], error: voicesError } = useQuery<Voice[]>({ queryKey: ['speech-voices'], queryFn: () => apiFetch('/api/voices') })
  const { data: keys = [], error: keysError } = useQuery<Key[]>({ queryKey: ['voice-keys'], queryFn: () => apiFetch('/api/keys') })
  const [keyId, setKeyId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [voiceId, setVoiceId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState('')
  const availableKeys = keys.filter(k => k.platform === 'google' && k.enabled && k.status !== 'invalid')
  async function save(kind: 'design' | 'import') {
    setBusy(true); setError('')
    try {
      const result = await apiFetch<{ voice: Voice; preview_available?: boolean }>(`/api/voices/${kind}`, {
        method: 'POST', body: JSON.stringify({ key_id: Number(keyId),
          ...(name.trim() ? { display_name: name.trim() } : {}),
          ...(kind === 'design' ? { prompt: description } : { voice_id: voiceId.trim() }),
        }),
      })
      await client.invalidateQueries({ queryKey: ['speech-voices'] })
      onSelect(result.voice.id)
      if (result.preview_available) setPreview(result.voice.id)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save this voice.') }
    finally { setBusy(false) }
  }
  return <details className="rounded-lg border p-3 text-sm">
    <summary className="cursor-pointer font-medium">Custom voices · Gemini 3.8 TTS</summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs text-muted-foreground">Design a voice or import one from Google AI Studio. Use the Google key from the project that owns the voice.</p>
      <label className="block space-y-1">Google account
        <select aria-label="Voice Google account" value={keyId} onChange={e => setKeyId(e.target.value)} className="block w-full rounded border bg-background p-2" disabled={busy}>
          <option value="">Choose a saved Google key</option>
          {availableKeys.map(k => <option key={k.id} value={k.id}>{k.label || `Google key ${k.id}`}</option>)}
        </select>
      </label>
      <label className="block space-y-1">Voice name<Input value={name} onChange={e => setName(e.target.value)} placeholder="My assistant" maxLength={100} disabled={busy} /></label>
      <label className="block space-y-1">Describe a new voice<Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="A calm, warm voice with a gentle British accent and clear pronunciation." maxLength={2000} disabled={busy} /></label>
      <Button type="button" size="sm" disabled={busy || !keyId || !name.trim() || description.trim().length < 10} onClick={() => void save('design')}>{busy ? 'Working…' : 'Design voice'}</Button>
      <label className="block space-y-1">Or import a voice ID<Input value={voiceId} onChange={e => setVoiceId(e.target.value)} placeholder="voice_…" disabled={busy} /></label>
      <Button type="button" size="sm" variant="outline" disabled={busy || !keyId || !voiceId.trim()} onClick={() => void save('import')}>Import voice</Button>
      {(error || voicesError || keysError) && <p role="alert" className="text-destructive">{error || voicesError?.message || keysError?.message}</p>}
      {voices.map(v => <div className="flex flex-wrap items-center gap-2" key={v.id}>
        <span className="min-w-0 flex-1 truncate">{v.display_name}</span>
        <Button type="button" size="sm" variant="outline" disabled={!v.available || busy} onClick={() => { onSelect(v.id); setPreview('') }}>Use voice</Button>
        <Button type="button" size="sm" variant="ghost" disabled={!v.available || busy} onClick={() => setPreview(v.id)}>Preview</Button>
      </div>)}
      {preview && <audio key={preview} controls src={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/voices/${encodeURIComponent(preview)}/preview`} onError={() => setError('Preview unavailable. Use this voice and generate a speech sample instead.')} className="w-full" />}
    </div>
  </details>
}

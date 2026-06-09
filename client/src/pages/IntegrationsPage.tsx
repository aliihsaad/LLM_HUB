import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, BookOpenCheck, Check, Clipboard, Code2, Eye, EyeOff, KeyRound, RefreshCw } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/page-header'
import { cn } from '@/lib/utils'
import {
  getConfiguredProviderCount,
  getPlaygroundMode,
  getSupportedModelCount,
  PLAYGROUND_MODES,
  type PlaygroundCapabilityMode,
} from '../../../shared/playground'
import type { CapabilitiesResponse } from '../../../shared/types'

type SnippetLanguage = 'javascript' | 'python' | 'curl'

const languageLabels: Record<SnippetLanguage, string> = {
  javascript: 'JavaScript',
  python: 'Python',
  curl: 'cURL',
}

type IntegrationTab = 'setup' | 'gemini' | 'capabilities'

const integrationTabs: Array<{ id: IntegrationTab; label: string; sublabel: string }> = [
  { id: 'setup', label: 'Setup & Client', sublabel: 'configure endpoint and credentials' },
  { id: 'gemini', label: 'Gemini', sublabel: 'Google-compatible routing layer' },
  { id: 'capabilities', label: 'Capabilities', sublabel: 'request examples by mode' },
]

const capabilityDescriptions: Record<PlaygroundCapabilityMode, string> = {
  chat: 'Route text prompts through the fallback chain.',
  gemini_generate: 'Send a Google Gemini generateContent request through the local routing layer.',
  gemini_stream: 'Stream a Gemini-compatible response through the local routing layer.',
  vision: 'Send text plus image URLs or data URLs to a vision-capable model.',
  embeddings: 'Create vectors for search, memory, or ranking workflows.',
  image_generation: 'Generate an image and receive base64 output by default.',
  image_edit: 'Upload an image and prompt for provider-backed edits.',
  image_variation: 'Upload an image and ask for a generated variation.',
  speech: 'Turn text into audio through the configured speech model.',
  transcription: 'Upload audio and receive text or JSON transcription output.',
  translation: 'Upload audio and translate speech to English text.',
  realtime: 'Mint a realtime audio session for the browser session client.',
}

interface DocumentationProviderStatus {
  provider: string
  displayName: string
  docsUrl: string
  topics: number
  lastFetchedAt: string | null
  lastVerifiedAt: string | null
  status: 'synced' | 'missing'
}

interface DocumentationStatusResponse {
  configured: boolean
  apiUrl: string | null
  providerCount: number
  syncedProviders: number
  missingProviders: number
  lastSyncedAt: string | null
  providers: DocumentationProviderStatus[]
}

function getBaseUrl() {
  if (typeof window === 'undefined') return 'http://localhost:3001/v1'
  return `http://${window.location.hostname}:${__SERVER_PORT__}/v1`
}

function getGeminiBaseUrl() {
  if (typeof window === 'undefined') return 'http://localhost:3001/gemini/v1beta'
  return `http://${window.location.hostname}:${__SERVER_PORT__}/gemini/v1beta`
}

function envSnippet(language: SnippetLanguage, baseUrl: string, apiKey: string) {
  if (language === 'javascript') {
    return [
      `npm install openai`,
      ``,
      `LLMHUB_BASE_URL="${baseUrl}"`,
      `LLMHUB_KEY="${apiKey || 'llmhub-your-local-key'}"`,
    ].join('\n')
  }

  if (language === 'python') {
    return [
      `pip install openai`,
      ``,
      `set LLMHUB_BASE_URL=${baseUrl}`,
      `set LLMHUB_KEY=${apiKey || 'llmhub-your-local-key'}`,
    ].join('\n')
  }

  return [
    `$env:LLMHUB_BASE_URL = "${baseUrl}"`,
    `$env:LLMHUB_KEY = "${apiKey || 'llmhub-your-local-key'}"`,
  ].join('\n')
}

function clientSnippet(language: SnippetLanguage, baseUrl: string) {
  if (language === 'javascript') {
    return [
      `import OpenAI from "openai";`,
      ``,
      `const client = new OpenAI({`,
      `  apiKey: process.env.LLMHUB_KEY,`,
      `  baseURL: process.env.LLMHUB_BASE_URL ?? "${baseUrl}",`,
      `});`,
    ].join('\n')
  }

  if (language === 'python') {
    return [
      `import os`,
      `from openai import OpenAI`,
      ``,
      `client = OpenAI(`,
      `    api_key=os.environ["LLMHUB_KEY"],`,
      `    base_url=os.environ.get("LLMHUB_BASE_URL", "${baseUrl}"),`,
      `)`,
    ].join('\n')
  }

  return [
    `curl "$env:LLMHUB_BASE_URL/models" \\`,
    `  -H "Authorization: Bearer $env:LLMHUB_KEY"`,
  ].join('\n')
}

function capabilitySnippet(mode: PlaygroundCapabilityMode, language: SnippetLanguage, baseUrl: string) {
  if (language === 'curl') return curlSnippet(mode)
  if (language === 'python') return pythonSnippet(mode, baseUrl)
  return javascriptSnippet(mode, baseUrl)
}

function geminiEnvSnippet(language: SnippetLanguage, geminiBaseUrl: string, apiKey: string) {
  if (language === 'javascript') {
    return [
      `GEMINI_BASE_URL="${geminiBaseUrl}"`,
      `LLMHUB_KEY="${apiKey || 'llmhub-your-local-key'}"`,
      `GEMINI_MODEL="gemini-2.5-flash"`,
    ].join('\n')
  }

  if (language === 'python') {
    return [
      `set GEMINI_BASE_URL=${geminiBaseUrl}`,
      `set LLMHUB_KEY=${apiKey || 'llmhub-your-local-key'}`,
      `set GEMINI_MODEL=gemini-2.5-flash`,
    ].join('\n')
  }

  return [
    `$env:GEMINI_BASE_URL = "${geminiBaseUrl}"`,
    `$env:LLMHUB_KEY = "${apiKey || 'llmhub-your-local-key'}"`,
    `$env:GEMINI_MODEL = "gemini-2.5-flash"`,
  ].join('\n')
}

function geminiGenerateSnippet(language: SnippetLanguage, geminiBaseUrl: string) {
  if (language === 'python') {
    return [
      `import os`,
      `import requests`,
      ``,
      `model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")`,
      `response = requests.post(`,
      `    f"{os.environ.get('GEMINI_BASE_URL', '${geminiBaseUrl}')}/models/{model}:generateContent",`,
      `    headers={`,
      `        "Authorization": f"Bearer {os.environ['LLMHUB_KEY']}",`,
      `        "Content-Type": "application/json",`,
      `    },`,
      `    json={"contents": [{"role": "user", "parts": [{"text": "Explain this router in one sentence."}]}]},`,
      `    timeout=30,`,
      `)`,
      `response.raise_for_status()`,
      `print(response.json()["candidates"][0]["content"]["parts"][0]["text"])`,
    ].join('\n')
  }

  if (language === 'curl') {
    return [
      `curl "$env:GEMINI_BASE_URL/models/$env:GEMINI_MODEL:generateContent" \\`,
      `  -H "Authorization: Bearer $env:LLMHUB_KEY" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{"contents":[{"role":"user","parts":[{"text":"Explain this router in one sentence."}]}]}'`,
    ].join('\n')
  }

  return [
    `const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";`,
    `const baseURL = process.env.GEMINI_BASE_URL ?? "${geminiBaseUrl}";`,
    ``,
    `const response = await fetch(\`${'${baseURL}'}/models/${'${model}'}:generateContent\`, {`,
    `  method: "POST",`,
    `  headers: {`,
    `    "Authorization": \`Bearer ${'${process.env.LLMHUB_KEY}'}\`,`,
    `    "Content-Type": "application/json",`,
    `  },`,
    `  body: JSON.stringify({`,
    `    contents: [{ role: "user", parts: [{ text: "Explain this router in one sentence." }] }],`,
    `  }),`,
    `});`,
    ``,
    `const data = await response.json();`,
    `console.log(data.candidates?.[0]?.content?.parts?.[0]?.text);`,
  ].join('\n')
}

function geminiStreamSnippet(language: SnippetLanguage, geminiBaseUrl: string) {
  if (language === 'python') {
    return [
      `import os`,
      `import requests`,
      ``,
      `model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")`,
      `with requests.post(`,
      `    f"{os.environ.get('GEMINI_BASE_URL', '${geminiBaseUrl}')}/models/{model}:streamGenerateContent",`,
      `    headers={`,
      `        "Authorization": f"Bearer {os.environ['LLMHUB_KEY']}",`,
      `        "Content-Type": "application/json",`,
      `    },`,
      `    json={"contents": [{"role": "user", "parts": [{"text": "Stream a short answer."}]}]},`,
      `    stream=True,`,
      `    timeout=60,`,
      `) as response:`,
      `    response.raise_for_status()`,
      `    for line in response.iter_lines(decode_unicode=True):`,
      `        if line:`,
      `            print(line)`,
    ].join('\n')
  }

  if (language === 'curl') {
    return [
      `curl "$env:GEMINI_BASE_URL/models/$env:GEMINI_MODEL:streamGenerateContent" \\`,
      `  -H "Authorization: Bearer $env:LLMHUB_KEY" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{"contents":[{"role":"user","parts":[{"text":"Stream a short answer."}]}]}'`,
    ].join('\n')
  }

  return [
    `const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";`,
    `const baseURL = process.env.GEMINI_BASE_URL ?? "${geminiBaseUrl}";`,
    ``,
    `const response = await fetch(\`${'${baseURL}'}/models/${'${model}'}:streamGenerateContent\`, {`,
    `  method: "POST",`,
    `  headers: {`,
    `    "Authorization": \`Bearer ${'${process.env.LLMHUB_KEY}'}\`,`,
    `    "Content-Type": "application/json",`,
    `  },`,
    `  body: JSON.stringify({`,
    `    contents: [{ role: "user", parts: [{ text: "Stream a short answer." }] }],`,
    `  }),`,
    `});`,
    ``,
    `for await (const chunk of response.body ?? []) {`,
    `  process.stdout.write(Buffer.from(chunk).toString("utf8"));`,
    `}`,
  ].join('\n')
}

function javascriptSnippet(mode: PlaygroundCapabilityMode, baseUrl: string) {
  switch (mode) {
    case 'gemini_generate':
      return geminiGenerateSnippet('javascript', baseUrl.replace(/\/v1$/, '/gemini/v1beta'))
    case 'gemini_stream':
      return geminiStreamSnippet('javascript', baseUrl.replace(/\/v1$/, '/gemini/v1beta'))
    case 'chat':
      return [
        `const response = await client.chat.completions.create({`,
        `  model: "auto",`,
        `  messages: [{ role: "user", content: "Explain this router in one sentence." }],`,
        `});`,
        ``,
        `console.log(response.choices[0]?.message?.content);`,
      ].join('\n')
    case 'vision':
      return [
        `const response = await client.chat.completions.create({`,
        `  model: "auto",`,
        `  messages: [{`,
        `    role: "user",`,
        `    content: [`,
        `      { type: "text", text: "What is in this image?" },`,
        `      { type: "image_url", image_url: { url: "https://example.com/image.png" } },`,
        `    ],`,
        `  }],`,
        `});`,
        ``,
        `console.log(response.choices[0]?.message?.content);`,
      ].join('\n')
    case 'embeddings':
      return [
        `const embedding = await client.embeddings.create({`,
        `  model: "auto",`,
      `    input: "LLM-Hub routes embedding requests.",`,
        `});`,
        ``,
        `console.log(embedding.data[0].embedding.length);`,
      ].join('\n')
    case 'image_generation':
      return [
        `const image = await client.images.generate({`,
        `  model: "auto",`,
        `  prompt: "A clean app icon for a local AI gateway",`,
        `  size: "1024x1024",`,
        `  response_format: "b64_json",`,
        `});`,
        ``,
        `console.log(image.data[0].b64_json);`,
      ].join('\n')
    case 'image_edit':
      return [
        `import fs from "node:fs";`,
        ``,
        `const edited = await client.images.edit({`,
        `  model: "auto",`,
        `  image: fs.createReadStream("input.png"),`,
        `  prompt: "Replace the background with a white studio backdrop.",`,
        `  response_format: "b64_json",`,
        `});`,
        ``,
        `console.log(edited.data[0].b64_json);`,
      ].join('\n')
    case 'image_variation':
      return [
        `import fs from "node:fs";`,
        ``,
        `const variation = await client.images.createVariation({`,
        `  model: "auto",`,
        `  image: fs.createReadStream("input.png"),`,
        `  response_format: "b64_json",`,
        `});`,
        ``,
        `console.log(variation.data[0].b64_json);`,
      ].join('\n')
    case 'speech':
      return [
        `import fs from "node:fs/promises";`,
        ``,
        `const audio = await client.audio.speech.create({`,
        `  model: "auto",`,
        `  voice: "alloy",`,
        `  input: "LLM-Hub can speak through a configured provider.",`,
        `  response_format: "wav",`,
        `});`,
        ``,
        `await fs.writeFile("speech.wav", Buffer.from(await audio.arrayBuffer()));`,
      ].join('\n')
    case 'transcription':
      return [
        `import fs from "node:fs";`,
        ``,
        `const text = await client.audio.transcriptions.create({`,
        `  model: "auto",`,
        `  file: fs.createReadStream("speech.wav"),`,
        `  response_format: "json",`,
        `});`,
        ``,
        `console.log(text);`,
      ].join('\n')
    case 'translation':
      return [
        `import fs from "node:fs";`,
        ``,
        `const translated = await client.audio.translations.create({`,
        `  model: "auto",`,
        `  file: fs.createReadStream("speech.wav"),`,
        `  response_format: "json",`,
        `});`,
        ``,
        `console.log(translated);`,
      ].join('\n')
    case 'realtime':
      return [
        `const session = await fetch("${baseUrl}/realtime/sessions", {`,
        `  method: "POST",`,
        `  headers: {`,
        `    "Authorization": \`Bearer \${process.env.LLMHUB_KEY}\`,`,
        `    "Content-Type": "application/json",`,
        `  },`,
        `  body: JSON.stringify({`,
        `    model: "auto",`,
        `    instructions: "You are concise and helpful.",`,
        `    voice: "alloy",`,
        `    response_modalities: ["AUDIO"],`,
        `  }),`,
        `}).then(res => res.json());`,
        ``,
        `console.log(session.connect_url, session.client_secret.value);`,
      ].join('\n')
  }
}

function pythonSnippet(mode: PlaygroundCapabilityMode, baseUrl: string) {
  switch (mode) {
    case 'gemini_generate':
      return geminiGenerateSnippet('python', baseUrl.replace(/\/v1$/, '/gemini/v1beta'))
    case 'gemini_stream':
      return geminiStreamSnippet('python', baseUrl.replace(/\/v1$/, '/gemini/v1beta'))
    case 'chat':
      return [
        `response = client.chat.completions.create(`,
        `    model="auto",`,
        `    messages=[{"role": "user", "content": "Explain this router in one sentence."}],`,
        `)`,
        ``,
        `print(response.choices[0].message.content)`,
      ].join('\n')
    case 'vision':
      return [
        `response = client.chat.completions.create(`,
        `    model="auto",`,
        `    messages=[{`,
        `        "role": "user",`,
        `        "content": [`,
        `            {"type": "text", "text": "What is in this image?"},`,
        `            {"type": "image_url", "image_url": {"url": "https://example.com/image.png"}},`,
        `        ],`,
        `    }],`,
        `)`,
        ``,
        `print(response.choices[0].message.content)`,
      ].join('\n')
    case 'embeddings':
      return [
        `embedding = client.embeddings.create(`,
        `    model="auto",`,
        `    input="LLM-Hub routes embedding requests.",`,
        `)`,
        ``,
        `print(len(embedding.data[0].embedding))`,
      ].join('\n')
    case 'image_generation':
      return [
        `image = client.images.generate(`,
        `    model="auto",`,
        `    prompt="A clean app icon for a local AI gateway",`,
        `    size="1024x1024",`,
        `    response_format="b64_json",`,
        `)`,
        ``,
        `print(image.data[0].b64_json)`,
      ].join('\n')
    case 'image_edit':
      return [
        `with open("input.png", "rb") as image_file:`,
        `    edited = client.images.edit(`,
        `        model="auto",`,
        `        image=image_file,`,
        `        prompt="Replace the background with a white studio backdrop.",`,
        `        response_format="b64_json",`,
        `    )`,
        ``,
        `print(edited.data[0].b64_json)`,
      ].join('\n')
    case 'image_variation':
      return [
        `with open("input.png", "rb") as image_file:`,
        `    variation = client.images.create_variation(`,
        `        model="auto",`,
        `        image=image_file,`,
        `        response_format="b64_json",`,
        `    )`,
        ``,
        `print(variation.data[0].b64_json)`,
      ].join('\n')
    case 'speech':
      return [
        `speech = client.audio.speech.create(`,
        `    model="auto",`,
        `    voice="alloy",`,
        `    input="LLM-Hub can speak through a configured provider.",`,
        `    response_format="wav",`,
        `)`,
        ``,
        `speech.write_to_file("speech.wav")`,
      ].join('\n')
    case 'transcription':
      return [
        `with open("speech.wav", "rb") as audio_file:`,
        `    text = client.audio.transcriptions.create(`,
        `        model="auto",`,
        `        file=audio_file,`,
        `        response_format="json",`,
        `    )`,
        ``,
        `print(text)`,
      ].join('\n')
    case 'translation':
      return [
        `with open("speech.wav", "rb") as audio_file:`,
        `    translated = client.audio.translations.create(`,
        `        model="auto",`,
        `        file=audio_file,`,
        `        response_format="json",`,
        `    )`,
        ``,
        `print(translated)`,
      ].join('\n')
    case 'realtime':
      return [
        `import os`,
        `import requests`,
        ``,
        `session = requests.post(`,
        `    "${baseUrl}/realtime/sessions",`,
        `    headers={"Authorization": f"Bearer {os.environ['LLMHUB_KEY']}"},`,
        `    json={`,
        `        "model": "auto",`,
        `        "instructions": "You are concise and helpful.",`,
        `        "voice": "alloy",`,
        `        "response_modalities": ["AUDIO"],`,
        `    },`,
        `    timeout=30,`,
        `).json()`,
        ``,
        `print(session["connect_url"], session["client_secret"]["value"])`,
      ].join('\n')
  }
}

function curlSnippet(mode: PlaygroundCapabilityMode) {
  switch (mode) {
    case 'gemini_generate':
      return geminiGenerateSnippet('curl', '')
    case 'gemini_stream':
      return geminiStreamSnippet('curl', '')
    case 'chat':
      return [
        `curl "$env:LLMHUB_BASE_URL/chat/completions" \\`,
        `  -H "Authorization: Bearer $env:LLMHUB_KEY" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"model":"auto","messages":[{"role":"user","content":"Explain this router in one sentence."}]}'`,
      ].join('\n')
    case 'vision':
      return [
        `curl "$env:LLMHUB_BASE_URL/chat/completions" \\`,
        `  -H "Authorization: Bearer $env:LLMHUB_KEY" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"model":"auto","messages":[{"role":"user","content":[{"type":"text","text":"What is in this image?"},{"type":"image_url","image_url":{"url":"https://example.com/image.png"}}]}]}'`,
      ].join('\n')
    case 'embeddings':
      return [
        `curl "$env:LLMHUB_BASE_URL/embeddings" \\`,
        `  -H "Authorization: Bearer $env:LLMHUB_KEY" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"model":"auto","input":"LLM-Hub routes embedding requests."}'`,
      ].join('\n')
    case 'image_generation':
      return [
        `curl "$env:LLMHUB_BASE_URL/images/generations" \\`,
        `  -H "Authorization: Bearer $env:LLMHUB_KEY" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"model":"auto","prompt":"A clean app icon for a local AI gateway","size":"1024x1024","response_format":"b64_json"}'`,
      ].join('\n')
    case 'image_edit':
      return [
        `curl "$env:LLMHUB_BASE_URL/images/edits" \\`,
        `  -H "Authorization: Bearer $env:LLMHUB_KEY" \\`,
        `  -F model=auto \\`,
        `  -F image=@input.png \\`,
        `  -F prompt="Replace the background with a white studio backdrop." \\`,
        `  -F response_format=b64_json`,
      ].join('\n')
    case 'image_variation':
      return [
        `curl "$env:LLMHUB_BASE_URL/images/variations" \\`,
        `  -H "Authorization: Bearer $env:LLMHUB_KEY" \\`,
        `  -F model=auto \\`,
        `  -F image=@input.png \\`,
        `  -F response_format=b64_json`,
      ].join('\n')
    case 'speech':
      return [
        `curl "$env:LLMHUB_BASE_URL/audio/speech" \\`,
        `  -H "Authorization: Bearer $env:LLMHUB_KEY" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"model":"auto","voice":"alloy","input":"LLM-Hub can speak through a configured provider.","response_format":"wav"}' \\`,
        `  --output speech.wav`,
      ].join('\n')
    case 'transcription':
      return [
        `curl "$env:LLMHUB_BASE_URL/audio/transcriptions" \\`,
        `  -H "Authorization: Bearer $env:LLMHUB_KEY" \\`,
        `  -F model=auto \\`,
        `  -F file=@speech.wav \\`,
        `  -F response_format=json`,
      ].join('\n')
    case 'translation':
      return [
        `curl "$env:LLMHUB_BASE_URL/audio/translations" \\`,
        `  -H "Authorization: Bearer $env:LLMHUB_KEY" \\`,
        `  -F model=auto \\`,
        `  -F file=@speech.wav \\`,
        `  -F response_format=json`,
      ].join('\n')
    case 'realtime':
      return [
        `curl "$env:LLMHUB_BASE_URL/realtime/sessions" \\`,
        `  -H "Authorization: Bearer $env:LLMHUB_KEY" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"model":"auto","instructions":"You are concise and helpful.","voice":"alloy","response_modalities":["AUDIO"]}'`,
      ].join('\n')
  }
}

function CopyButton({ id, value, copiedId, onCopy }: {
  id: string
  value: string
  copiedId: string | null
  onCopy: (id: string, value: string) => void
}) {
  const copied = copiedId === id
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="h-7 w-7"
      onClick={() => onCopy(id, value)}
      aria-label="Copy snippet"
    >
      {copied ? <Check className="text-emerald-500" /> : <Clipboard />}
    </Button>
  )
}

function CodeBlock({
  id,
  code,
  copiedId,
  onCopy,
  className,
  title,
}: {
  id: string
  code: string
  copiedId: string | null
  onCopy: (id: string, value: string) => void
  className?: string
  title?: string
}) {
  return (
    <Card className={cn('overflow-hidden', className)}>
      {title && (
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{title}</CardTitle>
        </CardHeader>
      )}
      <div className="border-t px-3 py-2 flex items-center justify-between">
        <CardDescription className="text-[11px]">copyable snippet</CardDescription>
        <CopyButton id={id} value={code} copiedId={copiedId} onCopy={onCopy} />
      </div>
      <CardContent className="pt-0">
        <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-[11px] leading-relaxed text-foreground/90">
          {code}
        </pre>
      </CardContent>
    </Card>
  )
}

function statusForMode(data: CapabilitiesResponse | undefined, mode: PlaygroundCapabilityMode) {
  const configured = getConfiguredProviderCount(data, mode)
  const supported = getSupportedModelCount(data, mode)
  if (configured > 0) return { configured, supported, label: 'Ready', dot: 'bg-emerald-500' }
  if (supported > 0) return { configured, supported, label: 'Needs key', dot: 'bg-amber-500' }
  return { configured, supported, label: 'Unsupported', dot: 'bg-muted-foreground/25' }
}

function statusChipStyles(label: string) {
  if (label === 'Ready') return 'text-emerald-500 bg-emerald-500/12 border-emerald-500/25'
  if (label === 'Needs key') return 'text-amber-500 bg-amber-500/12 border-amber-500/25'
  return 'text-muted-foreground bg-muted border-border'
}

export default function IntegrationsPage() {
  const queryClient = useQueryClient()
  const [language, setLanguage] = useState<SnippetLanguage>('javascript')
  const [activeTab, setActiveTab] = useState<IntegrationTab>('setup')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [showUnifiedKey, setShowUnifiedKey] = useState(false)
  const baseUrl = useMemo(getBaseUrl, [])
  const geminiBaseUrl = useMemo(getGeminiBaseUrl, [])

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const regenerateUnifiedKey = useMutation({
    mutationFn: () => apiFetch('/api/settings/api-key/regenerate', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['unified-key'] }),
  })

  const { data: capabilityData } = useQuery<CapabilitiesResponse>({
    queryKey: ['models', 'capabilities'],
    queryFn: () => apiFetch('/api/models/capabilities'),
  })

  const { data: documentationStatus } = useQuery<DocumentationStatusResponse>({
    queryKey: ['knowledge', 'status'],
    queryFn: () => apiFetch('/api/knowledge/status'),
  })

  const checkDocumentation = useMutation({
    mutationFn: () => apiFetch('/api/knowledge/sync', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['knowledge', 'status'] }),
  })

  const apiKey = keyData?.apiKey ?? ''
  const maskedApiKey = apiKey ? `${apiKey.slice(0, 13)}${'*'.repeat(32)}` : 'loading...'
  const visibleApiKey = showUnifiedKey ? apiKey : maskedApiKey
  const setupCode = envSnippet(language, baseUrl, apiKey)
  const clientCode = clientSnippet(language, baseUrl)
  const geminiSetupCode = geminiEnvSnippet(language, geminiBaseUrl, apiKey)
  const geminiGenerateCode = geminiGenerateSnippet(language, geminiBaseUrl)
  const geminiStreamCode = geminiStreamSnippet(language, geminiBaseUrl)
  const allModeData = useMemo(
    () =>
      PLAYGROUND_MODES.map(mode => {
        const status = statusForMode(capabilityData, mode.id)
        return { mode, status, definition: getPlaygroundMode(mode.id), code: capabilitySnippet(mode.id, language, baseUrl) }
      }),
    [capabilityData, language, baseUrl],
  )
  const readyCount = allModeData.filter(item => item.status.label === 'Ready').length
  const needsKeyCount = allModeData.filter(item => item.status.label === 'Needs key').length
  const unsupportedCount = allModeData.filter(item => item.status.label === 'Unsupported').length
  const documentationProviders = documentationStatus?.providers ?? []
  const visibleDocumentationProviders = documentationProviders.slice(0, 8)
  const documentationLastSynced = documentationStatus?.lastSyncedAt
    ? new Date(documentationStatus.lastSyncedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : 'Never'

  async function copy(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedId(id)
      window.setTimeout(() => setCopiedId(current => current === id ? null : current), 1400)
    } catch {
      setCopiedId(null)
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Integrations"
        description="Copy-ready SDK and HTTP snippets for every configured endpoint."
        actions={
          <div className="inline-flex rounded-xl border border-border/70 bg-background/70 p-1">
            {(Object.keys(languageLabels) as SnippetLanguage[]).map(item => (
              <Button
                key={item}
                variant={language === item ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 px-2.5 text-[11px]"
                onClick={() => setLanguage(item)}
              >
                {languageLabels[item]}
              </Button>
            ))}
          </div>
        }
      />

      <div className="overflow-hidden rounded-xl border border-border/70 bg-card/70 p-1">
        <div role="tablist" aria-label="Integrations sections" className="grid gap-1 sm:grid-cols-3">
          {integrationTabs.map(tab => {
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                aria-controls={`${tab.id}-panel`}
                id={`${tab.id}-tab`}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'group relative isolate flex flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-all',
                  isActive
                    ? 'bg-background shadow-sm'
                    : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
                )}
              >
                <span
                  className={cn(
                    'text-[11px] font-semibold transition-colors',
                    isActive ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground',
                  )}
                >
                  {tab.label}
                </span>
                <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/80">{tab.sublabel}</span>
                {isActive && <span className="absolute inset-x-3 bottom-1 h-0.5 rounded-full bg-primary/70" />}
              </button>
            )
          })}
        </div>
      </div>

      {activeTab === 'setup' ? (
        <div id="setup-panel" role="tabpanel" aria-labelledby="setup-tab" className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          <section className="space-y-4">
            <Card className="border-primary/20 bg-gradient-to-br from-primary/8 via-card to-card">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <KeyRound className="size-4 text-primary" />
                      <CardTitle>Unified API key</CardTitle>
                    </div>
                    <CardDescription className="mt-1">
                      Client auth for OpenAI-compatible and Gemini-compatible requests.
                    </CardDescription>
                  </div>
                  <Badge variant="outline" className="h-6 text-[10px]">
                    Local auth
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-medium uppercase tracking-[0.12em] text-muted-foreground">API key</span>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="h-7 w-7"
                        onClick={() => setShowUnifiedKey(current => !current)}
                        aria-label={showUnifiedKey ? 'Hide API key' : 'Show API key'}
                      >
                        {showUnifiedKey ? <EyeOff /> : <Eye />}
                      </Button>
                      <CopyButton id="api-key" value={apiKey} copiedId={copiedId} onCopy={copy} />
                    </div>
                  </div>
                  <div className="flex min-w-0 items-center gap-2 rounded-md border bg-background/60 px-2 py-2">
                    <code className="min-w-0 flex-1 truncate font-mono tabular-nums">{visibleApiKey}</code>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/70 bg-background/50 px-2.5 py-2">
                  <span className="text-[11px] text-muted-foreground">
                    Regenerating immediately invalidates existing client configs.
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 text-[11px]"
                    onClick={() => regenerateUnifiedKey.mutate()}
                    disabled={regenerateUnifiedKey.isPending}
                  >
                    <RefreshCw className="size-3.5" />
                    {regenerateUnifiedKey.isPending ? 'Regenerating' : 'Regenerate'}
                  </Button>
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-medium uppercase tracking-[0.12em] text-muted-foreground">OpenAI base URL</span>
                    <CopyButton id="base-url" value={baseUrl} copiedId={copiedId} onCopy={copy} />
                  </div>
                  <div className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5">
                    <code className="min-w-0 flex-1 truncate">{baseUrl}</code>
                  </div>
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-medium uppercase tracking-[0.12em] text-muted-foreground">Gemini base URL</span>
                    <CopyButton id="setup-gemini-base-url" value={geminiBaseUrl} copiedId={copiedId} onCopy={copy} />
                  </div>
                  <div className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5">
                    <code className="min-w-0 flex-1 truncate">{geminiBaseUrl}</code>
                  </div>
                </div>
                <div className="rounded-md border border-border/70 bg-background/50 px-2.5 py-2 text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">Quick endpoints</span>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <code className="rounded-md bg-muted px-1.5 py-0.5">/models</code>
                    <code className="rounded-md bg-muted px-1.5 py-0.5">/chat/completions</code>
                    <code className="rounded-md bg-muted px-1.5 py-0.5">/realtime/sessions</code>
                    <code className="rounded-md bg-muted px-1.5 py-0.5">/gemini/v1beta</code>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <BookOpenCheck className="size-4 text-muted-foreground" />
                      <CardTitle>Documentation Check</CardTitle>
                    </div>
                    <CardDescription className="mt-1">
                      Refresh provider integration docs through the Context7 API configured in Settings.
                    </CardDescription>
                  </div>
                  <Badge
                    variant={documentationStatus?.configured ? 'default' : 'secondary'}
                    className="h-6 text-[10px]"
                  >
                    {documentationStatus?.configured ? 'Context7 ready' : 'Needs key'}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <div className="grid grid-cols-2 gap-2">
                  <InfoBadge
                    label="Synced"
                    value={`${documentationStatus?.syncedProviders ?? 0}/${documentationStatus?.providerCount ?? 0}`}
                    tone="emerald"
                  />
                  <InfoBadge
                    label="Missing"
                    value={String(documentationStatus?.missingProviders ?? 0)}
                    tone={documentationStatus?.missingProviders ? 'amber' : 'slate'}
                  />
                </div>

                <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-2">
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Last check</span>
                    <span className="min-w-0 truncate text-right font-mono text-[11px] text-foreground">{documentationLastSynced}</span>
                  </div>
                </div>

                {!documentationStatus?.configured && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>Add the Context7 API key in Settings before running live documentation checks.</span>
                  </div>
                )}

                <div className="max-h-[190px] overflow-auto rounded-md border border-border/70">
                  {visibleDocumentationProviders.map(provider => (
                    <div key={provider.provider} className="flex items-center gap-2 border-b px-2.5 py-2 last:border-b-0">
                      <span className={cn('size-2 rounded-full', provider.status === 'synced' ? 'bg-emerald-500' : 'bg-amber-500')} />
                      <span className="min-w-0 flex-1 truncate text-foreground">{provider.displayName}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {provider.topics} topics
                      </span>
                    </div>
                  ))}
                  {documentationProviders.length > visibleDocumentationProviders.length && (
                    <div className="px-2.5 py-2 text-[11px] text-muted-foreground">
                      +{documentationProviders.length - visibleDocumentationProviders.length} more providers
                    </div>
                  )}
                </div>

                {checkDocumentation.isError && (
                  <p className="text-[11px] text-destructive">{(checkDocumentation.error as Error).message}</p>
                )}

                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-full gap-1.5 text-[11px]"
                  disabled={!documentationStatus?.configured || checkDocumentation.isPending}
                  onClick={() => checkDocumentation.mutate()}
                >
                  <RefreshCw className={cn('size-3.5', checkDocumentation.isPending && 'animate-spin')} />
                  {checkDocumentation.isPending ? 'Checking documentation' : 'Check documentation'}
                </Button>
              </CardContent>
            </Card>

            <div className="grid grid-cols-3 gap-2 text-[11px]">
              <InfoBadge label="Ready" value={`${readyCount}/${allModeData.length}`} tone="emerald" />
              <InfoBadge label="Needs key" value={String(needsKeyCount)} tone="amber" />
              <InfoBadge label="Unsupported" value={String(unsupportedCount)} tone="slate" />
            </div>
          </section>

          <section className="space-y-4">
            <CodeBlock
              id={`setup-${language}`}
              title="Environment setup"
              code={setupCode}
              copiedId={copiedId}
              onCopy={copy}
            />
            <CodeBlock
              id={`client-${language}`}
              title="Client bootstrap"
              code={clientCode}
              copiedId={copiedId}
              onCopy={copy}
            />
          </section>
        </div>
      ) : activeTab === 'gemini' ? (
        <div id="gemini-panel" role="tabpanel" aria-labelledby="gemini-tab" className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <section className="space-y-4">
            <Card className="border-primary/20 bg-gradient-to-br from-primary/8 via-card to-card">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <Code2 className="size-4 text-primary" />
                  <CardTitle>Gemini Compatibility</CardTitle>
                </div>
                <CardDescription>
                  Google Gemini REST shape routed through LLM-Hub provider keys, fallback logic, and request accounting.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-medium uppercase tracking-[0.12em] text-muted-foreground">Gemini base URL</span>
                    <CopyButton id="gemini-base-url" value={geminiBaseUrl} copiedId={copiedId} onCopy={copy} />
                  </div>
                  <div className="flex min-w-0 items-center gap-2 rounded-md border bg-background/55 px-2 py-1.5">
                    <code className="min-w-0 flex-1 truncate">{geminiBaseUrl}</code>
                  </div>
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-medium uppercase tracking-[0.12em] text-muted-foreground">Default model path</span>
                    <CopyButton id="gemini-model-path" value={`${geminiBaseUrl}/models/gemini-2.5-flash:generateContent`} copiedId={copiedId} onCopy={copy} />
                  </div>
                  <div className="flex min-w-0 items-center gap-2 rounded-md border bg-background/55 px-2 py-1.5">
                    <code className="min-w-0 flex-1 truncate">/models/gemini-2.5-flash:generateContent</code>
                  </div>
                </div>
                <div className="rounded-md border border-border/70 bg-background/55 px-2.5 py-2 text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">Supported actions</span>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <code className="rounded-md bg-muted px-1.5 py-0.5">:generateContent</code>
                    <code className="rounded-md bg-muted px-1.5 py-0.5">:streamGenerateContent</code>
                  </div>
                </div>
                <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                  The model id in the URL must be an enabled Google model from your catalog. The request still uses the unified LLM-Hub key.
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <InfoBadge label="Provider" value="Google" tone="emerald" />
              <InfoBadge label="Auth" value="LLM-Hub" tone="slate" />
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <CodeBlock
              id={`gemini-setup-${language}`}
              title="Gemini environment"
              code={geminiSetupCode}
              copiedId={copiedId}
              onCopy={copy}
            />
            <CodeBlock
              id={`gemini-generate-${language}`}
              title="generateContent"
              code={geminiGenerateCode}
              copiedId={copiedId}
              onCopy={copy}
            />
            <CodeBlock
              id={`gemini-stream-${language}`}
              title="streamGenerateContent"
              code={geminiStreamCode}
              copiedId={copiedId}
              onCopy={copy}
              className="lg:col-span-2"
            />
          </section>
        </div>
      ) : (
        <div id="capabilities-panel" role="tabpanel" aria-labelledby="capabilities-tab" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <Code2 className="size-4 text-muted-foreground" />
                    <CardTitle>Capability endpoints</CardTitle>
                  </div>
                  <CardDescription>
                    Select a capability and copy a ready-to-run request payload for {languageLabels[language]}.
                  </CardDescription>
                </div>
                <Badge variant="outline" className="text-[10px] h-6">
                  {languageLabels[language]}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3 xl:grid-cols-2">
              {allModeData.map(({ mode, status, definition, code }) => (
                <Card key={mode.id} className="overflow-hidden">
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={cn('size-2 rounded-full', status.dot)} />
                          <CardTitle className="text-sm truncate">{definition.label}</CardTitle>
                        </div>
                        <CardDescription className="mt-1 text-[11px] leading-relaxed">
                          {capabilityDescriptions[mode.id]}
                        </CardDescription>
                      </div>
                      <span
                        className={cn(
                          'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                          statusChipStyles(status.label),
                        )}
                      >
                        {status.label}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <code className="rounded-md bg-muted px-1.5 py-0.5">{definition.endpoint}</code>
                      <span className="font-mono text-muted-foreground/90">
                        {status.configured}/{status.supported} routable
                      </span>
                    </div>
                  </CardHeader>
                  <CodeBlock
                    id={`${language}-${mode.id}`}
                    code={code}
                    copiedId={copiedId}
                    onCopy={copy}
                    className="border-0"
                  />
                </Card>
              ))}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}

function InfoBadge({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: 'emerald' | 'amber' | 'slate'
}) {
  const toneClass =
    tone === 'emerald'
      ? 'text-emerald-500 border-emerald-500/30 bg-emerald-500/10'
      : tone === 'amber'
        ? 'text-amber-500 border-amber-500/30 bg-amber-500/10'
        : 'text-muted-foreground border-border bg-muted/20'

  return (
    <Card className={cn('px-3 py-2', toneClass)}>
      <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <p className="text-base font-semibold leading-none">{value}</p>
    </Card>
  )
}

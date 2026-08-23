import crypto from 'crypto';
import express, { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  AudioFileUpload,
  AudioTextResponseFormat,
  AudioTranscriptionRequest,
  AudioTranslationRequest,
  ChatMessage,
  EmbeddingInput,
  ImageEditRequest,
  ImageFileUpload,
  ImageGenerationRequest,
  ImageVariationRequest,
  RealtimeSessionRequest,
  SpeechRequest,
} from 'llmhub-shared/types.js';
import {
  routeCapabilityRequest,
  routeRequest,
  recordModelFailure,
  recordRateLimitHit,
  recordSuccess,
  type RouteResult,
} from '../services/router.js';
import { recordRequest, recordTokens, setCooldown } from '../services/ratelimit.js';
import {
  canRetryProviderFailure,
  classifyProviderError,
  type ClassifiedProviderError,
} from '../services/provider-errors.js';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { hasProvider } from '../providers/index.js';
import { resolveRoutableModel, sendResolutionError } from '../lib/resolve-model.js';
import { isFreeOnlyMode } from '../lib/app-settings.js';

export const proxyRouter = Router();
export const geminiProxyRouter = Router();

const GOOGLE_GENERATE_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Constant-time string comparison for the unified API key. Plain `===` leaks
// length and per-character timing, which a network attacker could in principle
// use to recover the key one byte at a time.
function timingSafeStringEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Compare against a same-length buffer regardless of input length so the
  // comparison itself runs in constant time; the explicit length check at the
  // end is what actually decides equality when lengths differ.
  const compareA = a.length === b.length ? a : Buffer.alloc(b.length);
  return crypto.timingSafeEqual(compareA, b) && a.length === b.length;
}

// Sticky sessions: track which model served each "session"
// Key: hash of first user message → model_db_id
// This prevents model switching mid-conversation which causes hallucination
const stickySessionMap = new Map<string, { modelDbId: number; lastUsed: number }>();
const STICKY_TTL_MS = 30 * 60 * 1000; // 30 min session TTL

function getSessionKey(messages: ChatMessage[]): string {
  // Use the first user message as session identifier — clients like Hermes
  // re-send the full conversation each turn, so the first user message is
  // stable across turns. Hash the FULL message (not a 100-char slice) so
  // distinct conversations with identical openings don't collide.
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return '';
  const content = serializeChatContent(firstUser.content);
  if (!content) return '';
  const hash = crypto.createHash('sha1').update(content).digest('hex');
  return `${hash}:${messages.length > 2 ? 'multi' : 'single'}`;
}

function serializeChatContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return JSON.stringify(content);
  return '';
}

function hasImageContent(content: ChatMessage['content']): boolean {
  return Array.isArray(content) && content.some(part => part.type === 'image_url');
}

function hasVideoContent(content: ChatMessage['content']): boolean {
  return Array.isArray(content) && content.some(part => part.type === 'video_url');
}

function requiresVision(messages: ChatMessage[]): boolean {
  return messages.some(m => hasImageContent(m.content));
}

function requiresVideo(messages: ChatMessage[]): boolean {
  return messages.some(m => hasVideoContent(m.content));
}

function estimateChatContentTokens(content: ChatMessage['content']): number {
  if (typeof content === 'string') return Math.ceil(content.length / 4);
  if (!Array.isArray(content)) return 0;

  return content.reduce((sum, part) => {
    if (part.type === 'text') return sum + Math.ceil(part.text.length / 4);
    if (part.type === 'image_url') {
      // Conservative fixed cost so image requests avoid models with tiny budgets.
      return sum + 250;
    }
    // Video requests are substantially heavier than single-image prompts.
    return sum + 1000;
  }, 0);
}

function estimateStructuredTokens(value: unknown): number {
  if (value == null) return 0;
  try {
    // JSON-heavy tool schemas tokenize more densely than natural language.
    return Math.ceil(JSON.stringify(value).length / 3);
  } catch {
    return 0;
  }
}

function getStickyModel(messages: ChatMessage[]): number | undefined {
  // Only apply sticky for multi-turn (has assistant messages = continuation)
  const hasAssistant = messages.some(m => m.role === 'assistant');
  if (!hasAssistant) return undefined;

  const key = getSessionKey(messages);
  if (!key) return undefined;

  const entry = stickySessionMap.get(key);
  if (!entry) return undefined;

  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }
  return entry.modelDbId;
}

function setStickyModel(messages: ChatMessage[], modelDbId: number) {
  const key = getSessionKey(messages);
  if (!key) return;
  stickySessionMap.set(key, { modelDbId, lastUsed: Date.now() });

  // Cleanup old entries
  if (stickySessionMap.size > 500) {
    const now = Date.now();
    for (const [k, v] of stickySessionMap) {
      if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
    }
  }
}

interface UnifiedModelListRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  context_window: number | null;
  intelligence_rank: number;
  capabilities: string | null;
  key_count: number;
}

// OpenAI-compatible /models endpoint (used by external clients for metadata).
// Extra fields are intentionally additive so OpenAI-style clients can ignore
// them, while capability-aware clients can avoid sending chat requests to
// realtime/audio/image-only models.
proxyRouter.get('/models', (_req: Request, res: Response) => {
  const db = getDb();
  const freeOnly = isFreeOnlyMode(db);
  const models = db.prepare(`
    SELECT
      m.id,
      m.platform,
      m.model_id,
      m.display_name,
      m.context_window,
      m.intelligence_rank,
      m.is_free,
      COUNT(DISTINCT ak.id) AS key_count,
      GROUP_CONCAT(DISTINCT mc.capability) AS capabilities
    FROM models m
    JOIN api_keys ak
      ON ak.platform = m.platform
      AND ak.enabled = 1
      AND ak.status != 'invalid'
    LEFT JOIN model_capabilities mc
      ON mc.model_db_id = m.id
      AND mc.enabled = 1
    LEFT JOIN model_runtime_health rh
      ON rh.model_db_id = m.id
    WHERE m.enabled = 1
      ${freeOnly ? 'AND m.is_free = 1' : ''}
      AND (
        rh.model_db_id IS NULL
        OR NOT (
          rh.status = 'unavailable'
          AND rh.last_error_category = 'zero_quota'
        )
      )
      AND (
        rh.blocked_until IS NULL
        OR rh.blocked_until <= datetime('now')
      )
    GROUP BY m.id
    ORDER BY m.intelligence_rank ASC, m.model_id ASC
  `).all() as UnifiedModelListRow[];

  res.json({
    object: 'list',
    data: models.filter(m => hasProvider(m.platform as any)).map(m => {
      const capabilities = m.capabilities
        ? m.capabilities.split(',').filter(Boolean)
        : ['chat'];

      return {
        id: m.model_id,
        object: 'model',
        created: 0,
        owned_by: m.platform,
        name: m.display_name,
        context_window: m.context_window,
        capabilities,
        available: true,
        key_count: m.key_count,
      };
    }),
  });
});

const MAX_RETRIES = 20;

const geminiGenerateContentSchema = z.object({
  contents: z.array(z.record(z.string(), z.unknown())).min(1),
  generationConfig: z.record(z.string(), z.unknown()).optional(),
  systemInstruction: z.unknown().optional(),
  tools: z.unknown().optional(),
  toolConfig: z.unknown().optional(),
  safetySettings: z.unknown().optional(),
}).passthrough();

interface GeminiPathAction {
  model: string;
  action: 'generateContent' | 'streamGenerateContent';
}

function parseGeminiModelAction(raw: string): GeminiPathAction | null {
  const marker = raw.lastIndexOf(':');
  if (marker <= 0) return null;

  const action = raw.slice(marker + 1) as GeminiPathAction['action'];
  if (action !== 'generateContent' && action !== 'streamGenerateContent') return null;

  return {
    model: raw.slice(0, marker),
    action,
  };
}

function estimateGeminiRequestTokens(payload: z.infer<typeof geminiGenerateContentSchema>): number {
  const contents = Array.isArray(payload.contents) ? payload.contents : [];
  let tokenEstimate = 0;

  for (const entry of contents) {
    const parts = Array.isArray((entry as any).parts) ? (entry as any).parts : [];
    for (const part of parts) {
      if (part && typeof part === 'object') {
        const text = typeof (part as any).text === 'string' ? (part as any).text : '';
        if (text) {
          tokenEstimate += Math.ceil(text.length / 4);
          continue;
        }

        if ('inlineData' in part || 'fileData' in part || 'functionCall' in part || 'functionResponse' in part) {
          tokenEstimate += 250;
        }
      } else if (typeof part === 'string') {
        tokenEstimate += Math.ceil(part.length / 4);
      } else {
        tokenEstimate += 50;
      }
    }
  }

  return Math.max(1, tokenEstimate);
}

function getGeminiUsageTokenTotals(payload: unknown): { prompt: number; completion: number; total: number } {
  const usage = (payload as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } } )?.usageMetadata;
  return {
    prompt: usage?.promptTokenCount ?? 0,
    completion: usage?.candidatesTokenCount ?? 0,
    total: usage?.totalTokenCount ?? 0,
  };
}

function extractGeminiSseText(chunk: Record<string, unknown>): number {
  const parts = (chunk as { candidates?: Array<{ content?: { parts?: unknown[] } }> }).candidates?.[0]?.content?.parts ?? [];
  if (!Array.isArray(parts) || parts.length === 0) return 0;

  let chars = 0;
  for (const part of parts) {
    if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
      chars += (part as { text: string }).text.length;
    }
  }
  return Math.ceil(chars / 4);
}

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
  thought_signature: z.string().optional(),
});

const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.string(),
  name: z.string().optional(),
});

const chatTextContentPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const chatImageContentPartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string().min(1),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
});

const chatVideoContentPartSchema = z.object({
  type: z.literal('video_url'),
  video_url: z.object({
    url: z.string().min(1),
  }),
});

const userContentSchema = z.union([
  z.string(),
  z.array(z.union([chatTextContentPartSchema, chatImageContentPartSchema, chatVideoContentPartSchema])).min(1),
]);

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: userContentSchema,
  name: z.string().optional(),
});

const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.string().nullable().optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
}).refine((msg) => {
  const hasContent = typeof msg.content === 'string' && msg.content.length > 0;
  const hasToolCalls = (msg.tool_calls?.length ?? 0) > 0;
  return hasContent || hasToolCalls;
}, {
  message: 'assistant messages must include non-empty content or tool_calls',
});

const toolMessageSchema = z.object({
  role: z.literal('tool'),
  content: z.string(),
  tool_call_id: z.string().min(1),
  name: z.string().optional(),
});

const toolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

const toolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string().min(1),
    }),
  }),
]);

const chatCompletionSchema = z.object({
  messages: z.array(z.union([
    systemMessageSchema,
    userMessageSchema,
    assistantMessageSchema,
    toolMessageSchema,
  ])).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  tool_choice: toolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
});

const embeddingInputSchema: z.ZodType<EmbeddingInput> = z.union([
  z.string(),
  z.array(z.string()).min(1),
  z.array(z.number()).min(1),
  z.array(z.array(z.number()).min(1)).min(1),
]);

const embeddingsSchema = z.object({
  input: embeddingInputSchema,
  model: z.string().optional(),
  encoding_format: z.enum(['float', 'base64']).optional(),
  dimensions: z.number().int().positive().optional(),
  user: z.string().optional(),
});

const imageGenerationSchema: z.ZodType<ImageGenerationRequest> = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  n: z.number().int().min(1).max(1).optional(),
  size: z.string().optional(),
  quality: z.enum(['auto', 'standard', 'hd', 'low', 'medium', 'high']).optional(),
  response_format: z.enum(['url', 'b64_json']).optional(),
  style: z.enum(['vivid', 'natural']).optional(),
  user: z.string().optional(),
});

const speechSchema: z.ZodType<SpeechRequest> = z.object({
  input: z.string().min(1),
  voice: z.string().min(1),
  model: z.string().optional(),
  response_format: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']).optional(),
  speed: z.number().min(0.25).max(4).optional(),
  instructions: z.string().optional(),
  user: z.string().optional(),
});

const realtimeSessionSchema: z.ZodType<RealtimeSessionRequest> = z.object({
  model: z.string().optional(),
  provider: z.literal('google').optional(),
  instructions: z.string().optional(),
  voice: z.string().min(1).optional(),
  response_modalities: z.array(z.enum(['AUDIO', 'TEXT'])).min(1).max(2).optional(),
  input_audio_transcription: z.boolean().optional(),
  output_audio_transcription: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  expires_in_seconds: z.number().int().min(60).max(20 * 60 * 60).optional(),
  user: z.string().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  tool_choice: toolChoiceSchema.optional(),
});

const multipartParser = express.raw({
  type: (req) => {
    const contentType = req.headers['content-type'];
    return typeof contentType === 'string'
      && contentType.toLowerCase().startsWith('multipart/form-data');
  },
  limit: '25mb',
});

const AUDIO_TEXT_FORMATS = new Set<AudioTextResponseFormat>([
  'json',
  'text',
  'srt',
  'verbose_json',
  'vtt',
]);
const AUDIO_TIMESTAMP_GRANULARITIES = new Set(['word', 'segment']);

type AudioTextOperation = 'transcription' | 'translation';
type ImageOperation = 'edit' | 'variation';

interface MultipartPart {
  name: string;
  filename?: string;
  contentType: string;
  data: Buffer;
}

type ParsedAudioTextRequest =
  | { ok: true; request: AudioTranscriptionRequest | AudioTranslationRequest }
  | { ok: false; message: string };

type ParsedImageRequest =
  | { ok: true; request: ImageEditRequest | ImageVariationRequest }
  | { ok: false; message: string };

function authenticateProxyRequest(req: Request, res: Response): boolean {
  // Direct loopback requests may skip the key check. Reverse-proxied public
  // requests also arrive from 127.0.0.1, but Caddy adds forwarding headers;
  // those requests must still authenticate with the unified API key.
  // `trust proxy` stays disabled, so forwarding headers never control req.ip.
  const isLocal = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
  const isForwarded = Boolean(
    req.headers['x-forwarded-for']
    || req.headers['x-forwarded-proto']
    || req.headers.forwarded,
  );
  if (isLocal && !isForwarded) return true;

  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return false;
  }

  return true;
}

function parseAudioTextRequest(req: Request, operation: AudioTextOperation): ParsedAudioTextRequest {
  const contentType = req.headers['content-type'] ?? '';
  const boundary = parseMultipartBoundary(String(contentType));
  if (!boundary || !Buffer.isBuffer(req.body)) {
    return { ok: false, message: 'audio requests must use multipart/form-data' };
  }

  const parts = parseMultipartBody(req.body, boundary);
  const fields = new Map<string, string[]>();
  let file: AudioFileUpload | undefined;

  for (const part of parts) {
    if (part.filename) {
      if (part.name === 'file' && !file) {
        file = {
          filename: part.filename,
          contentType: part.contentType || 'application/octet-stream',
          data: new Uint8Array(part.data),
        };
      }
      continue;
    }

    const existing = fields.get(part.name) ?? [];
    existing.push(part.data.toString('utf8'));
    fields.set(part.name, existing);
  }

  const getField = (name: string) => {
    const values = fields.get(name);
    return values?.[values.length - 1];
  };

  const responseFormat = getField('response_format') as AudioTextResponseFormat | undefined;
  if (responseFormat && !AUDIO_TEXT_FORMATS.has(responseFormat)) {
    return { ok: false, message: `response_format '${responseFormat}' is not supported` };
  }

  const temperatureRaw = getField('temperature');
  let temperature: number | undefined;
  if (temperatureRaw !== undefined && temperatureRaw !== '') {
    temperature = Number(temperatureRaw);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      return { ok: false, message: 'temperature must be a number between 0 and 2' };
    }
  }

  const url = getField('url');
  if (!file && !url) {
    return { ok: false, message: "audio requests must include a 'file' upload or 'url' field" };
  }

  const base = {
    model: getField('model'),
    file,
    url,
    prompt: getField('prompt'),
    response_format: responseFormat,
    temperature,
    user: getField('user'),
  };

  if (operation === 'translation') {
    return { ok: true, request: base satisfies AudioTranslationRequest };
  }

  const timestampGranularities = [
    ...(fields.get('timestamp_granularities[]') ?? []),
    ...(fields.get('timestamp_granularities') ?? []),
  ];
  for (const granularity of timestampGranularities) {
    if (!AUDIO_TIMESTAMP_GRANULARITIES.has(granularity)) {
      return { ok: false, message: "timestamp_granularities must contain only 'word' or 'segment'" };
    }
  }

  return {
    ok: true,
    request: {
      ...base,
      language: getField('language'),
      timestamp_granularities: timestampGranularities.length > 0
        ? timestampGranularities as Array<'word' | 'segment'>
        : undefined,
    } satisfies AudioTranscriptionRequest,
  };
}

function parseImageRequest(req: Request, operation: ImageOperation): ParsedImageRequest {
  const contentType = req.headers['content-type'] ?? '';
  const boundary = parseMultipartBoundary(String(contentType));
  if (!boundary || !Buffer.isBuffer(req.body)) {
    return { ok: false, message: 'image requests must use multipart/form-data' };
  }

  const parts = parseMultipartBody(req.body, boundary);
  const fields = new Map<string, string[]>();
  const images: ImageFileUpload[] = [];
  let mask: ImageFileUpload | undefined;

  for (const part of parts) {
    if (part.filename) {
      const upload = {
        filename: part.filename,
        contentType: part.contentType || 'application/octet-stream',
        data: new Uint8Array(part.data),
      } satisfies ImageFileUpload;
      if (part.name === 'image') images.push(upload);
      if (part.name === 'mask' && !mask) mask = upload;
      continue;
    }

    const existing = fields.get(part.name) ?? [];
    existing.push(part.data.toString('utf8'));
    fields.set(part.name, existing);
  }

  const getField = (name: string) => {
    const values = fields.get(name);
    return values?.[values.length - 1];
  };

  const responseFormat = getField('response_format') as 'url' | 'b64_json' | undefined;
  if (responseFormat && responseFormat !== 'url' && responseFormat !== 'b64_json') {
    return { ok: false, message: `response_format '${responseFormat}' is not supported` };
  }

  const nRaw = getField('n');
  let n: number | undefined;
  if (nRaw !== undefined && nRaw !== '') {
    n = Number(nRaw);
    if (!Number.isInteger(n) || n < 1 || n > 1) {
      return { ok: false, message: 'n must be 1 for the configured image provider' };
    }
  }

  if (images.length === 0) {
    return { ok: false, message: "image requests must include at least one 'image' upload" };
  }

  const base = {
    model: getField('model'),
    n,
    size: getField('size'),
    response_format: responseFormat,
    user: getField('user'),
  };

  if (operation === 'variation') {
    return {
      ok: true,
      request: {
        ...base,
        image: images[0],
      } satisfies ImageVariationRequest,
    };
  }

  const prompt = getField('prompt');
  if (!prompt) {
    return { ok: false, message: "image edits must include a non-empty 'prompt' field" };
  }

  return {
    ok: true,
    request: {
      ...base,
      images,
      mask,
      prompt,
    } satisfies ImageEditRequest,
  };
}

function parseMultipartBoundary(contentType: string): string | null {
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2] ?? null;
}

function parseMultipartBody(body: Buffer, boundary: string): MultipartPart[] {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const sections = splitBuffer(body, boundaryBuffer);
  const parts: MultipartPart[] = [];

  for (let section of sections) {
    if (section.length === 0) continue;
    if (section.subarray(0, 2).toString('ascii') === '--') continue;
    if (section.subarray(0, 2).toString('ascii') === '\r\n') section = section.subarray(2);
    if (section.subarray(section.length - 2).toString('ascii') === '\r\n') {
      section = section.subarray(0, section.length - 2);
    }

    const headerEnd = section.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd < 0) continue;

    const headers = section.subarray(0, headerEnd).toString('latin1').split('\r\n');
    const data = section.subarray(headerEnd + 4);
    const disposition = headers.find(h => h.toLowerCase().startsWith('content-disposition:')) ?? '';
    const contentTypeHeader = headers.find(h => h.toLowerCase().startsWith('content-type:'));
    const { name, filename } = parseContentDisposition(disposition);
    if (!name) continue;

    parts.push({
      name,
      filename,
      contentType: contentTypeHeader?.split(':').slice(1).join(':').trim() ?? 'text/plain',
      data,
    });
  }

  return parts;
}

function splitBuffer(buffer: Buffer, separator: Buffer): Buffer[] {
  const result: Buffer[] = [];
  let offset = 0;
  let index = buffer.indexOf(separator, offset);

  while (index !== -1) {
    result.push(buffer.subarray(offset, index));
    offset = index + separator.length;
    index = buffer.indexOf(separator, offset);
  }

  result.push(buffer.subarray(offset));
  return result;
}

function parseContentDisposition(header: string): { name?: string; filename?: string } {
  const params: { name?: string; filename?: string } = {};
  for (const segment of header.split(';').slice(1)) {
    const [rawKey, ...rawValueParts] = segment.trim().split('=');
    const rawValue = rawValueParts.join('=');
    const value = rawValue.replace(/^"|"$/g, '');
    if (rawKey === 'name') params.name = value;
    if (rawKey === 'filename') params.filename = value;
  }
  return params;
}

function estimateEmbeddingTokens(input: EmbeddingInput): number {
  if (typeof input === 'string') return Math.ceil(input.length / 4);

  let total = 0;
  for (const item of input) {
    if (typeof item === 'string') {
      total += Math.ceil(item.length / 4);
    } else if (Array.isArray(item)) {
      total += item.length;
    } else {
      total += 1;
    }
  }
  return total;
}

function recordRouteFailure(route: RouteResult, failure: ClassifiedProviderError, message: string) {
  if (failure.category === 'rate_limit') {
    recordRateLimitHit(route.modelDbId);
  } else {
    recordModelFailure(route.modelDbId, failure.category, message);
  }
}

function prepareProviderRetry(
  route: RouteResult,
  failure: ClassifiedProviderError,
  err: any,
  skipKeys: Set<string>,
  skipModels: Set<number>,
) {
  const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
  skipKeys.add(skipId);
  if (failure.keyCooldownMs > 0) {
    setCooldown(route.platform, route.modelId, route.keyId, failure.keyCooldownMs);
  }
  if (failure.skipModel) {
    skipModels.add(route.modelDbId);
  }
  recordRouteFailure(route, failure, err.message);
}

function recordTerminalProviderFailure(route: RouteResult, failure: ClassifiedProviderError, err: any) {
  if (failure.skipModel || failure.category === 'rate_limit') {
    recordRouteFailure(route, failure, err.message);
  }
}

async function handleGeminiGenerateContentRequest(
  req: Request,
  res: Response,
  model: string,
  isStream: boolean,
) {
  const start = Date.now();
  if (!authenticateProxyRequest(req, res)) return;

  const parsed = geminiGenerateContentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  let requestedModel: string;
  try {
    requestedModel = decodeURIComponent(model);
  } catch {
    res.status(400).json({
      error: {
        message: 'Invalid URL-encoded model id.',
        type: 'invalid_request_error',
      },
    });
    return;
  }
  const db = getDb();
  const catalogRow = db.prepare(`
    SELECT id, enabled, platform, is_free
    FROM models
    WHERE model_id = ?
  `).get(requestedModel) as { id: number; enabled: number; platform: string; is_free: number } | undefined;

  if (!catalogRow || catalogRow.platform !== 'google') {
    res.status(400).json({
      error: {
        message: `Model '${requestedModel}' is not available via Gemini compatibility. Omit or use a Google model id.`,
        type: 'invalid_request_error',
        code: 'model_not_found',
      },
    });
    return;
  }

  if (catalogRow.enabled !== 1) {
    res.status(400).json({
      error: {
        message: `Model '${requestedModel}' is disabled. Use another enabled Google model path, e.g. /gemini/v1beta/models/gemini-2.5-flash:generateContent.`,
        type: 'invalid_request_error',
        code: 'model_not_found',
      },
    });
    return;
  }

  // Bridge free-tier-only enforcement into the Gemini-native compatibility
  // path: this route resolves models straight from the catalog and never
  // went through resolveRoutableModel(), so a paid Google model would
  // otherwise slip past the same gate every other explicit-model block uses.
  if (catalogRow.is_free !== 1 && isFreeOnlyMode(db)) {
    sendResolutionError(res, requestedModel, { kind: 'paid_blocked' });
    return;
  }

  const requestBody = parsed.data;
  const estimatedInputTokens = estimateGeminiRequestTokens(requestBody);
  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(
        estimatedInputTokens,
        skipKeys.size > 0 ? skipKeys : undefined,
        catalogRow.id,
        skipModels.size > 0 ? skipModels : undefined,
        undefined,
        'google',
      );
    } catch (err: any) {
      if (lastError) {
        res.status(429).json({
          error: {
            message: `All Gemini models rate-limited. Last error: ${lastError.message}`,
            type: 'rate_limit_error',
          },
        });
      } else {
        res.status(err.status ?? 503).json({
          error: {
            message: err.message,
            type: 'routing_error',
          },
        });
      }
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      const endpoint = isStream
        ? `${GOOGLE_GENERATE_API_BASE}/models/${encodeURIComponent(route.modelId)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(route.apiKey)}`
        : `${GOOGLE_GENERATE_API_BASE}/models/${encodeURIComponent(route.modelId)}:generateContent?key=${encodeURIComponent(route.apiKey)}`;

      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!upstream.ok) {
        const errPayload = await upstream.json().catch(() => ({}) as Record<string, unknown>);
        throw new Error(`Gemini API error ${upstream.status}: ${(errPayload as { error?: { message?: string } }).error?.message ?? upstream.statusText}`);
      }

      if (isStream) {
        const upstreamBody = upstream.body;
        if (!upstreamBody) throw new Error('No response body');

        const reader = upstreamBody.getReader();
        const decoder = new TextDecoder();
        let outputChunkText = '';
        let streamOutputTokens = 0;
        let completed = false;
        let sawDoneFrame = false;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));

        try {
          while (!completed) {
            const chunk = await reader.read();
            if (chunk.done) {
              completed = true;
              break;
            }

            const rawChunk = decoder.decode(chunk.value, { stream: true });
            outputChunkText += rawChunk;

            const completeBoundary = outputChunkText.lastIndexOf('\n');
            const parseWindow = completeBoundary >= 0 ? outputChunkText.slice(0, completeBoundary + 1) : '';
            outputChunkText = completeBoundary >= 0 ? outputChunkText.slice(completeBoundary + 1) : outputChunkText;

            const lines = parseWindow.split('\n');
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;

              const raw = trimmed.slice(5).trimStart();
              if (raw === '[DONE]') {
                completed = true;
                sawDoneFrame = true;
                continue;
              }
              if (!raw.startsWith('{')) continue;
              try {
                const parsedChunk = JSON.parse(raw) as Record<string, unknown>;
                streamOutputTokens += extractGeminiSseText(parsedChunk);
              } catch {
                // Ignore malformed JSON frames but keep streaming payload intact.
              }
            }

            res.write(parseWindow);
          }

          if (outputChunkText.length > 0) {
            for (const line of outputChunkText.split('\n')) {
              const trimmed = line.trim();
              if (trimmed.startsWith('data:')) {
                const raw = trimmed.slice(5).trimStart();
                if (raw !== '[DONE]' && raw.startsWith('{')) {
                  try {
                    const parsedChunk = JSON.parse(raw) as Record<string, unknown>;
                    streamOutputTokens += extractGeminiSseText(parsedChunk);
                  } catch {
                    // Ignore malformed JSON chunks.
                  }
                }
              }
            }

            res.write(outputChunkText);
          }

        } catch (streamErr: any) {
          const payload = { error: { message: `Gemini provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();

          logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, 0, Date.now() - start, streamErr.message);
          return;
        }

        if (!sawDoneFrame) {
          res.write('data: [DONE]\n\n');
        }
        res.end();

        recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + streamOutputTokens);
        recordSuccess(route.modelDbId);
        logRequest(route.platform, route.modelId, 'success', estimatedInputTokens, streamOutputTokens, Date.now() - start, null);
        return;
      }

      const payload = await upstream.json();
      const usage = getGeminiUsageTokenTotals(payload);

      recordTokens(route.platform, route.modelId, route.keyId, usage.total || estimatedInputTokens);
      recordSuccess(route.modelDbId);

      res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
      if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
      res.json(payload);

      logRequest(route.platform, route.modelId, 'success', usage.prompt, usage.completion, Date.now() - start, null);
      return;
    } catch (err: any) {
      const latency = Date.now() - start;
      logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, 0, latency, err.message);

      const failure = classifyProviderError(err);
      const canFallback = canRetryProviderFailure(failure, requestedModel);
      if (canFallback) {
        prepareProviderRetry(route, failure, err, skipKeys, skipModels);
        lastError = err;
        console.log(`[Proxy] ${err.message.slice(0, 60)} from ${route.displayName}, falling back (${failure.category}, attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      recordTerminalProviderFailure(route, failure, err);
      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${err.message}`,
          type: 'provider_error',
        },
      });
      return;
    }
  }

  res.status(429).json({
    error: {
      message: `All Gemini models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message}`,
      type: 'rate_limit_error',
    },
  });
}

geminiProxyRouter.post('/v1beta/models/:modelAction', async (req: Request, res: Response) => {
  const rawModelAction = Array.isArray(req.params.modelAction)
    ? req.params.modelAction.join(':')
    : req.params.modelAction;
  const parsed = parseGeminiModelAction(rawModelAction);
  if (!parsed) {
    res.status(400).json({
      error: {
        message: 'Invalid Gemini path. Use /v1beta/models/{model}:generateContent or :streamGenerateContent.',
        type: 'invalid_request_error',
      },
    });
    return;
  }

  await handleGeminiGenerateContentRequest(req, res, parsed.model, parsed.action === 'streamGenerateContent');
});

proxyRouter.post('/chat/completions', async (req: Request, res: Response) => {
  const start = Date.now();

  if (!authenticateProxyRequest(req, res)) return;

  // Validate request
  const parsed = chatCompletionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const { model: rawRequestedModel, temperature, max_tokens, top_p, stream, tools, tool_choice, parallel_tool_calls } = parsed.data;
  const requestedModel = rawRequestedModel === 'auto' ? undefined : rawRequestedModel;
  const messages: ChatMessage[] = parsed.data.messages.map((m): ChatMessage => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content ?? null,
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_calls ? { tool_calls: m.tool_calls.map(tc => ({
          id: tc.id,
          type: tc.type,
          function: tc.function,
          thought_signature: tc.thought_signature,
        })) } : {}),
      };
    }

    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        tool_call_id: m.tool_call_id,
        ...(m.name ? { name: m.name } : {}),
      };
    }

    return {
      role: m.role,
      content: m.content,
      ...(m.name ? { name: m.name } : {}),
    };
  });

  // Token estimation is intentionally a heuristic (~4 chars per token). Used
  // for routing decisions (skip a model whose budget is too small) and for
  // streaming bookkeeping where the provider doesn't echo a final usage count.
  // Non-streaming requests reconcile against the provider's real `usage` block
  // (see line ~340). Streaming will drift from real consumption — accepted
  // tradeoff because per-request usage isn't always returned mid-stream.
  const estimatedInputTokens = messages.reduce(
    (sum, m) => sum
      + estimateChatContentTokens(m.content)
      + estimateStructuredTokens(m.role === 'assistant' ? m.tool_calls : undefined),
    0,
  ) + estimateStructuredTokens(tools);
  const estimatedTotal = estimatedInputTokens + (max_tokens ?? 1000);
  const needsVision = requiresVision(messages);
  const needsVideo = requiresVideo(messages);
  const requiredCapability = needsVideo ? 'video' : needsVision ? 'vision' : null;

  // Explicit `model` field pins routing. If the catalog has no enabled row
  // matching the requested id, return 400 — silently auto-routing to a
  // different model would be surprising to OpenAI-compatible clients.
  // Sticky-session is the fallback when no `model` field was sent at all.
  let preferredModel: number | undefined;
  if (requestedModel) {
    const db = getDb();
    const resolution = resolveRoutableModel(db, requestedModel, requiredCapability);
    if (resolution.kind !== 'ok') {
      sendResolutionError(res, requestedModel, resolution);
      return;
    }
    preferredModel = resolution.id;
  } else if (!requiredCapability) {
    preferredModel = getStickyModel(messages);
  }

  // Retry loop: on 429/rate limit, skip that model+key and try the next one
  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: any = null;

  // Surface fallback transparently: when an explicitly requested model is
  // replaced by another (rate-limited, no healthy key, or upstream failure),
  // echo the requested id + the reason so clients can show it instead of a
  // silent substitution. Fallback itself stays enabled by design.
  const setRoutingHeaders = (route: RouteResult, attempt: number) => {
    res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
    if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
    if (requestedModel && preferredModel != null && route.modelDbId !== preferredModel) {
      const reason = lastError?.message
        ? String(lastError.message).slice(0, 200)
        : 'requested model unavailable (rate-limited or no healthy key)';
      res.setHeader('X-Requested-Model', requestedModel);
      res.setHeader('X-Fallback-Reason', reason.replace(/[\r\n]+/g, ' '));
    }
  };

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = requiredCapability
        ? routeCapabilityRequest(
          requiredCapability,
          estimatedTotal,
          skipKeys.size > 0 ? skipKeys : undefined,
          requestedModel,
          skipModels.size > 0 ? skipModels : undefined,
        )
        : routeRequest(
          estimatedTotal,
          skipKeys.size > 0 ? skipKeys : undefined,
          preferredModel,
          skipModels.size > 0 ? skipModels : undefined,
        );
    } catch (err: any) {
      // No more models available
      if (lastError) {
        res.status(429).json({
          error: {
            message: `All models rate-limited. Last error: ${lastError.message}`,
            type: 'rate_limit_error',
          },
        });
      } else {
        res.status(err.status ?? 503).json({
          error: { message: err.message, type: 'routing_error' },
        });
      }
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      if (stream) {
        // Lazy header set: pre-stream errors stay retryable (no headers sent yet);
        // mid-stream errors emit an `error` SSE frame so the client sees a real signal
        // instead of a silently truncated stream.
        let totalOutputTokens = 0;
        let streamStarted = false;
        try {
          const gen = route.provider.streamChatCompletion(
            route.apiKey, messages, route.modelId,
            { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls },
          );

          for await (const chunk of gen) {
            if (!streamStarted) {
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
              setRoutingHeaders(route, attempt);
              streamStarted = true;
            }
            const text = chunk.choices[0]?.delta?.content ?? '';
            totalOutputTokens += Math.ceil(text.length / 4);
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }

          if (!streamStarted) {
            // Upstream returned no chunks — emit minimal successful stream.
            res.setHeader('Content-Type', 'text/event-stream');
            setRoutingHeaders(route, attempt);
          }
          res.write('data: [DONE]\n\n');
          res.end();

          recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
          recordSuccess(route.modelDbId);
          setStickyModel(messages, route.modelDbId);
          logRequest(route.platform, route.modelId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null);
          return;
        } catch (streamErr: any) {
          if (streamStarted) {
            // Mid-stream error — finish the SSE response cleanly instead of leaving
            // the client hanging or letting Express's default handler take over.
            // Full upstream message goes to the log; the client sees a generic
            // message so we don't leak provider internals into a partial stream.
            console.error(`[Proxy] Mid-stream error from ${route.displayName}:`, streamErr.message);
            const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* socket gone */ }
            try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
            logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, streamErr.message);
            return;
          }
          // Pre-stream error — bubble to outer retry/502 handler.
          throw streamErr;
        }
      } else {
        const result = await route.provider.chatCompletion(
          route.apiKey, messages, route.modelId,
          { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls },
        );

        const totalTokens = result.usage?.total_tokens ?? 0;
        recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
        recordSuccess(route.modelDbId);
        setStickyModel(messages, route.modelDbId);

        setRoutingHeaders(route, attempt);
        res.json(result);

        logRequest(
          route.platform, route.modelId, 'success',
          result.usage?.prompt_tokens ?? 0,
          result.usage?.completion_tokens ?? 0,
          Date.now() - start, null,
        );
        return;
      }
    } catch (err: any) {
      const latency = Date.now() - start;
      logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, 0, latency, err.message);

      const failure = classifyProviderError(err);
      const canFallback = canRetryProviderFailure(failure, requestedModel);

      if (canFallback) {
        prepareProviderRetry(route, failure, err, skipKeys, skipModels);
        lastError = err;
        console.log(`[Proxy] ${err.message.slice(0, 60)} from ${route.displayName}, falling back (${failure.category}, attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      recordTerminalProviderFailure(route, failure, err);

      // Non-retryable error (auth, 4xx, etc.): don't retry
      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${err.message}`,
          type: 'provider_error',
        },
      });
      return;
    }
  }

  // Exhausted all retries
  res.status(429).json({
    error: {
      message: `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message}`,
      type: 'rate_limit_error',
    },
  });
});

proxyRouter.post('/embeddings', async (req: Request, res: Response) => {
  const start = Date.now();

  if (!authenticateProxyRequest(req, res)) return;

  const parsed = embeddingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const { input, model: rawRequestedModel, encoding_format, dimensions, user } = parsed.data;
  const requestedModel = rawRequestedModel === 'auto' ? undefined : rawRequestedModel;

  if (requestedModel) {
    const db = getDb();
    const resolution = resolveRoutableModel(db, requestedModel, 'embeddings');
    if (resolution.kind !== 'ok') {
      sendResolutionError(res, requestedModel, resolution);
      return;
    }
  }

  const estimatedTokens = estimateEmbeddingTokens(input);
  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeCapabilityRequest(
        'embeddings',
        estimatedTokens,
        skipKeys.size > 0 ? skipKeys : undefined,
        requestedModel,
        skipModels.size > 0 ? skipModels : undefined,
      );
    } catch (err: any) {
      res.status(err.status ?? 503).json({
        error: {
          message: lastError ? `All embeddings models rate-limited. Last error: ${lastError.message}` : err.message,
          type: lastError ? 'rate_limit_error' : 'routing_error',
        },
      });
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      const result = await route.provider.createEmbedding(
        route.apiKey,
        input,
        route.modelId,
        { encoding_format, dimensions, user },
      );

      const totalTokens = result.usage?.total_tokens ?? estimatedTokens;
      recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
      recordSuccess(route.modelDbId);

      res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
      if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
      res.json(result);

      logRequest(
        route.platform, route.modelId, 'success',
        result.usage?.prompt_tokens ?? estimatedTokens,
        0,
        Date.now() - start, null,
      );
      return;
    } catch (err: any) {
      const latency = Date.now() - start;
      logRequest(route.platform, route.modelId, 'error', estimatedTokens, 0, latency, err.message);

      const failure = classifyProviderError(err);
      if (canRetryProviderFailure(failure, requestedModel)) {
        prepareProviderRetry(route, failure, err, skipKeys, skipModels);
        lastError = err;
        console.log(`[Proxy] ${err.message.slice(0, 60)} from ${route.displayName}, falling back (${failure.category}, attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      recordTerminalProviderFailure(route, failure, err);

      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${err.message}`,
          type: 'provider_error',
        },
      });
      return;
    }
  }

  res.status(429).json({
    error: {
      message: `All embeddings models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message}`,
      type: 'rate_limit_error',
    },
  });
});

proxyRouter.post('/images/generations', async (req: Request, res: Response) => {
  const start = Date.now();

  if (!authenticateProxyRequest(req, res)) return;

  const parsed = imageGenerationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const request = {
    ...parsed.data,
    model: parsed.data.model === 'auto' ? undefined : parsed.data.model,
    response_format: parsed.data.response_format ?? 'b64_json',
  } satisfies ImageGenerationRequest;
  const requestedModel = request.model;

  if (requestedModel) {
    const db = getDb();
    const resolution = resolveRoutableModel(db, requestedModel, 'image_generation');
    if (resolution.kind !== 'ok') {
      sendResolutionError(res, requestedModel, resolution);
      return;
    }
  }

  const estimatedTokens = Math.ceil(request.prompt.length / 4) + 1000;
  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeCapabilityRequest(
        'image_generation',
        estimatedTokens,
        skipKeys.size > 0 ? skipKeys : undefined,
        requestedModel,
        skipModels.size > 0 ? skipModels : undefined,
      );
    } catch (err: any) {
      res.status(err.status ?? 503).json({
        error: {
          message: lastError ? `All image generation models rate-limited. Last error: ${lastError.message}` : err.message,
          type: lastError ? 'rate_limit_error' : 'routing_error',
        },
      });
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      const result = await route.provider.createImage(route.apiKey, request, route.modelId);

      recordTokens(route.platform, route.modelId, route.keyId, estimatedTokens);
      recordSuccess(route.modelDbId);

      res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
      if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
      res.json(result);

      logRequest(route.platform, route.modelId, 'success', estimatedTokens, 0, Date.now() - start, null);
      return;
    } catch (err: any) {
      const latency = Date.now() - start;
      logRequest(route.platform, route.modelId, 'error', estimatedTokens, 0, latency, err.message);

      const failure = classifyProviderError(err);
      if (canRetryProviderFailure(failure, requestedModel)) {
        prepareProviderRetry(route, failure, err, skipKeys, skipModels);
        lastError = err;
        console.log(`[Proxy] ${err.message.slice(0, 60)} from ${route.displayName}, falling back (${failure.category}, attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      recordTerminalProviderFailure(route, failure, err);

      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${err.message}`,
          type: 'provider_error',
        },
      });
      return;
    }
  }

  res.status(429).json({
    error: {
      message: `All image generation models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message}`,
      type: 'rate_limit_error',
    },
  });
});

proxyRouter.post('/images/edits', multipartParser, async (req: Request, res: Response) => {
  await handleImageRequest(req, res, 'edit');
});

proxyRouter.post('/images/variations', multipartParser, async (req: Request, res: Response) => {
  await handleImageRequest(req, res, 'variation');
});

async function handleImageRequest(req: Request, res: Response, operation: ImageOperation) {
  const start = Date.now();

  if (!authenticateProxyRequest(req, res)) return;

  const parsed = parseImageRequest(req, operation);
  if (!parsed.ok) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.message}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const capability = operation === 'edit' ? 'image_edit' : 'image_variation';
  const actionLabel = operation === 'edit' ? 'image edits' : 'image variations';
  const request = {
    ...parsed.request,
    model: parsed.request.model === 'auto' ? undefined : parsed.request.model,
    response_format: parsed.request.response_format ?? 'b64_json',
  };
  const requestedModel = request.model;

  if (requestedModel) {
    const db = getDb();
    const resolution = resolveRoutableModel(db, requestedModel, capability);
    if (resolution.kind !== 'ok') {
      sendResolutionError(res, requestedModel, resolution);
      return;
    }
  }

  const estimatedTokens = estimateImageRequestTokens(request);
  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeCapabilityRequest(
        capability,
        estimatedTokens,
        skipKeys.size > 0 ? skipKeys : undefined,
        requestedModel,
        skipModels.size > 0 ? skipModels : undefined,
      );
    } catch (err: any) {
      res.status(err.status ?? 503).json({
        error: {
          message: lastError ? `All ${actionLabel} models rate-limited. Last error: ${lastError.message}` : err.message,
          type: lastError ? 'rate_limit_error' : 'routing_error',
        },
      });
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      const result = operation === 'edit'
        ? await route.provider.editImage(route.apiKey, request as ImageEditRequest, route.modelId)
        : await route.provider.createImageVariation(route.apiKey, request as ImageVariationRequest, route.modelId);

      recordTokens(route.platform, route.modelId, route.keyId, estimatedTokens);
      recordSuccess(route.modelDbId);

      res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
      if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
      res.json(result);

      logRequest(route.platform, route.modelId, 'success', estimatedTokens, 0, Date.now() - start, null);
      return;
    } catch (err: any) {
      const latency = Date.now() - start;
      logRequest(route.platform, route.modelId, 'error', estimatedTokens, 0, latency, err.message);

      const failure = classifyProviderError(err);
      if (canRetryProviderFailure(failure, requestedModel)) {
        prepareProviderRetry(route, failure, err, skipKeys, skipModels);
        lastError = err;
        console.log(`[Proxy] ${err.message.slice(0, 60)} from ${route.displayName}, falling back (${failure.category}, attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      recordTerminalProviderFailure(route, failure, err);

      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${err.message}`,
          type: 'provider_error',
        },
      });
      return;
    }
  }

  res.status(429).json({
    error: {
      message: `All ${actionLabel} models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message}`,
      type: 'rate_limit_error',
    },
  });
}

function estimateImageRequestTokens(request: ImageEditRequest | ImageVariationRequest): number {
  const promptTokens = 'prompt' in request ? Math.ceil(request.prompt.length / 4) : 0;
  return promptTokens + 1000;
}

proxyRouter.post('/audio/transcriptions', multipartParser, async (req: Request, res: Response) => {
  await handleAudioTextRequest(req, res, 'transcription');
});

proxyRouter.post('/audio/translations', multipartParser, async (req: Request, res: Response) => {
  await handleAudioTextRequest(req, res, 'translation');
});

async function handleAudioTextRequest(req: Request, res: Response, operation: AudioTextOperation) {
  const start = Date.now();

  if (!authenticateProxyRequest(req, res)) return;

  const parsed = parseAudioTextRequest(req, operation);
  if (!parsed.ok) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.message}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const capability = operation === 'transcription' ? 'transcription' : 'translation';
  const actionLabel = operation === 'transcription' ? 'transcription' : 'translation';
  const request = {
    ...parsed.request,
    model: parsed.request.model === 'auto' ? undefined : parsed.request.model,
  };
  const requestedModel = request.model;

  if (requestedModel) {
    const db = getDb();
    const resolution = resolveRoutableModel(db, requestedModel, capability);
    if (resolution.kind !== 'ok') {
      sendResolutionError(res, requestedModel, resolution);
      return;
    }
  }

  const estimatedTokens = estimateAudioTextTokens(request);
  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeCapabilityRequest(
        capability,
        estimatedTokens,
        skipKeys.size > 0 ? skipKeys : undefined,
        requestedModel,
        skipModels.size > 0 ? skipModels : undefined,
      );
    } catch (err: any) {
      res.status(err.status ?? 503).json({
        error: {
          message: lastError ? `All audio ${actionLabel} models rate-limited. Last error: ${lastError.message}` : err.message,
          type: lastError ? 'rate_limit_error' : 'routing_error',
        },
      });
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      const result = operation === 'transcription'
        ? await route.provider.transcribeAudio(route.apiKey, request as AudioTranscriptionRequest, route.modelId)
        : await route.provider.translateAudio(route.apiKey, request as AudioTranslationRequest, route.modelId);

      recordTokens(route.platform, route.modelId, route.keyId, estimatedTokens);
      recordSuccess(route.modelDbId);

      res.setHeader('Content-Type', result.contentType);
      res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
      if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));

      if (result.contentType.includes('application/json')) {
        res.send(JSON.stringify(result.body));
      } else {
        res.send(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
      }

      logRequest(route.platform, route.modelId, 'success', estimatedTokens, 0, Date.now() - start, null);
      return;
    } catch (err: any) {
      const latency = Date.now() - start;
      logRequest(route.platform, route.modelId, 'error', estimatedTokens, 0, latency, err.message);

      const failure = classifyProviderError(err);
      if (canRetryProviderFailure(failure, requestedModel)) {
        prepareProviderRetry(route, failure, err, skipKeys, skipModels);
        lastError = err;
        console.log(`[Proxy] ${err.message.slice(0, 60)} from ${route.displayName}, falling back (${failure.category}, attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      recordTerminalProviderFailure(route, failure, err);

      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${err.message}`,
          type: 'provider_error',
        },
      });
      return;
    }
  }

  res.status(429).json({
    error: {
      message: `All audio ${actionLabel} models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message}`,
      type: 'rate_limit_error',
    },
  });
}

function estimateAudioTextTokens(request: AudioTranscriptionRequest | AudioTranslationRequest): number {
  const promptTokens = Math.ceil((request.prompt?.length ?? 0) / 4);
  const urlTokens = Math.ceil((request.url?.length ?? 0) / 4);
  return Math.max(100, promptTokens + urlTokens + 100);
}

function realtimeWebSocketNotSupported(_req: Request, res: Response) {
  res.status(400).json({
    error: {
      code: 'websocket_not_supported',
      message: 'FreeLLMAPI does not proxy realtime WebSocket sessions. To use Gemini Live realtime, call POST /v1/realtime/sessions to mint a session token, then connect directly to the returned connect_url using the Gemini Live WebSocket protocol.',
    },
  });
}

proxyRouter.get('/realtime', realtimeWebSocketNotSupported);
proxyRouter.post('/realtime', realtimeWebSocketNotSupported);

proxyRouter.post('/realtime/sessions', async (req: Request, res: Response) => {
  const start = Date.now();

  if (!authenticateProxyRequest(req, res)) return;

  const parsed = realtimeSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const request = {
    ...parsed.data,
    model: parsed.data.model === 'auto' ? undefined : parsed.data.model,
    provider: parsed.data.provider ?? 'google',
    response_modalities: parsed.data.response_modalities ?? ['AUDIO'],
    expires_in_seconds: parsed.data.expires_in_seconds ?? 30 * 60,
  } satisfies RealtimeSessionRequest;
  const requestedModel = request.model;

  if (requestedModel) {
    const db = getDb();
    const resolution = resolveRoutableModel(db, requestedModel, 'realtime_audio');
    if (resolution.kind !== 'ok') {
      sendResolutionError(res, requestedModel, resolution);
      return;
    }
  }

  const estimatedTokens = 1;
  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeCapabilityRequest(
        'realtime_audio',
        estimatedTokens,
        skipKeys.size > 0 ? skipKeys : undefined,
        requestedModel,
        skipModels.size > 0 ? skipModels : undefined,
      );
    } catch (err: any) {
      res.status(err.status ?? 503).json({
        error: {
          message: lastError ? `All realtime audio models rate-limited. Last error: ${lastError.message}` : err.message,
          type: lastError ? 'rate_limit_error' : 'routing_error',
        },
      });
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      const result = await route.provider.createRealtimeSession(route.apiKey, request, route.modelId);

      recordTokens(route.platform, route.modelId, route.keyId, estimatedTokens);
      recordSuccess(route.modelDbId);

      res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
      if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
      res.json(result);

      logRequest(route.platform, route.modelId, 'success', estimatedTokens, 0, Date.now() - start, null);
      return;
    } catch (err: any) {
      const latency = Date.now() - start;
      logRequest(route.platform, route.modelId, 'error', estimatedTokens, 0, latency, err.message);

      const failure = classifyProviderError(err);
      if (canRetryProviderFailure(failure, requestedModel)) {
        prepareProviderRetry(route, failure, err, skipKeys, skipModels);
        lastError = err;
        console.log(`[Proxy] ${err.message.slice(0, 60)} from ${route.displayName}, falling back (${failure.category}, attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      recordTerminalProviderFailure(route, failure, err);

      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${err.message}`,
          type: 'provider_error',
        },
      });
      return;
    }
  }

  res.status(429).json({
    error: {
      message: `All realtime audio models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message}`,
      type: 'rate_limit_error',
    },
  });
});

proxyRouter.post('/audio/speech', async (req: Request, res: Response) => {
  const start = Date.now();

  if (!authenticateProxyRequest(req, res)) return;

  const parsed = speechSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const request = {
    ...parsed.data,
    model: parsed.data.model === 'auto' ? undefined : parsed.data.model,
    response_format: parsed.data.response_format ?? 'wav',
  } satisfies SpeechRequest;
  const requestedModel = request.model;

  if (request.response_format && !['wav', 'pcm'].includes(request.response_format)) {
    res.status(400).json({
      error: {
        message: `response_format '${request.response_format}' is not currently supported by the configured speech provider. Use 'wav' or 'pcm'.`,
        type: 'invalid_request_error',
        code: 'unsupported_response_format',
      },
    });
    return;
  }

  if (requestedModel) {
    const db = getDb();
    const resolution = resolveRoutableModel(db, requestedModel, 'speech');
    if (resolution.kind !== 'ok') {
      sendResolutionError(res, requestedModel, resolution);
      return;
    }
  }

  const estimatedTokens = Math.ceil(request.input.length / 4);
  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeCapabilityRequest(
        'speech',
        estimatedTokens,
        skipKeys.size > 0 ? skipKeys : undefined,
        requestedModel,
        skipModels.size > 0 ? skipModels : undefined,
      );
    } catch (err: any) {
      res.status(err.status ?? 503).json({
        error: {
          message: lastError ? `All speech models rate-limited. Last error: ${lastError.message}` : err.message,
          type: lastError ? 'rate_limit_error' : 'routing_error',
        },
      });
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      const result = await route.provider.createSpeech(route.apiKey, request, route.modelId);

      recordTokens(route.platform, route.modelId, route.keyId, estimatedTokens);
      recordSuccess(route.modelDbId);

      const audio = Buffer.from(result.data);
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Length', String(audio.byteLength));
      res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
      if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
      res.send(audio);

      logRequest(route.platform, route.modelId, 'success', estimatedTokens, 0, Date.now() - start, null);
      return;
    } catch (err: any) {
      const latency = Date.now() - start;
      logRequest(route.platform, route.modelId, 'error', estimatedTokens, 0, latency, err.message);

      const failure = classifyProviderError(err);
      if (canRetryProviderFailure(failure, requestedModel)) {
        prepareProviderRetry(route, failure, err, skipKeys, skipModels);
        lastError = err;
        console.log(`[Proxy] ${err.message.slice(0, 60)} from ${route.displayName}, falling back (${failure.category}, attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      recordTerminalProviderFailure(route, failure, err);

      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${err.message}`,
          type: 'provider_error',
        },
      });
      return;
    }
  }

  res.status(429).json({
    error: {
      message: `All speech models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message}`,
      type: 'rate_limit_error',
    },
  });
});

function logRequest(
  platform: string,
  modelId: string,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  error: string | null,
) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, status, inputTokens, outputTokens, latencyMs, error);
  } catch (e) {
    console.error('Failed to log request:', e);
  }
}

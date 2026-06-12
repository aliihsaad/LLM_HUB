import crypto from 'crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import { routeCapabilityRequest, routeRequest, recordModelFailure, recordRateLimitHit, recordSuccess, } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown } from '../services/ratelimit.js';
import { canRetryProviderFailure, classifyProviderError, } from '../services/provider-errors.js';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { hasProvider } from '../providers/index.js';
export const proxyRouter = Router();
export const geminiProxyRouter = Router();
const GOOGLE_GENERATE_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Constant-time string comparison for the unified API key. Plain `===` leaks
// length and per-character timing, which a network attacker could in principle
// use to recover the key one byte at a time.
function timingSafeStringEqual(provided, expected) {
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
const stickySessionMap = new Map();
const STICKY_TTL_MS = 30 * 60 * 1000; // 30 min session TTL
function getSessionKey(messages) {
    // Use the first user message as session identifier — clients like Hermes
    // re-send the full conversation each turn, so the first user message is
    // stable across turns. Hash the FULL message (not a 100-char slice) so
    // distinct conversations with identical openings don't collide.
    const firstUser = messages.find(m => m.role === 'user');
    if (!firstUser)
        return '';
    const content = serializeChatContent(firstUser.content);
    if (!content)
        return '';
    const hash = crypto.createHash('sha1').update(content).digest('hex');
    return `${hash}:${messages.length > 2 ? 'multi' : 'single'}`;
}
function serializeChatContent(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content))
        return JSON.stringify(content);
    return '';
}
function hasImageContent(content) {
    return Array.isArray(content) && content.some(part => part.type === 'image_url');
}
function requiresVision(messages) {
    return messages.some(m => hasImageContent(m.content));
}
function estimateChatContentTokens(content) {
    if (typeof content === 'string')
        return Math.ceil(content.length / 4);
    if (!Array.isArray(content))
        return 0;
    return content.reduce((sum, part) => {
        if (part.type === 'text')
            return sum + Math.ceil(part.text.length / 4);
        // Conservative fixed cost so image requests avoid models with tiny budgets.
        return sum + 250;
    }, 0);
}
function getStickyModel(messages) {
    // Only apply sticky for multi-turn (has assistant messages = continuation)
    const hasAssistant = messages.some(m => m.role === 'assistant');
    if (!hasAssistant)
        return undefined;
    const key = getSessionKey(messages);
    if (!key)
        return undefined;
    const entry = stickySessionMap.get(key);
    if (!entry)
        return undefined;
    if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
        stickySessionMap.delete(key);
        return undefined;
    }
    return entry.modelDbId;
}
function setStickyModel(messages, modelDbId) {
    const key = getSessionKey(messages);
    if (!key)
        return;
    stickySessionMap.set(key, { modelDbId, lastUsed: Date.now() });
    // Cleanup old entries
    if (stickySessionMap.size > 500) {
        const now = Date.now();
        for (const [k, v] of stickySessionMap) {
            if (now - v.lastUsed > STICKY_TTL_MS)
                stickySessionMap.delete(k);
        }
    }
}
// OpenAI-compatible /models endpoint (used by external clients for metadata).
// Extra fields are intentionally additive so OpenAI-style clients can ignore
// them, while capability-aware clients can avoid sending chat requests to
// realtime/audio/image-only models.
proxyRouter.get('/models', (_req, res) => {
    const db = getDb();
    const models = db.prepare(`
    SELECT
      m.id,
      m.platform,
      m.model_id,
      m.display_name,
      m.context_window,
      m.intelligence_rank,
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
  `).all();
    res.json({
        object: 'list',
        data: models.filter(m => hasProvider(m.platform)).map(m => {
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
function parseGeminiModelAction(raw) {
    const marker = raw.lastIndexOf(':');
    if (marker <= 0)
        return null;
    const action = raw.slice(marker + 1);
    if (action !== 'generateContent' && action !== 'streamGenerateContent')
        return null;
    return {
        model: raw.slice(0, marker),
        action,
    };
}
function estimateGeminiRequestTokens(payload) {
    const contents = Array.isArray(payload.contents) ? payload.contents : [];
    let tokenEstimate = 0;
    for (const entry of contents) {
        const parts = Array.isArray(entry.parts) ? entry.parts : [];
        for (const part of parts) {
            if (part && typeof part === 'object') {
                const text = typeof part.text === 'string' ? part.text : '';
                if (text) {
                    tokenEstimate += Math.ceil(text.length / 4);
                    continue;
                }
                if ('inlineData' in part || 'fileData' in part || 'functionCall' in part || 'functionResponse' in part) {
                    tokenEstimate += 250;
                }
            }
            else if (typeof part === 'string') {
                tokenEstimate += Math.ceil(part.length / 4);
            }
            else {
                tokenEstimate += 50;
            }
        }
    }
    return Math.max(1, tokenEstimate);
}
function getGeminiUsageTokenTotals(payload) {
    const usage = payload?.usageMetadata;
    return {
        prompt: usage?.promptTokenCount ?? 0,
        completion: usage?.candidatesTokenCount ?? 0,
        total: usage?.totalTokenCount ?? 0,
    };
}
function extractGeminiSseText(chunk) {
    const parts = chunk.candidates?.[0]?.content?.parts ?? [];
    if (!Array.isArray(parts) || parts.length === 0)
        return 0;
    let chars = 0;
    for (const part of parts) {
        if (part && typeof part === 'object' && typeof part.text === 'string') {
            chars += part.text.length;
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
const userContentSchema = z.union([
    z.string(),
    z.array(z.union([chatTextContentPartSchema, chatImageContentPartSchema])).min(1),
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
const embeddingInputSchema = z.union([
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
const imageGenerationSchema = z.object({
    prompt: z.string().min(1),
    model: z.string().optional(),
    n: z.number().int().min(1).max(1).optional(),
    size: z.string().optional(),
    quality: z.enum(['auto', 'standard', 'hd', 'low', 'medium', 'high']).optional(),
    response_format: z.enum(['url', 'b64_json']).optional(),
    style: z.enum(['vivid', 'natural']).optional(),
    user: z.string().optional(),
});
const speechSchema = z.object({
    input: z.string().min(1),
    voice: z.string().min(1),
    model: z.string().optional(),
    response_format: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']).optional(),
    speed: z.number().min(0.25).max(4).optional(),
    instructions: z.string().optional(),
    user: z.string().optional(),
});
const realtimeSessionSchema = z.object({
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
const AUDIO_TEXT_FORMATS = new Set([
    'json',
    'text',
    'srt',
    'verbose_json',
    'vtt',
]);
const AUDIO_TIMESTAMP_GRANULARITIES = new Set(['word', 'segment']);
function authenticateProxyRequest(req, res) {
    // Authenticate with unified API key. Local requests (127.0.0.1) skip the check
    // since they came from the same machine running the server. Non-local requests
    // MUST present a valid Bearer token — missing or wrong → 401.
    //
    // Note: req.ip is the actual TCP socket peer because we never set
    // `trust proxy`, so X-Forwarded-For cannot spoof a localhost identity.
    // If a future change enables `trust proxy`, this localhost bypass MUST be
    // re-evaluated.
    const isLocal = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
    if (isLocal)
        return true;
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
function parseAudioTextRequest(req, operation) {
    const contentType = req.headers['content-type'] ?? '';
    const boundary = parseMultipartBoundary(String(contentType));
    if (!boundary || !Buffer.isBuffer(req.body)) {
        return { ok: false, message: 'audio requests must use multipart/form-data' };
    }
    const parts = parseMultipartBody(req.body, boundary);
    const fields = new Map();
    let file;
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
    const getField = (name) => {
        const values = fields.get(name);
        return values?.[values.length - 1];
    };
    const responseFormat = getField('response_format');
    if (responseFormat && !AUDIO_TEXT_FORMATS.has(responseFormat)) {
        return { ok: false, message: `response_format '${responseFormat}' is not supported` };
    }
    const temperatureRaw = getField('temperature');
    let temperature;
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
        return { ok: true, request: base };
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
                ? timestampGranularities
                : undefined,
        },
    };
}
function parseImageRequest(req, operation) {
    const contentType = req.headers['content-type'] ?? '';
    const boundary = parseMultipartBoundary(String(contentType));
    if (!boundary || !Buffer.isBuffer(req.body)) {
        return { ok: false, message: 'image requests must use multipart/form-data' };
    }
    const parts = parseMultipartBody(req.body, boundary);
    const fields = new Map();
    const images = [];
    let mask;
    for (const part of parts) {
        if (part.filename) {
            const upload = {
                filename: part.filename,
                contentType: part.contentType || 'application/octet-stream',
                data: new Uint8Array(part.data),
            };
            if (part.name === 'image')
                images.push(upload);
            if (part.name === 'mask' && !mask)
                mask = upload;
            continue;
        }
        const existing = fields.get(part.name) ?? [];
        existing.push(part.data.toString('utf8'));
        fields.set(part.name, existing);
    }
    const getField = (name) => {
        const values = fields.get(name);
        return values?.[values.length - 1];
    };
    const responseFormat = getField('response_format');
    if (responseFormat && responseFormat !== 'url' && responseFormat !== 'b64_json') {
        return { ok: false, message: `response_format '${responseFormat}' is not supported` };
    }
    const nRaw = getField('n');
    let n;
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
            },
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
        },
    };
}
function parseMultipartBoundary(contentType) {
    const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
    return match?.[1] ?? match?.[2] ?? null;
}
function parseMultipartBody(body, boundary) {
    const boundaryBuffer = Buffer.from(`--${boundary}`);
    const sections = splitBuffer(body, boundaryBuffer);
    const parts = [];
    for (let section of sections) {
        if (section.length === 0)
            continue;
        if (section.subarray(0, 2).toString('ascii') === '--')
            continue;
        if (section.subarray(0, 2).toString('ascii') === '\r\n')
            section = section.subarray(2);
        if (section.subarray(section.length - 2).toString('ascii') === '\r\n') {
            section = section.subarray(0, section.length - 2);
        }
        const headerEnd = section.indexOf(Buffer.from('\r\n\r\n'));
        if (headerEnd < 0)
            continue;
        const headers = section.subarray(0, headerEnd).toString('latin1').split('\r\n');
        const data = section.subarray(headerEnd + 4);
        const disposition = headers.find(h => h.toLowerCase().startsWith('content-disposition:')) ?? '';
        const contentTypeHeader = headers.find(h => h.toLowerCase().startsWith('content-type:'));
        const { name, filename } = parseContentDisposition(disposition);
        if (!name)
            continue;
        parts.push({
            name,
            filename,
            contentType: contentTypeHeader?.split(':').slice(1).join(':').trim() ?? 'text/plain',
            data,
        });
    }
    return parts;
}
function splitBuffer(buffer, separator) {
    const result = [];
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
function parseContentDisposition(header) {
    const params = {};
    for (const segment of header.split(';').slice(1)) {
        const [rawKey, ...rawValueParts] = segment.trim().split('=');
        const rawValue = rawValueParts.join('=');
        const value = rawValue.replace(/^"|"$/g, '');
        if (rawKey === 'name')
            params.name = value;
        if (rawKey === 'filename')
            params.filename = value;
    }
    return params;
}
function estimateEmbeddingTokens(input) {
    if (typeof input === 'string')
        return Math.ceil(input.length / 4);
    let total = 0;
    for (const item of input) {
        if (typeof item === 'string') {
            total += Math.ceil(item.length / 4);
        }
        else if (Array.isArray(item)) {
            total += item.length;
        }
        else {
            total += 1;
        }
    }
    return total;
}
function recordRouteFailure(route, failure, message) {
    if (failure.category === 'rate_limit') {
        recordRateLimitHit(route.modelDbId);
    }
    else {
        recordModelFailure(route.modelDbId, failure.category, message);
    }
}
function prepareProviderRetry(route, failure, err, skipKeys, skipModels) {
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
function recordTerminalProviderFailure(route, failure, err) {
    if (failure.skipModel || failure.category === 'rate_limit') {
        recordRouteFailure(route, failure, err.message);
    }
}
async function handleGeminiGenerateContentRequest(req, res, model, isStream) {
    const start = Date.now();
    if (!authenticateProxyRequest(req, res))
        return;
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
    let requestedModel;
    try {
        requestedModel = decodeURIComponent(model);
    }
    catch {
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
    SELECT id, enabled, platform
    FROM models
    WHERE model_id = ?
  `).get(requestedModel);
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
    const requestBody = parsed.data;
    const estimatedInputTokens = estimateGeminiRequestTokens(requestBody);
    const skipKeys = new Set();
    const skipModels = new Set();
    let lastError = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        let route;
        try {
            route = routeRequest(estimatedInputTokens, skipKeys.size > 0 ? skipKeys : undefined, catalogRow.id, skipModels.size > 0 ? skipModels : undefined, undefined, 'google');
        }
        catch (err) {
            if (lastError) {
                res.status(429).json({
                    error: {
                        message: `All Gemini models rate-limited. Last error: ${lastError.message}`,
                        type: 'rate_limit_error',
                    },
                });
            }
            else {
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
                const errPayload = await upstream.json().catch(() => ({}));
                throw new Error(`Gemini API error ${upstream.status}: ${errPayload.error?.message ?? upstream.statusText}`);
            }
            if (isStream) {
                const upstreamBody = upstream.body;
                if (!upstreamBody)
                    throw new Error('No response body');
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
                if (attempt > 0)
                    res.setHeader('X-Fallback-Attempts', String(attempt));
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
                            if (!trimmed.startsWith('data:'))
                                continue;
                            const raw = trimmed.slice(5).trimStart();
                            if (raw === '[DONE]') {
                                completed = true;
                                sawDoneFrame = true;
                                continue;
                            }
                            if (!raw.startsWith('{'))
                                continue;
                            try {
                                const parsedChunk = JSON.parse(raw);
                                streamOutputTokens += extractGeminiSseText(parsedChunk);
                            }
                            catch {
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
                                        const parsedChunk = JSON.parse(raw);
                                        streamOutputTokens += extractGeminiSseText(parsedChunk);
                                    }
                                    catch {
                                        // Ignore malformed JSON chunks.
                                    }
                                }
                            }
                        }
                        res.write(outputChunkText);
                    }
                }
                catch (streamErr) {
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
            if (attempt > 0)
                res.setHeader('X-Fallback-Attempts', String(attempt));
            res.json(payload);
            logRequest(route.platform, route.modelId, 'success', usage.prompt, usage.completion, Date.now() - start, null);
            return;
        }
        catch (err) {
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
geminiProxyRouter.post('/v1beta/models/:modelAction', async (req, res) => {
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
proxyRouter.post('/chat/completions', async (req, res) => {
    const start = Date.now();
    if (!authenticateProxyRequest(req, res))
        return;
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
    const messages = parsed.data.messages.map((m) => {
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
    const estimatedInputTokens = messages.reduce((sum, m) => sum + estimateChatContentTokens(m.content), 0);
    const estimatedTotal = estimatedInputTokens + (max_tokens ?? 1000);
    const needsVision = requiresVision(messages);
    // Explicit `model` field pins routing. If the catalog has no enabled row
    // matching the requested id, return 400 — silently auto-routing to a
    // different model would be surprising to OpenAI-compatible clients.
    // Sticky-session is the fallback when no `model` field was sent at all.
    let preferredModel;
    if (requestedModel) {
        const db = getDb();
        if (needsVision) {
            const row = db.prepare(`
        SELECT m.id, m.enabled AS model_enabled, mc.enabled AS capability_enabled
        FROM models m
        LEFT JOIN model_capabilities mc
          ON mc.model_db_id = m.id AND mc.capability = 'vision'
        WHERE m.model_id = ?
      `).get(requestedModel);
            if (!row || !row.capability_enabled) {
                const reason = row ? 'does not support vision' : 'is not in the catalog';
                res.status(400).json({
                    error: {
                        message: `Model '${requestedModel}' ${reason}. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
                        type: 'invalid_request_error',
                        code: 'model_not_found',
                    },
                });
                return;
            }
            if (row.model_enabled !== 1) {
                res.status(400).json({
                    error: {
                        message: `Model '${requestedModel}' is disabled. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
                        type: 'invalid_request_error',
                        code: 'model_not_found',
                    },
                });
                return;
            }
            preferredModel = row.id;
        }
        else {
            const enabled = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(requestedModel);
            if (enabled) {
                preferredModel = enabled.id;
            }
            else {
                const disabled = db.prepare('SELECT id FROM models WHERE model_id = ?').get(requestedModel);
                const reason = disabled ? 'is disabled' : 'is not in the catalog';
                res.status(400).json({
                    error: {
                        message: `Model '${requestedModel}' ${reason}. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
                        type: 'invalid_request_error',
                        code: 'model_not_found',
                    },
                });
                return;
            }
        }
    }
    else if (!needsVision) {
        preferredModel = getStickyModel(messages);
    }
    // Retry loop: on 429/rate limit, skip that model+key and try the next one
    const skipKeys = new Set();
    const skipModels = new Set();
    let lastError = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        let route;
        try {
            route = needsVision
                ? routeCapabilityRequest('vision', estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, requestedModel, skipModels.size > 0 ? skipModels : undefined)
                : routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel, skipModels.size > 0 ? skipModels : undefined);
        }
        catch (err) {
            // No more models available
            if (lastError) {
                res.status(429).json({
                    error: {
                        message: `All models rate-limited. Last error: ${lastError.message}`,
                        type: 'rate_limit_error',
                    },
                });
            }
            else {
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
                    const gen = route.provider.streamChatCompletion(route.apiKey, messages, route.modelId, { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls });
                    for await (const chunk of gen) {
                        if (!streamStarted) {
                            res.setHeader('Content-Type', 'text/event-stream');
                            res.setHeader('Cache-Control', 'no-cache');
                            res.setHeader('Connection', 'keep-alive');
                            res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
                            if (attempt > 0)
                                res.setHeader('X-Fallback-Attempts', String(attempt));
                            streamStarted = true;
                        }
                        const text = chunk.choices[0]?.delta?.content ?? '';
                        totalOutputTokens += Math.ceil(text.length / 4);
                        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    }
                    if (!streamStarted) {
                        // Upstream returned no chunks — emit minimal successful stream.
                        res.setHeader('Content-Type', 'text/event-stream');
                        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
                    }
                    res.write('data: [DONE]\n\n');
                    res.end();
                    recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
                    recordSuccess(route.modelDbId);
                    setStickyModel(messages, route.modelDbId);
                    logRequest(route.platform, route.modelId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null);
                    return;
                }
                catch (streamErr) {
                    if (streamStarted) {
                        // Mid-stream error — finish the SSE response cleanly instead of leaving
                        // the client hanging or letting Express's default handler take over.
                        // Full upstream message goes to the log; the client sees a generic
                        // message so we don't leak provider internals into a partial stream.
                        console.error(`[Proxy] Mid-stream error from ${route.displayName}:`, streamErr.message);
                        const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } };
                        try {
                            res.write(`data: ${JSON.stringify(payload)}\n\n`);
                        }
                        catch { /* socket gone */ }
                        try {
                            res.write('data: [DONE]\n\n');
                            res.end();
                        }
                        catch { /* socket gone */ }
                        logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, streamErr.message);
                        return;
                    }
                    // Pre-stream error — bubble to outer retry/502 handler.
                    throw streamErr;
                }
            }
            else {
                const result = await route.provider.chatCompletion(route.apiKey, messages, route.modelId, { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls });
                const totalTokens = result.usage?.total_tokens ?? 0;
                recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
                recordSuccess(route.modelDbId);
                setStickyModel(messages, route.modelDbId);
                res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
                if (attempt > 0)
                    res.setHeader('X-Fallback-Attempts', String(attempt));
                res.json(result);
                logRequest(route.platform, route.modelId, 'success', result.usage?.prompt_tokens ?? 0, result.usage?.completion_tokens ?? 0, Date.now() - start, null);
                return;
            }
        }
        catch (err) {
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
proxyRouter.post('/embeddings', async (req, res) => {
    const start = Date.now();
    if (!authenticateProxyRequest(req, res))
        return;
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
        const row = db.prepare(`
      SELECT m.id, mc.enabled AS capability_enabled, m.enabled AS model_enabled
      FROM models m
      LEFT JOIN model_capabilities mc
        ON mc.model_db_id = m.id AND mc.capability = 'embeddings'
      WHERE m.model_id = ?
    `).get(requestedModel);
        if (!row || !row.capability_enabled) {
            const reason = row ? 'does not support embeddings' : 'is not in the catalog';
            res.status(400).json({
                error: {
                    message: `Model '${requestedModel}' ${reason}. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
                    type: 'invalid_request_error',
                    code: 'model_not_found',
                },
            });
            return;
        }
        if (row.model_enabled !== 1) {
            res.status(400).json({
                error: {
                    message: `Model '${requestedModel}' is disabled. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
                    type: 'invalid_request_error',
                    code: 'model_not_found',
                },
            });
            return;
        }
    }
    const estimatedTokens = estimateEmbeddingTokens(input);
    const skipKeys = new Set();
    const skipModels = new Set();
    let lastError = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        let route;
        try {
            route = routeCapabilityRequest('embeddings', estimatedTokens, skipKeys.size > 0 ? skipKeys : undefined, requestedModel, skipModels.size > 0 ? skipModels : undefined);
        }
        catch (err) {
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
            const result = await route.provider.createEmbedding(route.apiKey, input, route.modelId, { encoding_format, dimensions, user });
            const totalTokens = result.usage?.total_tokens ?? estimatedTokens;
            recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
            recordSuccess(route.modelDbId);
            res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
            if (attempt > 0)
                res.setHeader('X-Fallback-Attempts', String(attempt));
            res.json(result);
            logRequest(route.platform, route.modelId, 'success', result.usage?.prompt_tokens ?? estimatedTokens, 0, Date.now() - start, null);
            return;
        }
        catch (err) {
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
proxyRouter.post('/images/generations', async (req, res) => {
    const start = Date.now();
    if (!authenticateProxyRequest(req, res))
        return;
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
    };
    const requestedModel = request.model;
    if (requestedModel) {
        const db = getDb();
        const row = db.prepare(`
      SELECT m.id, mc.enabled AS capability_enabled, m.enabled AS model_enabled
      FROM models m
      LEFT JOIN model_capabilities mc
        ON mc.model_db_id = m.id AND mc.capability = 'image_generation'
      WHERE m.model_id = ?
    `).get(requestedModel);
        if (!row || !row.capability_enabled) {
            const reason = row ? 'does not support image generation' : 'is not in the catalog';
            res.status(400).json({
                error: {
                    message: `Model '${requestedModel}' ${reason}. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
                    type: 'invalid_request_error',
                    code: 'model_not_found',
                },
            });
            return;
        }
        if (row.model_enabled !== 1) {
            res.status(400).json({
                error: {
                    message: `Model '${requestedModel}' is disabled. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
                    type: 'invalid_request_error',
                    code: 'model_not_found',
                },
            });
            return;
        }
    }
    const estimatedTokens = Math.ceil(request.prompt.length / 4) + 1000;
    const skipKeys = new Set();
    const skipModels = new Set();
    let lastError = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        let route;
        try {
            route = routeCapabilityRequest('image_generation', estimatedTokens, skipKeys.size > 0 ? skipKeys : undefined, requestedModel, skipModels.size > 0 ? skipModels : undefined);
        }
        catch (err) {
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
            if (attempt > 0)
                res.setHeader('X-Fallback-Attempts', String(attempt));
            res.json(result);
            logRequest(route.platform, route.modelId, 'success', estimatedTokens, 0, Date.now() - start, null);
            return;
        }
        catch (err) {
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
proxyRouter.post('/images/edits', multipartParser, async (req, res) => {
    await handleImageRequest(req, res, 'edit');
});
proxyRouter.post('/images/variations', multipartParser, async (req, res) => {
    await handleImageRequest(req, res, 'variation');
});
async function handleImageRequest(req, res, operation) {
    const start = Date.now();
    if (!authenticateProxyRequest(req, res))
        return;
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
        const row = db.prepare(`
      SELECT m.id, mc.enabled AS capability_enabled, m.enabled AS model_enabled
      FROM models m
      LEFT JOIN model_capabilities mc
        ON mc.model_db_id = m.id AND mc.capability = ?
      WHERE m.model_id = ?
    `).get(capability, requestedModel);
        if (!row || !row.capability_enabled) {
            const reason = row ? `does not support ${actionLabel}` : 'is not in the catalog';
            res.status(400).json({
                error: {
                    message: `Model '${requestedModel}' ${reason}. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
                    type: 'invalid_request_error',
                    code: 'model_not_found',
                },
            });
            return;
        }
        if (row.model_enabled !== 1) {
            res.status(400).json({
                error: {
                    message: `Model '${requestedModel}' is disabled. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
                    type: 'invalid_request_error',
                    code: 'model_not_found',
                },
            });
            return;
        }
    }
    const estimatedTokens = estimateImageRequestTokens(request);
    const skipKeys = new Set();
    const skipModels = new Set();
    let lastError = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        let route;
        try {
            route = routeCapabilityRequest(capability, estimatedTokens, skipKeys.size > 0 ? skipKeys : undefined, requestedModel, skipModels.size > 0 ? skipModels : undefined);
        }
        catch (err) {
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
                ? await route.provider.editImage(route.apiKey, request, route.modelId)
                : await route.provider.createImageVariation(route.apiKey, request, route.modelId);
            recordTokens(route.platform, route.modelId, route.keyId, estimatedTokens);
            recordSuccess(route.modelDbId);
            res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
            if (attempt > 0)
                res.setHeader('X-Fallback-Attempts', String(attempt));
            res.json(result);
            logRequest(route.platform, route.modelId, 'success', estimatedTokens, 0, Date.now() - start, null);
            return;
        }
        catch (err) {
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
function estimateImageRequestTokens(request) {
    const promptTokens = 'prompt' in request ? Math.ceil(request.prompt.length / 4) : 0;
    return promptTokens + 1000;
}
proxyRouter.post('/audio/transcriptions', multipartParser, async (req, res) => {
    await handleAudioTextRequest(req, res, 'transcription');
});
proxyRouter.post('/audio/translations', multipartParser, async (req, res) => {
    await handleAudioTextRequest(req, res, 'translation');
});
async function handleAudioTextRequest(req, res, operation) {
    const start = Date.now();
    if (!authenticateProxyRequest(req, res))
        return;
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
        const row = db.prepare(`
      SELECT m.id, mc.enabled AS capability_enabled, m.enabled AS model_enabled
      FROM models m
      LEFT JOIN model_capabilities mc
        ON mc.model_db_id = m.id AND mc.capability = ?
      WHERE m.model_id = ?
    `).get(capability, requestedModel);
        if (!row || !row.capability_enabled) {
            const reason = row ? `does not support ${actionLabel}` : 'is not in the catalog';
            res.status(400).json({
                error: {
                    message: `Model '${requestedModel}' ${reason}. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
                    type: 'invalid_request_error',
                    code: 'model_not_found',
                },
            });
            return;
        }
        if (row.model_enabled !== 1) {
            res.status(400).json({
                error: {
                    message: `Model '${requestedModel}' is disabled. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
                    type: 'invalid_request_error',
                    code: 'model_not_found',
                },
            });
            return;
        }
    }
    const estimatedTokens = estimateAudioTextTokens(request);
    const skipKeys = new Set();
    const skipModels = new Set();
    let lastError = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        let route;
        try {
            route = routeCapabilityRequest(capability, estimatedTokens, skipKeys.size > 0 ? skipKeys : undefined, requestedModel, skipModels.size > 0 ? skipModels : undefined);
        }
        catch (err) {
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
                ? await route.provider.transcribeAudio(route.apiKey, request, route.modelId)
                : await route.provider.translateAudio(route.apiKey, request, route.modelId);
            recordTokens(route.platform, route.modelId, route.keyId, estimatedTokens);
            recordSuccess(route.modelDbId);
            res.setHeader('Content-Type', result.contentType);
            res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
            if (attempt > 0)
                res.setHeader('X-Fallback-Attempts', String(attempt));
            if (result.contentType.includes('application/json')) {
                res.send(JSON.stringify(result.body));
            }
            else {
                res.send(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
            }
            logRequest(route.platform, route.modelId, 'success', estimatedTokens, 0, Date.now() - start, null);
            return;
        }
        catch (err) {
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
function estimateAudioTextTokens(request) {
    const promptTokens = Math.ceil((request.prompt?.length ?? 0) / 4);
    const urlTokens = Math.ceil((request.url?.length ?? 0) / 4);
    return Math.max(100, promptTokens + urlTokens + 100);
}
proxyRouter.post('/realtime/sessions', async (req, res) => {
    const start = Date.now();
    if (!authenticateProxyRequest(req, res))
        return;
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
    };
    const requestedModel = request.model;
    if (requestedModel) {
        const db = getDb();
        const row = db.prepare(`
      SELECT m.id, mc.enabled AS capability_enabled, m.enabled AS model_enabled
      FROM models m
      LEFT JOIN model_capabilities mc
        ON mc.model_db_id = m.id AND mc.capability = 'realtime_audio'
      WHERE m.model_id = ?
    `).get(requestedModel);
        if (!row || !row.capability_enabled) {
            const reason = row ? 'does not support realtime audio' : 'is not in the catalog';
            res.status(400).json({
                error: {
                    message: `Model '${requestedModel}' ${reason}. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
                    type: 'invalid_request_error',
                    code: 'model_not_found',
                },
            });
            return;
        }
        if (row.model_enabled !== 1) {
            res.status(400).json({
                error: {
                    message: `Model '${requestedModel}' is disabled. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
                    type: 'invalid_request_error',
                    code: 'model_not_found',
                },
            });
            return;
        }
    }
    const estimatedTokens = 1;
    const skipKeys = new Set();
    const skipModels = new Set();
    let lastError = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        let route;
        try {
            route = routeCapabilityRequest('realtime_audio', estimatedTokens, skipKeys.size > 0 ? skipKeys : undefined, requestedModel, skipModels.size > 0 ? skipModels : undefined);
        }
        catch (err) {
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
            if (attempt > 0)
                res.setHeader('X-Fallback-Attempts', String(attempt));
            res.json(result);
            logRequest(route.platform, route.modelId, 'success', estimatedTokens, 0, Date.now() - start, null);
            return;
        }
        catch (err) {
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
proxyRouter.post('/audio/speech', async (req, res) => {
    const start = Date.now();
    if (!authenticateProxyRequest(req, res))
        return;
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
    };
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
        const row = db.prepare(`
      SELECT m.id, mc.enabled AS capability_enabled, m.enabled AS model_enabled
      FROM models m
      LEFT JOIN model_capabilities mc
        ON mc.model_db_id = m.id AND mc.capability = 'speech'
      WHERE m.model_id = ?
    `).get(requestedModel);
        if (!row || !row.capability_enabled) {
            const reason = row ? 'does not support speech' : 'is not in the catalog';
            res.status(400).json({
                error: {
                    message: `Model '${requestedModel}' ${reason}. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
                    type: 'invalid_request_error',
                    code: 'model_not_found',
                },
            });
            return;
        }
        if (row.model_enabled !== 1) {
            res.status(400).json({
                error: {
                    message: `Model '${requestedModel}' is disabled. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
                    type: 'invalid_request_error',
                    code: 'model_not_found',
                },
            });
            return;
        }
    }
    const estimatedTokens = Math.ceil(request.input.length / 4);
    const skipKeys = new Set();
    const skipModels = new Set();
    let lastError = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        let route;
        try {
            route = routeCapabilityRequest('speech', estimatedTokens, skipKeys.size > 0 ? skipKeys : undefined, requestedModel, skipModels.size > 0 ? skipModels : undefined);
        }
        catch (err) {
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
            if (attempt > 0)
                res.setHeader('X-Fallback-Attempts', String(attempt));
            res.send(audio);
            logRequest(route.platform, route.modelId, 'success', estimatedTokens, 0, Date.now() - start, null);
            return;
        }
        catch (err) {
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
function logRequest(platform, modelId, status, inputTokens, outputTokens, latencyMs, error) {
    try {
        const db = getDb();
        db.prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, status, inputTokens, outputTokens, latencyMs, error);
    }
    catch (e) {
        console.error('Failed to log request:', e);
    }
}
//# sourceMappingURL=proxy.js.map
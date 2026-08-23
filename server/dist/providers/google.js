import { isIP } from 'node:net';
import { BaseProvider, readProviderErrorText } from './base.js';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const API_BASE_V1ALPHA = 'https://generativelanguage.googleapis.com/v1alpha';
const GEMINI_LIVE_CONSTRAINED_WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';
const MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REMOTE_VIDEO_BYTES = 20 * 1024 * 1024;
function safeParseObject(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
        return { value: parsed };
    }
    catch {
        return { value: raw };
    }
}
function normalizeGeminiArgs(args) {
    if (typeof args === 'string')
        return args;
    return JSON.stringify(args ?? {});
}
function toGeminiFinishReason(finishReason) {
    const r = (finishReason ?? '').toUpperCase();
    if (!r)
        return 'stop';
    if (r === 'MAX_TOKENS')
        return 'length';
    if (r === 'SAFETY' || r === 'RECITATION' || r === 'BLOCKLIST' || r === 'PROHIBITED_CONTENT' || r === 'SPII') {
        return 'content_filter';
    }
    return 'stop';
}
function toGeminiTools(tools) {
    if (!tools || tools.length === 0)
        return undefined;
    return [{
            functionDeclarations: tools.map(t => ({
                name: t.function.name,
                description: t.function.description,
                parameters: t.function.parameters,
            })),
        }];
}
function toGeminiToolConfig(toolChoice) {
    if (!toolChoice)
        return undefined;
    if (typeof toolChoice === 'string') {
        const mode = toolChoice === 'none'
            ? 'NONE'
            : toolChoice === 'required'
                ? 'ANY'
                : 'AUTO';
        return { functionCallingConfig: { mode } };
    }
    return {
        functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: [toolChoice.function.name],
        },
    };
}
function parseImageDataUrl(url) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=]+)$/.exec(url);
    if (!match) {
        throw new Error('Invalid image URL. Use data:image/...;base64,... or a safe http(s) image URL.');
    }
    return { mimeType: match[1], data: match[2] };
}
function parseVideoDataUrl(url) {
    const match = /^data:(video\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=]+)$/i.exec(url);
    if (!match) {
        throw new Error('Invalid video URL. Use data:video/...;base64,... or a safe http(s) video URL.');
    }
    return { mimeType: match[1], data: match[2] };
}
async function imageUrlToInlineData(rawUrl) {
    if (rawUrl.startsWith('data:'))
        return parseImageDataUrl(rawUrl);
    const url = validateRemoteImageUrl(rawUrl);
    const res = await fetch(url, { method: 'GET', redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
        throw new Error('Remote image URL redirects are not allowed');
    }
    if (!res.ok) {
        throw new Error(`Remote image URL fetch failed with status ${res.status}`);
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) {
        throw new Error(`Remote image URL content type must be image/*, got '${contentType || 'unknown'}'`);
    }
    const contentLength = Number(res.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_IMAGE_BYTES) {
        throw new Error('Remote image URL image is too large');
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (data.byteLength > MAX_REMOTE_IMAGE_BYTES) {
        throw new Error('Remote image URL image is too large');
    }
    return { mimeType: contentType, data: data.toString('base64') };
}
async function videoUrlToGeminiPart(rawUrl) {
    if (rawUrl.startsWith('data:')) {
        return { inlineData: parseVideoDataUrl(rawUrl) };
    }
    const youtubeUrl = toCanonicalYouTubeWatchUrl(rawUrl);
    if (youtubeUrl) {
        return { fileData: { fileUri: youtubeUrl } };
    }
    return { inlineData: await videoUrlToInlineData(rawUrl) };
}
function toCanonicalYouTubeWatchUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const normalizedHost = host.replace(/^(www|m)\./, '');
    const segments = url.pathname.split('/').filter(Boolean);
    let videoId = null;
    if (normalizedHost === 'youtu.be') {
        videoId = segments[0] ?? null;
    }
    else if (normalizedHost === 'youtube.com') {
        if (url.pathname === '/watch') {
            videoId = url.searchParams.get('v');
        }
        else if ((segments[0] === 'shorts' || segments[0] === 'embed') && segments[1]) {
            videoId = segments[1];
        }
    }
    else if (normalizedHost === 'youtube-nocookie.com' && segments[0] === 'embed' && segments[1]) {
        videoId = segments[1];
    }
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId))
        return null;
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}
async function videoUrlToInlineData(rawUrl) {
    const url = validateRemoteVideoUrl(rawUrl);
    const res = await fetch(url, { method: 'GET', redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
        throw new Error('Remote video URL redirects are not allowed');
    }
    if (!res.ok) {
        throw new Error(`Remote video URL fetch failed with status ${res.status}`);
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('video/')) {
        throw new Error(`Remote video URL content type must be video/*, got '${contentType || 'unknown'}'`);
    }
    const contentLength = Number(res.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_VIDEO_BYTES) {
        throw new Error('Remote video URL video is too large');
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (data.byteLength > MAX_REMOTE_VIDEO_BYTES) {
        throw new Error('Remote video URL video is too large');
    }
    return { mimeType: contentType, data: data.toString('base64') };
}
function validateRemoteImageUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        throw new Error('Invalid remote image URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Remote image URL protocol must be http or https');
    }
    if (isBlockedRemoteHost(url.hostname)) {
        throw new Error('Remote image URL host is blocked');
    }
    return url.toString();
}
function validateRemoteVideoUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        throw new Error('Invalid remote video URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Remote video URL protocol must be http or https');
    }
    if (isBlockedRemoteHost(url.hostname)) {
        throw new Error('Remote video URL host is blocked');
    }
    return url.toString();
}
function isBlockedRemoteHost(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!host)
        return true;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
        return true;
    if (host === 'metadata.google.internal')
        return true;
    const ipVersion = isIP(host);
    if (ipVersion === 4)
        return isBlockedIpv4(host);
    if (ipVersion === 6)
        return isBlockedIpv6(host);
    return false;
}
function isBlockedIpv4(ip) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    return a === 0
        || a === 10
        || a === 127
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || a >= 224;
}
function isBlockedIpv6(ip) {
    const normalized = ip.toLowerCase();
    return normalized === '::'
        || normalized === '::1'
        || normalized.startsWith('fc')
        || normalized.startsWith('fd')
        || normalized.startsWith('fe80:');
}
async function toGeminiUserParts(content) {
    if (typeof content === 'string')
        return [{ text: content }];
    if (!Array.isArray(content))
        return [{ text: '' }];
    const parts = [];
    for (const part of content) {
        if (part.type === 'text') {
            if (part.text.length > 0)
                parts.push({ text: part.text });
            continue;
        }
        if (part.type === 'image_url') {
            parts.push({ inlineData: await imageUrlToInlineData(part.image_url.url) });
            continue;
        }
        parts.push(await videoUrlToGeminiPart(part.video_url.url));
    }
    return parts.length > 0 ? parts : [{ text: '' }];
}
function toGoogleImageConfig(size) {
    switch (size) {
        case '1024x1024':
            return { aspectRatio: '1:1' };
        case '1536x1024':
            return { aspectRatio: '3:2' };
        case '1024x1536':
            return { aspectRatio: '2:3' };
        case 'auto':
        case undefined:
            return undefined;
        default:
            return undefined;
    }
}
const OPENAI_TO_GEMINI_VOICE = {
    alloy: 'Kore',
    ash: 'Charon',
    ballad: 'Orus',
    coral: 'Aoede',
    echo: 'Puck',
    fable: 'Leda',
    nova: 'Zephyr',
    onyx: 'Fenrir',
    sage: 'Iapetus',
    shimmer: 'Callirrhoe',
    verse: 'Achird',
};
function toGeminiVoiceName(voice) {
    return OPENAI_TO_GEMINI_VOICE[voice.toLowerCase()] ?? voice;
}
function toGeminiSpeechPrompt(request) {
    const transcript = request.input.trim();
    const instructions = request.instructions?.trim();
    const instructionPrefix = instructions
        ? `Apply these voice instructions: ${instructions}\n\n`
        : '';
    return `${instructionPrefix}Say only the following transcript, exactly as written. Do not answer it, explain it, translate it, summarize it, or add any words:\n\n${transcript}`;
}
function toRealtimeResponseModalities(modalities) {
    return modalities && modalities.length > 0 ? modalities : ['AUDIO'];
}
function parsePcmRate(mimeType) {
    const match = /rate=(\d+)/i.exec(mimeType ?? '');
    return match ? Number(match[1]) : 24000;
}
function pcmToWav(pcm, sampleRate) {
    const channels = 1;
    const bitsPerSample = 16;
    const blockAlign = channels * bitsPerSample / 8;
    const byteRate = sampleRate * blockAlign;
    const buffer = Buffer.alloc(44 + pcm.byteLength);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + pcm.byteLength, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(pcm.byteLength, 40);
    Buffer.from(pcm).copy(buffer, 44);
    return buffer;
}
function imageFileToGeminiPart(image) {
    return {
        inlineData: {
            mimeType: image.contentType || 'application/octet-stream',
            data: Buffer.from(image.data).toString('base64'),
        },
    };
}
// Translate OpenAI messages to Gemini format
async function toGeminiContents(messages) {
    const systemMessages = messages
        .filter(m => m.role === 'system' && typeof m.content === 'string' && m.content.length > 0)
        .map(m => m.content);
    const toolNameByCallId = new Map();
    for (const m of messages) {
        for (const tc of m.tool_calls ?? []) {
            toolNameByCallId.set(tc.id, tc.function.name);
        }
    }
    const contentsWithNulls = await Promise.all(messages
        .filter(m => m.role !== 'system')
        .map(async (m) => {
        if (m.role === 'assistant') {
            const parts = [];
            if (typeof m.content === 'string' && m.content.length > 0) {
                parts.push({ text: m.content });
            }
            for (const call of m.tool_calls ?? []) {
                parts.push({
                    thoughtSignature: call.thought_signature,
                    functionCall: {
                        id: call.id,
                        name: call.function.name,
                        args: safeParseObject(call.function.arguments),
                    },
                });
            }
            if (parts.length === 0)
                return null;
            return {
                role: 'model',
                parts,
            };
        }
        if (m.role === 'tool') {
            const toolCallId = m.tool_call_id;
            if (!toolCallId)
                return null;
            const toolName = m.name ?? toolNameByCallId.get(toolCallId) ?? 'tool';
            const response = safeParseObject(typeof m.content === 'string' ? m.content : '');
            return {
                role: 'user',
                parts: [{
                        functionResponse: {
                            id: toolCallId,
                            name: toolName,
                            response,
                        },
                    }],
            };
        }
        return {
            role: 'user',
            parts: await toGeminiUserParts(m.content),
        };
    }));
    const contents = contentsWithNulls
        .filter((entry) => entry !== null);
    return {
        contents,
        systemInstruction: systemMessages.length > 0
            ? { parts: [{ text: systemMessages.join('\n\n') }] }
            : undefined,
    };
}
function extractToolCalls(parts) {
    const calls = [];
    if (!parts)
        return calls;
    let fallbackIndex = 0;
    for (const part of parts) {
        if (!part.functionCall?.name)
            continue;
        const id = part.functionCall.id ?? `call_${Date.now()}_${fallbackIndex++}`;
        calls.push({
            id,
            type: 'function',
            function: {
                name: part.functionCall.name,
                arguments: normalizeGeminiArgs(part.functionCall.args),
            },
            thought_signature: part.thoughtSignature,
        });
    }
    return calls;
}
function extractText(parts) {
    if (!parts)
        return null;
    const text = parts
        .map(p => p.text ?? '')
        .join('');
    return text.length > 0 ? text : null;
}
export class GoogleProvider extends BaseProvider {
    platform = 'google';
    name = 'Google AI Studio';
    // Gemini reasoning/thinking models regularly pass 15s, and 503 "high
    // demand" retries stack on top. 67 aborts logged in production.
    defaultTimeoutMs = 60000;
    async chatCompletion(apiKey, messages, modelId, options) {
        const { contents, systemInstruction } = await toGeminiContents(messages);
        const body = {
            contents,
            generationConfig: {
                temperature: options?.temperature,
                maxOutputTokens: options?.max_tokens,
                topP: options?.top_p,
            },
            tools: toGeminiTools(options?.tools),
            toolConfig: toGeminiToolConfig(options?.tool_choice),
        };
        if (systemInstruction)
            body.systemInstruction = systemInstruction;
        const url = `${API_BASE}/models/${modelId}:generateContent?key=${apiKey}`;
        const res = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`Google API error ${res.status}: ${readProviderErrorText(err, res.statusText)}`);
        }
        const data = await res.json();
        const candidate = data.candidates?.[0];
        const parts = candidate?.content?.parts;
        const toolCalls = extractToolCalls(parts);
        const text = extractText(parts);
        const usage = {
            prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
            completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
            total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
        };
        return {
            id: this.makeId(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: text,
                        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
                    },
                    finish_reason: toolCalls.length > 0 ? 'tool_calls' : toGeminiFinishReason(candidate?.finishReason),
                }],
            usage,
            _routed_via: { platform: 'google', model: modelId },
        };
    }
    async createImage(apiKey, request, modelId) {
        return this.generateImageFromParts(apiKey, [{ text: request.prompt }], request, modelId, 'Google image generation returned no image data');
    }
    async editImage(apiKey, request, modelId) {
        return this.generateImageFromParts(apiKey, [
            { text: request.prompt },
            ...request.images.map(imageFileToGeminiPart),
            ...(request.mask ? [{ text: 'Use the provided mask as the editable region.' }, imageFileToGeminiPart(request.mask)] : []),
        ], request, modelId, 'Google image edit returned no image data');
    }
    async createImageVariation(apiKey, request, modelId) {
        return this.generateImageFromParts(apiKey, [
            { text: 'Create a variation of this image while preserving its main subject and composition.' },
            imageFileToGeminiPart(request.image),
        ], request, modelId, 'Google image variation returned no image data');
    }
    async generateImageFromParts(apiKey, promptParts, request, modelId, emptyMessage) {
        const imageConfig = toGoogleImageConfig(request.size);
        const body = {
            contents: [{ parts: promptParts }],
            generationConfig: {
                responseModalities: ['TEXT', 'IMAGE'],
                ...(imageConfig ? { imageConfig } : {}),
            },
        };
        const url = `${API_BASE}/models/${modelId}:generateContent?key=${apiKey}`;
        const res = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }, 120000);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`Google API error ${res.status}: ${readProviderErrorText(err, res.statusText)}`);
        }
        const data = await res.json();
        const parts = data.candidates?.[0]?.content?.parts ?? [];
        const revisedPrompt = parts
            .filter(part => !part.thought)
            .map(part => part.text ?? '')
            .join('')
            .trim();
        const images = parts
            .filter(part => !part.thought && part.inlineData?.data)
            .map(part => {
            const data = part.inlineData.data;
            return {
                ...(request.response_format === 'url'
                    ? { url: `data:${part.inlineData.mimeType};base64,${data}` }
                    : { b64_json: data }),
                ...(revisedPrompt ? { revised_prompt: revisedPrompt } : {}),
            };
        });
        if (images.length === 0) {
            throw new Error(emptyMessage);
        }
        return {
            created: Math.floor(Date.now() / 1000),
            data: images,
            _routed_via: { platform: 'google', model: modelId },
        };
    }
    async transcribeAudio(apiKey, request, modelId) {
        if (!request.file) {
            throw new Error('Google transcription requires an uploaded audio file');
        }
        const instructions = [
            'Transcribe the supplied audio exactly.',
            'Return only the transcript without commentary, labels, quotation marks, or Markdown.',
            request.language ? `The expected language code is ${request.language}.` : '',
            request.prompt ? `Context that may help disambiguate names: ${request.prompt}` : '',
        ].filter(Boolean).join(' ');
        const body = {
            contents: [{
                    parts: [
                        { text: instructions },
                        {
                            inlineData: {
                                mimeType: request.file.contentType || 'audio/wav',
                                data: Buffer.from(request.file.data).toString('base64'),
                            },
                        },
                    ],
                }],
            generationConfig: { temperature: 0 },
        };
        const url = `${API_BASE}/models/${modelId}:generateContent?key=${apiKey}`;
        const res = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }, 120000);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`Google API error ${res.status}: ${readProviderErrorText(err, res.statusText)}`);
        }
        const data = await res.json();
        const transcript = extractText(data.candidates?.[0]?.content?.parts)?.trim();
        if (!transcript) {
            throw new Error('Google transcription returned no text');
        }
        const wantsText = request.response_format === 'text';
        return {
            body: wantsText ? transcript : { text: transcript },
            contentType: wantsText ? 'text/plain; charset=utf-8' : 'application/json',
            _routed_via: { platform: 'google', model: modelId },
        };
    }
    async createSpeech(apiKey, request, modelId) {
        const body = {
            contents: [{ parts: [{ text: toGeminiSpeechPrompt(request) }] }],
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: toGeminiVoiceName(request.voice),
                        },
                    },
                },
            },
        };
        const url = `${API_BASE}/models/${modelId}:generateContent?key=${apiKey}`;
        const res = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }, 120000);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`Google API error ${res.status}: ${readProviderErrorText(err, res.statusText)}`);
        }
        const data = await res.json();
        const audioPart = data.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data);
        if (!audioPart?.inlineData?.data) {
            throw new Error('Google speech generation returned no audio data');
        }
        const pcm = Buffer.from(audioPart.inlineData.data, 'base64');
        if (request.response_format === 'pcm') {
            return {
                data: pcm,
                contentType: 'audio/pcm',
                format: 'pcm',
                _routed_via: { platform: 'google', model: modelId },
            };
        }
        const wav = pcmToWav(pcm, parsePcmRate(audioPart.inlineData.mimeType));
        return {
            data: wav,
            contentType: 'audio/wav',
            format: 'wav',
            _routed_via: { platform: 'google', model: modelId },
        };
    }
    async createRealtimeSession(apiKey, request, modelId) {
        const now = Date.now();
        const expiresInSeconds = request.expires_in_seconds ?? 30 * 60;
        const expireTime = new Date(now + expiresInSeconds * 1000).toISOString();
        const newSessionExpireTime = new Date(now + Math.min(expiresInSeconds, 60) * 1000).toISOString();
        const responseModalities = toRealtimeResponseModalities(request.response_modalities);
        const generationConfig = {
            responseModalities,
            temperature: request.temperature,
            speechConfig: request.voice
                ? {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: toGeminiVoiceName(request.voice),
                        },
                    },
                }
                : undefined,
        };
        const geminiTools = toGeminiTools(request.tools);
        const geminiToolConfig = toGeminiToolConfig(request.tool_choice);
        const setup = {
            model: `models/${modelId}`,
            generationConfig,
            systemInstruction: request.instructions
                ? { parts: [{ text: request.instructions }] }
                : undefined,
            inputAudioTranscription: request.input_audio_transcription ? {} : undefined,
            outputAudioTranscription: request.output_audio_transcription ? {} : undefined,
            tools: geminiTools,
            toolConfig: geminiToolConfig,
        };
        const body = {
            expireTime,
            newSessionExpireTime,
            uses: 1,
            bidiGenerateContentSetup: setup,
        };
        const res = await this.fetchWithTimeout(`${API_BASE_V1ALPHA}/auth_tokens?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }, 15000);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`Google API error ${res.status}: ${readProviderErrorText(err, res.statusText)}`);
        }
        const data = await res.json();
        const token = data.name ?? data.authToken?.name;
        if (!token) {
            throw new Error('Google realtime session returned no auth token');
        }
        const returnedExpireTime = data.expireTime ?? data.authToken?.expireTime ?? expireTime;
        const expiresAt = Math.floor(Date.parse(returnedExpireTime) / 1000);
        return {
            object: 'realtime.session',
            id: `rt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            provider: 'google',
            model: modelId,
            expires_at: expiresAt,
            client_secret: {
                value: token,
                expires_at: expiresAt,
            },
            connect_url: `${GEMINI_LIVE_CONSTRAINED_WS_URL}?access_token=${encodeURIComponent(token)}`,
            config: {
                response_modalities: responseModalities,
                input_audio_transcription: request.input_audio_transcription,
                output_audio_transcription: request.output_audio_transcription,
                voice: request.voice,
                instructions: request.instructions,
                temperature: request.temperature,
                tools: request.tools?.map(t => t.function.name),
            },
            _routed_via: { platform: 'google', model: modelId },
        };
    }
    async *streamChatCompletion(apiKey, messages, modelId, options) {
        const { contents, systemInstruction } = await toGeminiContents(messages);
        const body = {
            contents,
            generationConfig: {
                temperature: options?.temperature,
                maxOutputTokens: options?.max_tokens,
                topP: options?.top_p,
            },
            tools: toGeminiTools(options?.tools),
            toolConfig: toGeminiToolConfig(options?.tool_choice),
        };
        if (systemInstruction)
            body.systemInstruction = systemInstruction;
        const url = `${API_BASE}/models/${modelId}:streamGenerateContent?alt=sse&key=${apiKey}`;
        const res = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`Google API error ${res.status}: ${readProviderErrorText(err, res.statusText)}`);
        }
        const reader = res.body?.getReader();
        if (!reader)
            throw new Error('No response body');
        const decoder = new TextDecoder();
        const id = this.makeId();
        let buffer = '';
        let emittedFinish = false;
        let sawToolCalls = false;
        const seenToolCallKeys = new Set();
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: '))
                    continue;
                const raw = trimmed.slice(6);
                if (raw === '[DONE]') {
                    if (!emittedFinish) {
                        emittedFinish = true;
                        yield {
                            id,
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: modelId,
                            choices: [{
                                    index: 0,
                                    delta: {},
                                    finish_reason: sawToolCalls ? 'tool_calls' : 'stop',
                                }],
                        };
                    }
                    return;
                }
                // Skip malformed SSE frames instead of aborting the whole stream.
                // Matches the defensive parse in openai-compat / cohere / cloudflare:
                // a single corrupt chunk shouldn't take down the rest of the response.
                let chunk;
                try {
                    chunk = JSON.parse(raw);
                }
                catch {
                    continue;
                }
                const candidate = chunk.candidates?.[0];
                const parts = candidate?.content?.parts ?? [];
                const text = extractText(parts);
                const toolCalls = extractToolCalls(parts).filter(call => {
                    const key = `${call.id}:${call.function.name}:${call.function.arguments}`;
                    if (seenToolCallKeys.has(key))
                        return false;
                    seenToolCallKeys.add(key);
                    return true;
                });
                if ((text && text.length > 0) || toolCalls.length > 0) {
                    sawToolCalls = sawToolCalls || toolCalls.length > 0;
                    yield {
                        id,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: modelId,
                        choices: [{
                                index: 0,
                                delta: {
                                    ...(text ? { content: text } : {}),
                                    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
                                },
                                finish_reason: null,
                            }],
                    };
                }
                if (candidate?.finishReason && !emittedFinish) {
                    emittedFinish = true;
                    yield {
                        id,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: modelId,
                        choices: [{
                                index: 0,
                                delta: {},
                                finish_reason: sawToolCalls ? 'tool_calls' : toGeminiFinishReason(candidate.finishReason),
                            }],
                    };
                    return;
                }
            }
        }
        if (!emittedFinish) {
            yield {
                id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelId,
                choices: [{
                        index: 0,
                        delta: {},
                        finish_reason: sawToolCalls ? 'tool_calls' : 'stop',
                    }],
            };
        }
    }
    /**
     * Liveness only — this proves the key authenticates, NOT that its project may
     * run inference.
     *
     * Verified 2026-08-23 across 16 live keys: a project answering
     * "403: Your project has been denied access" on generateContent still returns
     * 200 from both `GET /models` and `countTokens`, so neither free endpoint can
     * detect the denial. Only generateContent can, and health.ts sweeps every 5
     * minutes — probing it here would burn ~4,600 free-tier requests a day just
     * to check keys.
     *
     * The denial is caught where it actually surfaces instead: classifyProviderError
     * maps it to an auth failure with a key-scoped 24h cooldown, so one 403 benches
     * that credential across every model rather than once per model.
     */
    async validateKey(apiKey) {
        // Transport errors propagate — health.ts marks status='error' without
        // counting toward auto-disable. Only confirmed 401/403 disables a key.
        const res = await this.fetchWithTimeout(`${API_BASE}/models?key=${apiKey}`, { method: 'GET' }, 10000);
        return res.status !== 401 && res.status !== 403;
    }
}
//# sourceMappingURL=google.js.map
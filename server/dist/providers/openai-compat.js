import { BaseProvider } from './base.js';
/**
 * Generic provider for platforms that use an OpenAI-compatible API.
 * Covers: Groq, Cerebras, SambaNova, NVIDIA NIM, Mistral, OpenRouter,
 * GitHub Models, Fireworks AI.
 */
export class OpenAICompatProvider extends BaseProvider {
    platform;
    name;
    baseUrl;
    extraHeaders;
    validateUrl;
    /** Per-provider HTTP timeout override. Cloud APIs finish in ~15s; locally-hosted
     * inference (llama.cpp / vLLM on CPU) can take 30-120s for long prompts. Default 15000. */
    timeoutMs;
    constructor(opts) {
        super();
        this.platform = opts.platform;
        this.name = opts.name;
        this.baseUrl = opts.baseUrl;
        this.extraHeaders = opts.extraHeaders ?? {};
        this.validateUrl = opts.validateUrl;
        this.timeoutMs = opts.timeoutMs ?? 15000;
    }
    async chatCompletion(apiKey, messages, modelId, options) {
        const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                ...this.extraHeaders,
            },
            body: JSON.stringify({
                model: modelId,
                messages,
                temperature: options?.temperature,
                max_tokens: options?.max_tokens,
                top_p: options?.top_p,
                tools: options?.tools,
                tool_choice: options?.tool_choice,
                parallel_tool_calls: options?.parallel_tool_calls,
            }),
        }, this.timeoutMs);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`${this.name} API error ${res.status}: ${readProviderErrorText(err, res.statusText)}`);
        }
        const data = await res.json();
        throwIfOpenAIErrorBody(this.name, data);
        normalizeChoices(data);
        data._routed_via = { platform: this.platform, model: modelId };
        return data;
    }
    async *streamChatCompletion(apiKey, messages, modelId, options) {
        const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                ...this.extraHeaders,
            },
            body: JSON.stringify({
                model: modelId,
                messages,
                temperature: options?.temperature,
                max_tokens: options?.max_tokens,
                top_p: options?.top_p,
                tools: options?.tools,
                tool_choice: options?.tool_choice,
                parallel_tool_calls: options?.parallel_tool_calls,
                stream: true,
            }),
        }, this.timeoutMs);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`${this.name} API error ${res.status}: ${readProviderErrorText(err, res.statusText)}`);
        }
        const reader = res.body?.getReader();
        if (!reader)
            throw new Error('No response body');
        const decoder = new TextDecoder();
        let buffer = '';
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
                const data = trimmed.slice(6);
                if (data === '[DONE]')
                    return;
                let chunk;
                try {
                    chunk = JSON.parse(data);
                }
                catch {
                    // Skip malformed chunks, but do not silently swallow provider error chunks.
                    if (data.includes('"error"'))
                        throw new Error(`${this.name} API error: provider returned an unreadable error chunk`);
                    continue;
                }
                throwIfOpenAIErrorBody(this.name, chunk);
                yield chunk;
            }
        }
    }
    async createEmbedding(apiKey, input, modelId, options) {
        const res = await this.fetchWithTimeout(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                ...this.extraHeaders,
            },
            body: JSON.stringify({
                model: modelId,
                input,
                encoding_format: options?.encoding_format,
                dimensions: options?.dimensions,
                user: options?.user,
            }),
        }, this.timeoutMs);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`${this.name} API error ${res.status}: ${readProviderErrorText(err, res.statusText)}`);
        }
        const data = await res.json();
        throwIfOpenAIErrorBody(this.name, data);
        data._routed_via = { platform: this.platform, model: modelId };
        return data;
    }
    async createImage(apiKey, request, modelId) {
        if (this.platform !== 'openrouter')
            return super.createImage(apiKey, request, modelId);
        return this.createOpenRouterImage(apiKey, [{ role: 'user', content: request.prompt }], modelId, request, 'OpenRouter image generation returned no image data');
    }
    async editImage(apiKey, request, modelId) {
        if (this.platform !== 'openrouter')
            return super.editImage(apiKey, request, modelId);
        const content = [
            { type: 'text', text: request.prompt },
            ...request.images.map(imageFileToOpenRouterPart),
        ];
        if (request.mask) {
            content.push({ type: 'text', text: 'Use the provided mask as the editable region.' }, imageFileToOpenRouterPart(request.mask));
        }
        return this.createOpenRouterImage(apiKey, [{ role: 'user', content }], modelId, request, 'OpenRouter image edit returned no image data');
    }
    async createImageVariation(apiKey, request, modelId) {
        if (this.platform !== 'openrouter')
            return super.createImageVariation(apiKey, request, modelId);
        return this.createOpenRouterImage(apiKey, [{
                role: 'user',
                content: [
                    { type: 'text', text: 'Create a variation of this image while preserving its main subject and composition.' },
                    imageFileToOpenRouterPart(request.image),
                ],
            }], modelId, request, 'OpenRouter image variation returned no image data');
    }
    async transcribeAudio(apiKey, request, modelId) {
        return this.forwardAudioText(apiKey, request, modelId, 'transcriptions');
    }
    async translateAudio(apiKey, request, modelId) {
        return this.forwardAudioText(apiKey, request, modelId, 'translations');
    }
    async createSpeech(apiKey, request, modelId) {
        const body = {
            model: modelId,
            input: request.input,
            voice: this.platform === 'groq' ? toGroqSpeechVoice(request.voice, modelId) : request.voice,
            response_format: request.response_format ?? 'wav',
        };
        if (typeof request.speed === 'number')
            body.speed = request.speed;
        if (request.instructions)
            body.instructions = request.instructions;
        const res = await this.fetchWithTimeout(`${this.baseUrl}/audio/speech`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                ...this.extraHeaders,
            },
            body: JSON.stringify(body),
        }, 120000);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`${this.name} API error ${res.status}: ${readProviderErrorText(err, res.statusText)}`);
        }
        const contentType = res.headers.get('content-type') ?? `audio/${request.response_format ?? 'wav'}`;
        if (contentType.includes('application/json')) {
            const err = await res.json().catch(() => ({}));
            throwIfOpenAIErrorBody(this.name, err);
            throw new Error(`${this.name} speech generation returned JSON instead of audio`);
        }
        const data = new Uint8Array(await res.arrayBuffer());
        return {
            data,
            contentType,
            format: request.response_format ?? 'wav',
            _routed_via: { platform: this.platform, model: modelId },
        };
    }
    async validateKey(apiKey) {
        // Note: transport errors (DNS / timeout / TLS) propagate to the caller.
        // health.ts catches them and marks status='error' WITHOUT incrementing
        // the consecutive-failure counter — only confirmed 401/403 disables a key.
        const url = this.validateUrl ?? `${this.baseUrl}/models`;
        const res = await this.fetchWithTimeout(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                ...this.extraHeaders,
            },
        }, 10000);
        return res.status !== 401 && res.status !== 403;
    }
    async forwardAudioText(apiKey, request, modelId, endpoint) {
        const form = buildAudioFormData(request, modelId);
        const res = await this.fetchWithTimeout(`${this.baseUrl}/audio/${endpoint}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                ...this.extraHeaders,
            },
            body: form,
        }, this.timeoutMs);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`${this.name} API error ${res.status}: ${readProviderErrorText(err, res.statusText)}`);
        }
        const contentType = res.headers.get('content-type') ?? 'application/json';
        const body = contentType.includes('application/json')
            ? await res.json()
            : await res.text();
        if (contentType.includes('application/json')) {
            throwIfOpenAIErrorBody(this.name, body);
        }
        return {
            body,
            contentType,
            _routed_via: { platform: this.platform, model: modelId },
        };
    }
    async createOpenRouterImage(apiKey, messages, modelId, request, emptyMessage) {
        const imageConfig = toOpenRouterImageConfig(request.size);
        const modalities = getOpenRouterImageModalities(modelId);
        const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                ...this.extraHeaders,
            },
            body: JSON.stringify({
                model: modelId,
                messages,
                modalities,
                stream: false,
                ...(imageConfig ? { image_config: imageConfig } : {}),
            }),
        }, 120000);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`${this.name} API error ${res.status}: ${readProviderErrorText(err, res.statusText)}`);
        }
        const data = await res.json();
        throwIfOpenAIErrorBody(this.name, data);
        const message = data.choices?.[0]?.message;
        const revisedPrompt = typeof message?.content === 'string' ? message.content.trim() : '';
        const images = (message?.images ?? [])
            .map(readOpenRouterImageUrl)
            .filter((url) => Boolean(url))
            .map(url => toImageData(url, request.response_format ?? 'b64_json', revisedPrompt));
        if (images.length === 0)
            throw new Error(emptyMessage);
        return {
            created: Math.floor(Date.now() / 1000),
            data: images,
            _routed_via: { platform: this.platform, model: modelId },
        };
    }
}
/**
 * Extract the most useful human-readable text from a failed response body.
 *
 * Most OpenAI-compatible providers answer `{ error: { message } }`, but NVIDIA
 * NIM returns RFC 7807 problem+json — `{ type, title, status, detail }` — with
 * no `error` key at all. Reading only `error.message` therefore fell through to
 * `res.statusText`, so a retirement that upstream explains in full ("The model
 * 'minimaxai/minimax-m2.7' has reached its end of life on 2026-07-27...")
 * surfaced in the dashboard as the useless "NVIDIA NIM API error 410: Gone".
 *
 * Checked in order of specificity; `detail`/`title` cover problem+json, bare
 * `message`/`detail` cover the aggregators that skip the `error` envelope.
 */
function readProviderErrorText(body, statusText) {
    if (!body || typeof body !== 'object')
        return statusText;
    const b = body;
    const error = b.error;
    if (typeof error === 'string' && error.trim())
        return error;
    if (error && typeof error === 'object') {
        const message = error.message;
        if (typeof message === 'string' && message.trim())
            return message;
    }
    // RFC 7807: prefer `detail` (the explanation), fall back to `title` (the
    // status phrase). Both present → "Gone: The model ... end of life ...".
    const detail = typeof b.detail === 'string' && b.detail.trim() ? b.detail : undefined;
    const title = typeof b.title === 'string' && b.title.trim() ? b.title : undefined;
    if (detail)
        return title && title !== detail ? `${title}: ${detail}` : detail;
    const message = typeof b.message === 'string' && b.message.trim() ? b.message : undefined;
    if (message)
        return message;
    return title ?? statusText;
}
function throwIfOpenAIErrorBody(providerName, data) {
    if (!data || typeof data !== 'object' || !('error' in data))
        return;
    const error = data.error;
    if (!error)
        return;
    if (typeof error === 'string') {
        throw new Error(`${providerName} API error: ${error}`);
    }
    if (typeof error === 'object') {
        const body = error;
        const message = typeof body.message === 'string' ? body.message : 'Provider returned error';
        const code = typeof body.code === 'number' || typeof body.code === 'string' ? ` ${body.code}` : '';
        throw new Error(`${providerName} API error${code}: ${message}`);
    }
    throw new Error(`${providerName} API error: Provider returned error`);
}
function toGroqSpeechVoice(voice, modelId) {
    const normalized = voice.toLowerCase().trim();
    const arabicVoices = new Set(['fahad']);
    const englishVoices = new Set(['austin', 'hannah', 'troy']);
    if (modelId.includes('arabic')) {
        return arabicVoices.has(normalized) ? normalized : 'fahad';
    }
    return englishVoices.has(normalized) ? normalized : 'austin';
}
function buildAudioFormData(request, modelId) {
    const form = new FormData();
    form.set('model', modelId);
    if (request.file) {
        const blob = new Blob([request.file.data], {
            type: request.file.contentType || 'application/octet-stream',
        });
        form.set('file', blob, request.file.filename || 'audio');
    }
    if (request.url)
        form.set('url', request.url);
    if ('language' in request && request.language)
        form.set('language', request.language);
    if (request.prompt)
        form.set('prompt', request.prompt);
    if (request.response_format)
        form.set('response_format', request.response_format);
    if (typeof request.temperature === 'number')
        form.set('temperature', String(request.temperature));
    if ('timestamp_granularities' in request && request.timestamp_granularities) {
        for (const granularity of request.timestamp_granularities) {
            form.append('timestamp_granularities[]', granularity);
        }
    }
    return form;
}
function imageFileToOpenRouterPart(file) {
    const base64 = Buffer.from(file.data).toString('base64');
    return {
        type: 'image_url',
        image_url: {
            url: `data:${file.contentType};base64,${base64}`,
        },
    };
}
function toOpenRouterImageConfig(size) {
    switch (size) {
        case '1024x1024':
            return { aspect_ratio: '1:1' };
        case '1536x1024':
            return { aspect_ratio: '3:2' };
        case '1024x1536':
            return { aspect_ratio: '2:3' };
        case 'auto':
        case undefined:
            return undefined;
        default:
            return undefined;
    }
}
function getOpenRouterImageModalities(modelId) {
    return /^(google|openai)\//i.test(modelId) ? ['image', 'text'] : ['image'];
}
function readOpenRouterImageUrl(image) {
    return image.imageUrl?.url ?? image.image_url?.url ?? image.url;
}
function toImageData(url, responseFormat, revisedPrompt) {
    const image = responseFormat === 'url' ? { url } : dataUrlToB64(url);
    if (revisedPrompt)
        image.revised_prompt = revisedPrompt;
    return image;
}
function dataUrlToB64(url) {
    const match = /^data:[^;]+;base64,(.+)$/i.exec(url);
    return match ? { b64_json: match[1] } : { url };
}
/**
 * Some providers (Z.ai glm-4.5-flash, Cloudflare DeepSeek-R1-distill, others)
 * return reasoning models' actual answer in `message.reasoning_content` with
 * `message.content === ""`. Fold reasoning_content into content so OpenAI-
 * compatible clients see a non-empty assistant message.
 *
 * Other providers (Mistral magistral-medium) return `message.content` as an
 * array of text segments instead of a string. Flatten to string.
 */
function normalizeChoices(data) {
    for (const choice of data.choices ?? []) {
        const msg = choice.message;
        // Flatten array content (Mistral magistral) → join text segments.
        if (Array.isArray(msg.content)) {
            msg.content = msg.content
                .map(seg => (typeof seg === 'string' ? seg : (seg.text ?? '')))
                .join('');
        }
        // Fold reasoning into content if content is empty AND there are no
        // tool_calls. With tool_calls present, content=null is the correct OpenAI
        // shape; folding reasoning would confuse clients that branch on content.
        // Field naming varies by provider: Z.ai uses `reasoning_content`, Ollama
        // uses `reasoning`. Prefer `reasoning_content` when both are set.
        const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
        if (!hasToolCalls && (msg.content === '' || msg.content == null)) {
            const fold = (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0)
                ? msg.reasoning_content
                : (typeof msg.reasoning === 'string' && msg.reasoning.length > 0 ? msg.reasoning : null);
            if (fold !== null)
                msg.content = fold;
        }
    }
}
//# sourceMappingURL=openai-compat.js.map
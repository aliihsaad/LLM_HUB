export class BaseProvider {
    async createEmbedding(_apiKey, _input, _modelId, _options) {
        throw new Error(`${this.name} does not support embeddings`);
    }
    async createImage(_apiKey, _request, _modelId) {
        throw new Error(`${this.name} does not support image generation`);
    }
    async editImage(_apiKey, _request, _modelId) {
        throw new Error(`${this.name} does not support image edits`);
    }
    async createImageVariation(_apiKey, _request, _modelId) {
        throw new Error(`${this.name} does not support image variations`);
    }
    async createSpeech(_apiKey, _request, _modelId) {
        throw new Error(`${this.name} does not support speech`);
    }
    async transcribeAudio(_apiKey, _request, _modelId) {
        throw new Error(`${this.name} does not support transcription`);
    }
    async translateAudio(_apiKey, _request, _modelId) {
        throw new Error(`${this.name} does not support translation`);
    }
    async createRealtimeSession(_apiKey, _request, _modelId) {
        throw new Error(`${this.name} does not support realtime sessions`);
    }
    /**
     * Per-provider HTTP timeout for subclasses that do not pass one explicitly.
     * 15s suits fast cloud inference; providers hosting large models, or that
     * queue free-tier traffic behind paid, override this. Production logged
     * aborts before the overrides landed: nvidia 182, google 67, sambanova 31,
     * mistral 11, zhipu 7, llm7 4 — and an abort costs a 120s key cooldown in
     * classifyProviderError, so one slow request benches the whole provider.
     */
    defaultTimeoutMs = 15000;
    async fetchWithTimeout(url, init, timeoutMs = this.defaultTimeoutMs) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...init, signal: controller.signal });
        }
        finally {
            clearTimeout(timeout);
        }
    }
    makeId() {
        return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
}
/**
 * Extract the most useful human-readable text from a failed response body.
 *
 * Providers disagree on error shape, and reading only `error.message` meant
 * every other shape collapsed to `res.statusText`. Confirmed shapes as of
 * 2026-08-23:
 *
 *   {error:{message}}       Groq, OpenRouter, SambaNova, Zhipu, Vercel, Kilo,
 *                           Google, GitHub
 *   {type,title,status,detail}  NVIDIA NIM (RFC 7807 problem+json)
 *   {message}               Cerebras, Cohere
 *   {detail}                Mistral
 *   {error:"string"}        Hugging Face
 *   {errors:[{message}]}    Cloudflare
 *
 * Checked in order of specificity, so a provider that supplies several fields
 * still yields its most specific one.
 */
export function readProviderErrorText(body, statusText) {
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
    // Cloudflare returns a list; the first entry carries the actionable text.
    const errors = b.errors;
    if (Array.isArray(errors) && errors.length > 0) {
        const first = errors[0];
        const message = first?.message;
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
//# sourceMappingURL=base.js.map
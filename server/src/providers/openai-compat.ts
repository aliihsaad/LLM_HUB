import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  AudioTextResult,
  AudioTranscriptionRequest,
  AudioTranslationRequest,
  EmbeddingInput,
  EmbeddingOptions,
  EmbeddingResponse,
  Platform,
} from 'llmhub-shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';

/**
 * Generic provider for platforms that use an OpenAI-compatible API.
 * Covers: Groq, Cerebras, SambaNova, NVIDIA NIM, Mistral, OpenRouter,
 * GitHub Models, Fireworks AI.
 */
export class OpenAICompatProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly validateUrl?: string;
  /** Per-provider HTTP timeout override. Cloud APIs finish in ~15s; locally-hosted
   * inference (llama.cpp / vLLM on CPU) can take 30-120s for long prompts. Default 15000. */
  private readonly timeoutMs: number;

  constructor(opts: {
    platform: Platform;
    name: string;
    baseUrl: string;
    extraHeaders?: Record<string, string>;
    validateUrl?: string;
    timeoutMs?: number;
  }) {
    super();
    this.platform = opts.platform;
    this.name = opts.name;
    this.baseUrl = opts.baseUrl;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.validateUrl = opts.validateUrl;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
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
      throw new Error(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const data = await res.json() as ChatCompletionResponse;
    throwIfOpenAIErrorBody(this.name, data);
    normalizeChoices(data);
    data._routed_via = { platform: this.platform, model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
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
      throw new Error(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(data) as ChatCompletionChunk;
        } catch {
          // Skip malformed chunks, but do not silently swallow provider error chunks.
          if (data.includes('"error"')) throw new Error(`${this.name} API error: provider returned an unreadable error chunk`);
          continue;
        }
        throwIfOpenAIErrorBody(this.name, chunk);
        yield chunk;
      }
    }
  }

  async createEmbedding(
    apiKey: string,
    input: EmbeddingInput,
    modelId: string,
    options?: EmbeddingOptions,
  ): Promise<EmbeddingResponse> {
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
      throw new Error(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const data = await res.json() as EmbeddingResponse;
    throwIfOpenAIErrorBody(this.name, data);
    data._routed_via = { platform: this.platform, model: modelId };
    return data;
  }

  async transcribeAudio(
    apiKey: string,
    request: AudioTranscriptionRequest,
    modelId: string,
  ): Promise<AudioTextResult> {
    return this.forwardAudioText(apiKey, request, modelId, 'transcriptions');
  }

  async translateAudio(
    apiKey: string,
    request: AudioTranslationRequest,
    modelId: string,
  ): Promise<AudioTextResult> {
    return this.forwardAudioText(apiKey, request, modelId, 'translations');
  }

  async validateKey(apiKey: string): Promise<boolean> {
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

  private async forwardAudioText(
    apiKey: string,
    request: AudioTranscriptionRequest | AudioTranslationRequest,
    modelId: string,
    endpoint: 'transcriptions' | 'translations',
  ): Promise<AudioTextResult> {
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
      throw new Error(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
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
}

function throwIfOpenAIErrorBody(providerName: string, data: unknown): void {
  if (!data || typeof data !== 'object' || !('error' in data)) return;

  const error = (data as { error?: unknown }).error;
  if (!error) return;

  if (typeof error === 'string') {
    throw new Error(`${providerName} API error: ${error}`);
  }

  if (typeof error === 'object') {
    const body = error as { message?: unknown; code?: unknown; type?: unknown };
    const message = typeof body.message === 'string' ? body.message : 'Provider returned error';
    const code = typeof body.code === 'number' || typeof body.code === 'string' ? ` ${body.code}` : '';
    throw new Error(`${providerName} API error${code}: ${message}`);
  }

  throw new Error(`${providerName} API error: Provider returned error`);
}

function buildAudioFormData(
  request: AudioTranscriptionRequest | AudioTranslationRequest,
  modelId: string,
): FormData {
  const form = new FormData();
  form.set('model', modelId);

  if (request.file) {
    const blob = new Blob([request.file.data], {
      type: request.file.contentType || 'application/octet-stream',
    });
    form.set('file', blob, request.file.filename || 'audio');
  }

  if (request.url) form.set('url', request.url);
  if ('language' in request && request.language) form.set('language', request.language);
  if (request.prompt) form.set('prompt', request.prompt);
  if (request.response_format) form.set('response_format', request.response_format);
  if (typeof request.temperature === 'number') form.set('temperature', String(request.temperature));
  if ('timestamp_granularities' in request && request.timestamp_granularities) {
    for (const granularity of request.timestamp_granularities) {
      form.append('timestamp_granularities[]', granularity);
    }
  }

  return form;
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
function normalizeChoices(data: ChatCompletionResponse): void {
  for (const choice of data.choices ?? []) {
    const msg = choice.message as ChatMessage & {
      reasoning_content?: string;
      reasoning?: string;
      content: unknown;
    };
    // Flatten array content (Mistral magistral) → join text segments.
    if (Array.isArray(msg.content)) {
      msg.content = (msg.content as Array<{ text?: string; type?: string }>)
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
      if (fold !== null) msg.content = fold;
    }
  }
}

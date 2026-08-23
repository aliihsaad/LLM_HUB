import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolDefinition,
  ChatToolChoice,
  EmbeddingInput,
  EmbeddingOptions,
  EmbeddingResponse,
  ImageEditRequest,
  ImageVariationRequest,
  ImageGenerationRequest,
  ImagesResponse,
  Platform,
  AudioTextResult,
  AudioTranscriptionRequest,
  AudioTranslationRequest,
  RealtimeSessionRequest,
  RealtimeSessionResponse,
  SpeechRequest,
  SpeechResult,
} from 'llmhub-shared/types.js';

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
}

export abstract class BaseProvider {
  abstract readonly platform: Platform;
  abstract readonly name: string;

  abstract chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse>;

  abstract streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk>;

  async createEmbedding(
    _apiKey: string,
    _input: EmbeddingInput,
    _modelId: string,
    _options?: EmbeddingOptions,
  ): Promise<EmbeddingResponse> {
    throw new Error(`${this.name} does not support embeddings`);
  }

  async createImage(
    _apiKey: string,
    _request: ImageGenerationRequest,
    _modelId: string,
  ): Promise<ImagesResponse> {
    throw new Error(`${this.name} does not support image generation`);
  }

  async editImage(
    _apiKey: string,
    _request: ImageEditRequest,
    _modelId: string,
  ): Promise<ImagesResponse> {
    throw new Error(`${this.name} does not support image edits`);
  }

  async createImageVariation(
    _apiKey: string,
    _request: ImageVariationRequest,
    _modelId: string,
  ): Promise<ImagesResponse> {
    throw new Error(`${this.name} does not support image variations`);
  }

  async createSpeech(
    _apiKey: string,
    _request: SpeechRequest,
    _modelId: string,
  ): Promise<SpeechResult> {
    throw new Error(`${this.name} does not support speech`);
  }

  async transcribeAudio(
    _apiKey: string,
    _request: AudioTranscriptionRequest,
    _modelId: string,
  ): Promise<AudioTextResult> {
    throw new Error(`${this.name} does not support transcription`);
  }

  async translateAudio(
    _apiKey: string,
    _request: AudioTranslationRequest,
    _modelId: string,
  ): Promise<AudioTextResult> {
    throw new Error(`${this.name} does not support translation`);
  }

  async createRealtimeSession(
    _apiKey: string,
    _request: RealtimeSessionRequest,
    _modelId: string,
  ): Promise<RealtimeSessionResponse> {
    throw new Error(`${this.name} does not support realtime sessions`);
  }

  abstract validateKey(apiKey: string): Promise<boolean>;

  /**
   * Per-provider HTTP timeout for subclasses that do not pass one explicitly.
   * 15s suits fast cloud inference; providers hosting large models, or that
   * queue free-tier traffic behind paid, override this. Production logged
   * aborts before the overrides landed: nvidia 182, google 67, sambanova 31,
   * mistral 11, zhipu 7, llm7 4 — and an abort costs a 120s key cooldown in
   * classifyProviderError, so one slow request benches the whole provider.
   */
  protected defaultTimeoutMs = 15000;

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  protected makeId(): string {
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
export function readProviderErrorText(body: unknown, statusText: string): string {
  if (!body || typeof body !== 'object') return statusText;
  const b = body as Record<string, unknown>;

  const error = b.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message;
  }

  // Cloudflare returns a list; the first entry carries the actionable text.
  const errors = b.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as Record<string, unknown> | undefined;
    const message = first?.message;
    if (typeof message === 'string' && message.trim()) return message;
  }

  // RFC 7807: prefer `detail` (the explanation), fall back to `title` (the
  // status phrase). Both present → "Gone: The model ... end of life ...".
  const detail = typeof b.detail === 'string' && b.detail.trim() ? b.detail : undefined;
  const title = typeof b.title === 'string' && b.title.trim() ? b.title : undefined;
  if (detail) return title && title !== detail ? `${title}: ${detail}` : detail;

  const message = typeof b.message === 'string' && b.message.trim() ? b.message : undefined;
  if (message) return message;

  return title ?? statusText;
}

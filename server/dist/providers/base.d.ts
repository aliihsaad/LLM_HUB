import type { ChatMessage, ChatCompletionResponse, ChatCompletionChunk, ChatToolDefinition, ChatToolChoice, EmbeddingInput, EmbeddingOptions, EmbeddingResponse, ImageEditRequest, ImageVariationRequest, ImageGenerationRequest, ImagesResponse, Platform, AudioTextResult, AudioTranscriptionRequest, AudioTranslationRequest, RealtimeSessionRequest, RealtimeSessionResponse, SpeechRequest, SpeechResult } from 'llmhub-shared/types.js';
export interface CompletionOptions {
    model?: string;
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    tools?: ChatToolDefinition[];
    tool_choice?: ChatToolChoice;
    parallel_tool_calls?: boolean;
}
export declare abstract class BaseProvider {
    abstract readonly platform: Platform;
    abstract readonly name: string;
    abstract chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): Promise<ChatCompletionResponse>;
    abstract streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): AsyncGenerator<ChatCompletionChunk>;
    createEmbedding(_apiKey: string, _input: EmbeddingInput, _modelId: string, _options?: EmbeddingOptions): Promise<EmbeddingResponse>;
    createImage(_apiKey: string, _request: ImageGenerationRequest, _modelId: string): Promise<ImagesResponse>;
    editImage(_apiKey: string, _request: ImageEditRequest, _modelId: string): Promise<ImagesResponse>;
    createImageVariation(_apiKey: string, _request: ImageVariationRequest, _modelId: string): Promise<ImagesResponse>;
    createSpeech(_apiKey: string, _request: SpeechRequest, _modelId: string): Promise<SpeechResult>;
    transcribeAudio(_apiKey: string, _request: AudioTranscriptionRequest, _modelId: string): Promise<AudioTextResult>;
    translateAudio(_apiKey: string, _request: AudioTranslationRequest, _modelId: string): Promise<AudioTextResult>;
    createRealtimeSession(_apiKey: string, _request: RealtimeSessionRequest, _modelId: string): Promise<RealtimeSessionResponse>;
    abstract validateKey(apiKey: string): Promise<boolean>;
    /**
     * Per-provider HTTP timeout for subclasses that do not pass one explicitly.
     * 15s suits fast cloud inference; providers hosting large models, or that
     * queue free-tier traffic behind paid, override this. Production logged
     * aborts before the overrides landed: nvidia 182, google 67, sambanova 31,
     * mistral 11, zhipu 7, llm7 4 — and an abort costs a 120s key cooldown in
     * classifyProviderError, so one slow request benches the whole provider.
     */
    protected defaultTimeoutMs: number;
    protected fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number): Promise<Response>;
    protected makeId(): string;
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
export declare function readProviderErrorText(body: unknown, statusText: string): string;
//# sourceMappingURL=base.d.ts.map
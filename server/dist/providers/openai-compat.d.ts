import type { ChatMessage, ChatCompletionResponse, ChatCompletionChunk, AudioTextResult, AudioTranscriptionRequest, AudioTranslationRequest, EmbeddingInput, EmbeddingOptions, EmbeddingResponse, ImageEditRequest, ImageGenerationRequest, ImagesResponse, ImageVariationRequest, Platform, SpeechRequest, SpeechResult } from 'llmhub-shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';
/**
 * Generic provider for platforms that use an OpenAI-compatible API.
 * Covers: Groq, Cerebras, SambaNova, NVIDIA NIM, Mistral, OpenRouter,
 * GitHub Models, Fireworks AI.
 */
export declare class OpenAICompatProvider extends BaseProvider {
    readonly platform: Platform;
    readonly name: string;
    private readonly baseUrl;
    private readonly extraHeaders;
    private readonly validateUrl?;
    /** Per-provider HTTP timeout override. Cloud APIs finish in ~15s; locally-hosted
     * inference (llama.cpp / vLLM on CPU) can take 30-120s for long prompts. Default 15000. */
    private readonly timeoutMs;
    constructor(opts: {
        platform: Platform;
        name: string;
        baseUrl: string;
        extraHeaders?: Record<string, string>;
        validateUrl?: string;
        timeoutMs?: number;
    });
    chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): Promise<ChatCompletionResponse>;
    streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): AsyncGenerator<ChatCompletionChunk>;
    createEmbedding(apiKey: string, input: EmbeddingInput, modelId: string, options?: EmbeddingOptions): Promise<EmbeddingResponse>;
    createImage(apiKey: string, request: ImageGenerationRequest, modelId: string): Promise<ImagesResponse>;
    editImage(apiKey: string, request: ImageEditRequest, modelId: string): Promise<ImagesResponse>;
    createImageVariation(apiKey: string, request: ImageVariationRequest, modelId: string): Promise<ImagesResponse>;
    transcribeAudio(apiKey: string, request: AudioTranscriptionRequest, modelId: string): Promise<AudioTextResult>;
    translateAudio(apiKey: string, request: AudioTranslationRequest, modelId: string): Promise<AudioTextResult>;
    createSpeech(apiKey: string, request: SpeechRequest, modelId: string): Promise<SpeechResult>;
    validateKey(apiKey: string): Promise<boolean>;
    private forwardAudioText;
    private createOpenRouterImage;
}
//# sourceMappingURL=openai-compat.d.ts.map
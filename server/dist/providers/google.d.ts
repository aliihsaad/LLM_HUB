import type { ChatMessage, ChatCompletionResponse, ChatCompletionChunk, AudioTextResult, AudioTranscriptionRequest, ImageEditRequest, ImageGenerationRequest, ImageVariationRequest, ImagesResponse, RealtimeSessionRequest, RealtimeSessionResponse, SpeechRequest, SpeechResult } from 'llmhub-shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';
export declare class GoogleProvider extends BaseProvider {
    readonly platform: "google";
    readonly name = "Google AI Studio";
    protected defaultTimeoutMs: number;
    chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): Promise<ChatCompletionResponse>;
    createImage(apiKey: string, request: ImageGenerationRequest, modelId: string): Promise<ImagesResponse>;
    editImage(apiKey: string, request: ImageEditRequest, modelId: string): Promise<ImagesResponse>;
    createImageVariation(apiKey: string, request: ImageVariationRequest, modelId: string): Promise<ImagesResponse>;
    private generateImageFromParts;
    transcribeAudio(apiKey: string, request: AudioTranscriptionRequest, modelId: string): Promise<AudioTextResult>;
    createSpeech(apiKey: string, request: SpeechRequest, modelId: string): Promise<SpeechResult>;
    createRealtimeSession(apiKey: string, request: RealtimeSessionRequest, modelId: string): Promise<RealtimeSessionResponse>;
    streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): AsyncGenerator<ChatCompletionChunk>;
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
    validateKey(apiKey: string): Promise<boolean>;
}
//# sourceMappingURL=google.d.ts.map
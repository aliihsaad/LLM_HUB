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
    protected fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number): Promise<Response>;
    protected makeId(): string;
}
//# sourceMappingURL=base.d.ts.map
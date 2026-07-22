import type { ChatMessage, ChatCompletionResponse, ChatCompletionChunk, AudioTextResult, AudioTranscriptionRequest, ImageEditRequest, ImageGenerationRequest, ImageVariationRequest, ImagesResponse, RealtimeSessionRequest, RealtimeSessionResponse, SpeechRequest, SpeechResult } from 'llmhub-shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';
export declare class GoogleProvider extends BaseProvider {
    readonly platform: "google";
    readonly name = "Google AI Studio";
    chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): Promise<ChatCompletionResponse>;
    createImage(apiKey: string, request: ImageGenerationRequest, modelId: string): Promise<ImagesResponse>;
    editImage(apiKey: string, request: ImageEditRequest, modelId: string): Promise<ImagesResponse>;
    createImageVariation(apiKey: string, request: ImageVariationRequest, modelId: string): Promise<ImagesResponse>;
    private generateImageFromParts;
    transcribeAudio(apiKey: string, request: AudioTranscriptionRequest, modelId: string): Promise<AudioTextResult>;
    createSpeech(apiKey: string, request: SpeechRequest, modelId: string): Promise<SpeechResult>;
    createRealtimeSession(apiKey: string, request: RealtimeSessionRequest, modelId: string): Promise<RealtimeSessionResponse>;
    streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): AsyncGenerator<ChatCompletionChunk>;
    validateKey(apiKey: string): Promise<boolean>;
}
//# sourceMappingURL=google.d.ts.map
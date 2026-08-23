import type { ChatMessage, ChatCompletionResponse, ChatCompletionChunk } from 'llmhub-shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';
export declare class CohereProvider extends BaseProvider {
    readonly platform: "cohere";
    readonly name = "Cohere";
    protected defaultTimeoutMs: number;
    chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): Promise<ChatCompletionResponse>;
    streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): AsyncGenerator<ChatCompletionChunk>;
    validateKey(apiKey: string): Promise<boolean>;
}
//# sourceMappingURL=cohere.d.ts.map
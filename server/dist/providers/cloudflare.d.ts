import type { ChatMessage, ChatCompletionResponse, ChatCompletionChunk } from 'llmhub-shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';
/**
 * Cloudflare Workers AI provider.
 * API key format expected: "account_id:api_token"
 * The account_id is extracted from the key to build the URL.
 */
export declare class CloudflareProvider extends BaseProvider {
    readonly platform: "cloudflare";
    readonly name = "Cloudflare Workers AI";
    protected defaultTimeoutMs: number;
    private parseKey;
    private normalizeMessages;
    chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): Promise<ChatCompletionResponse>;
    streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions): AsyncGenerator<ChatCompletionChunk>;
    validateKey(apiKey: string): Promise<boolean>;
}
//# sourceMappingURL=cloudflare.d.ts.map
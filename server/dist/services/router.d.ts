import type { BaseProvider } from '../providers/base.js';
export type ModelFailureCategory = 'zero_quota' | 'rate_limit' | 'model_unavailable' | 'timeout' | 'provider' | 'auth' | 'other';
export interface ModelRuntimeHealth {
    modelDbId: number;
    status: 'healthy' | 'degraded' | 'unavailable';
    failureCount: number;
    lastErrorCategory: ModelFailureCategory | null;
    lastError: string | null;
    lastFailedAt: string | null;
    lastSuccessAt: string | null;
    blockedUntil: string | null;
}
export type ModelCapability = 'chat' | 'embeddings' | 'vision' | 'video' | 'images' | 'image_generation' | 'image_edit' | 'image_variation' | 'audio' | 'speech' | 'transcription' | 'translation' | 'realtime_audio';
export interface RouteResult {
    provider: BaseProvider;
    modelId: string;
    modelDbId: number;
    apiKey: string;
    keyId: number;
    platform: string;
    displayName: string;
}
export declare function recordModelFailure(modelDbId: number, category: ModelFailureCategory, message: string, blockMs?: number): void;
export declare function recordModelHealthSuccess(modelDbId: number): void;
export declare function getModelRuntimeHealth(): ModelRuntimeHealth[];
export declare function clearModelRuntimeHealth(modelDbId: number): void;
/**
 * Record a 429 for a model — increases its penalty so it sinks in priority.
 */
export declare function recordRateLimitHit(modelDbId: number): void;
/**
 * Record a success for a model — reduces its penalty so it rises back up.
 */
export declare function recordSuccess(modelDbId: number): void;
/**
 * Get current penalties for all models (for the API/dashboard).
 */
export declare function getAllPenalties(): Array<{
    modelDbId: number;
    count: number;
    penalty: number;
}>;
/**
 * Route a request to the best available model.
 * Models are sorted by (base_priority + rate_limit_penalty) so frequently
 * rate-limited models automatically sink below working ones.
 *
 * If preferredModelDbId is set, that model gets tried FIRST (sticky sessions).
 * This prevents hallucination from model switching mid-conversation.
 *
 * @param estimatedTokens - estimated total tokens for rate limit check
 * @param skipKeys - set of "platform:modelId:keyId" to skip (failed on this request)
 * @param preferredModelDbId - try this model first (sticky session)
 */
export declare function routeRequest(estimatedTokens?: number, skipKeys?: Set<string>, preferredModelDbId?: number, skipModelDbIds?: Set<number>, category?: string, platformFilter?: string): RouteResult;
export declare function routeRequestInternal(estimatedTokens?: number, skipKeys?: Set<string>, preferredModelDbId?: number, skipModelDbIds?: Set<number>, category?: string, platformFilter?: string): RouteResult;
/**
 * Route a request for a specific model capability such as embeddings.
 * Capability routes are intentionally independent from the chat fallback
 * chain so endpoint-specific models cannot accidentally serve chat traffic.
 */
export declare function routeCapabilityRequest(capability: ModelCapability, estimatedTokens?: number, skipKeys?: Set<string>, requestedModel?: string, skipModelDbIds?: Set<number>, platformFilter?: string): RouteResult;
//# sourceMappingURL=router.d.ts.map
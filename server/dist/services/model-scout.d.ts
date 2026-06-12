import type { Platform } from 'llmhub-shared/types.js';
export interface AvailabilityCheck {
    modelDbId: number;
    platform: Platform;
    modelId: string;
    status: 'free' | 'rate_limited' | 'deprecated' | 'error' | 'unknown';
    lastCheckAt: string;
    lastError?: string;
    discoverySource?: string;
    freeTierConfirmed: boolean;
}
export interface DiscoveredModelCandidate {
    platform: Platform;
    modelId: string;
    displayName: string;
    enabledByDefault?: boolean;
    capabilities?: DiscoveredModelCapability[];
}
export interface DiscoveredModelResult {
    discovered: DiscoveredModelCandidate[];
    inserted: DiscoveredModelCandidate[];
    skippedKnown: DiscoveredModelCandidate[];
    insertedCount: number;
    skippedKnownCount: number;
    insertedModelIds: number[];
}
type DiscoveredModelCapability = 'chat' | 'vision';
/**
 * Check if a specific model is still available on the free tier.
 *
 * Strategy per platform:
 * — OpenAI-compatible: try a cheap /v1/models or /v1/chat/completions probe.
 * — Google: hit the model-specific generateContent endpoint with a dummy prompt.
 * — Cloudflare: hit the @cf/{model}/ai/run endpoint.
 *
 * A 200 with content = free, 429 = rate_limited (still free), 401/403 = deprecated or invalid key,
 * 404 = deprecated (model removed), transport error = error.
 */
export declare function checkModelAvailability(modelDbId: number): Promise<AvailabilityCheck>;
/**
 * Check all enabled models in batches with delays to avoid rate limits.
 */
export declare function scoutAllModels(delayMs?: number): Promise<AvailabilityCheck[]>;
/**
 * Discover new free models by querying each provider's /v1/models endpoint.
 */
export declare function discoverNewModels(): Promise<DiscoveredModelCandidate[]>;
/**
 * Discover new free models and add them to the catalog.
 *
 * New models receive a discovery_source in model_availability so UI can show
 * them as newly introduced catalog entries.
 */
export declare function discoverAndPersistNewModels(): Promise<DiscoveredModelResult>;
export declare function startModelScout(): void;
export declare function stopModelScout(): void;
export {};
//# sourceMappingURL=model-scout.d.ts.map
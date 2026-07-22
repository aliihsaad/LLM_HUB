import { getDb } from '../db/index.js';
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
    isFree?: boolean;
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
export type GoogleModelVerdict = {
    include: false;
} | {
    include: true;
    displayName: string;
    enabledByDefault: boolean;
    isFree: boolean;
};
/**
 * Decide what to do with a Google model returned by /v1beta/models.
 *
 * Google's list endpoint carries no pricing, so we cannot classify cost the way
 * we do for providers that publish it. Instead of the old behaviour — a
 * hardcoded allowlist that made every newly released model structurally
 * invisible — an unrecognised chat model is now surfaced DISABLED and marked
 * paid. It shows up in the dashboard for review and can never auto-route or
 * spend until an operator confirms it.
 */
export declare function classifyGoogleModel(modelId: string, apiDisplayName?: string): GoogleModelVerdict;
type DiscoveredModelCapability = 'chat' | 'vision' | 'video';
interface OpenAICompatModelListEntry {
    id?: string;
    name?: string;
    context_length?: number | null;
    architecture?: {
        input_modalities?: string[];
        output_modalities?: string[];
        modality?: string;
    };
    pricing?: {
        prompt?: string;
        completion?: string;
    };
}
/** BazaarLink sync keeps only zero-priced, chat-usable, text-output entries —
 *  the 44 zero-"priced" image/video-gen models bill elsewhere and stay out. */
export declare function isBazaarlinkFreeChatEntry(entry: OpenAICompatModelListEntry & {
    context_length?: number | null;
}): boolean;
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
/** Enabled models eligible for the availability sweep. Paid rows are skipped
 *  while free-only mode is on so probes never spend key credit. */
export declare function selectSweepCandidateIds(db: ReturnType<typeof getDb>): number[];
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
/**
 * Re-verify pricing + presence for a pricing-bearing platform's existing rows.
 * Only call with an authoritative (HTTP 200) upstream list — never on fetch
 * errors, so transient failures cannot disable the catalog.
 */
export declare function applyPricingDrift(db: ReturnType<typeof getDb>, platform: Platform, entries: Array<{
    id?: string;
    pricing?: {
        prompt?: string;
        completion?: string;
    };
}>): {
    becamePaid: string[];
    wentMissing: string[];
};
export declare function startModelScout(): void;
export declare function stopModelScout(): void;
export {};
//# sourceMappingURL=model-scout.d.ts.map
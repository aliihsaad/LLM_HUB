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
 * Does this provider error mean "this model no longer exists"?
 *
 * Deliberately narrow. It must match removal only — never an auth problem, a
 * quota problem or an outage — because a match feeds the retirement counter.
 * Confirmed live 2026-08-23:
 *   NVIDIA     410 "The model 'minimaxai/minimax-m2.7' has reached its end of life"
 *   OpenRouter 404 "This model is unavailable for free. The paid version ..."
 *   LLM7       400 "Model 'gpt-oss-20b' is currently unavailable."
 *   Cerebras   404 "Model does not exist or you do not have access to it."
 */
export declare function isGoneMessage(message: string | undefined): boolean;
/**
 * Consecutive "gone" probes before a row is retired. The scout runs every 30
 * minutes, so 3 means a model must be gone for roughly 90 minutes across three
 * independent checks — enough to ride out an upstream blip, quick enough that a
 * dead model leaves the routing chain the same day.
 */
export declare const GONE_STREAK_TO_RETIRE = 3;
/**
 * Advance or reset a model's gone streak, retiring it once the streak is met.
 *
 * Presence reconciliation against a provider's bulk /models list is deliberately
 * NOT used: OpenRouter's list returns chat models only, so diffing against it
 * reports embedding and image rows as missing and would disable live models.
 * Probing each model directly is provider-agnostic and immune to that.
 *
 * Returns the model_id when this call retired it, otherwise null.
 */
export declare function recordGoneStreak(db: ReturnType<typeof getDb>, modelDbId: number, isGone: boolean): string | null;
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
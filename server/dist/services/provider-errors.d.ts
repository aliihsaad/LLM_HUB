import type { ModelFailureCategory } from './router.js';
export interface ClassifiedProviderError {
    category: ModelFailureCategory;
    retryable: boolean;
    skipModel: boolean;
    keyCooldownMs: number;
}
export declare function classifyProviderError(err: unknown): ClassifiedProviderError;
export declare function canRetryProviderFailure(failure: ClassifiedProviderError, requestedModel?: string): boolean;
//# sourceMappingURL=provider-errors.d.ts.map
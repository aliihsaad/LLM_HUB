import type { ModelFailureCategory } from './router.js';
export interface ClassifiedProviderError {
    category: ModelFailureCategory;
    retryable: boolean;
    skipModel: boolean;
    keyCooldownMs: number;
    /**
     * How wide the cooldown should be. 'model' benches the credential for the
     * one model that failed; 'key' benches it for every model on the platform,
     * which is the only correct scope when the failure is a property of the
     * account rather than the model.
     */
    cooldownScope?: 'model' | 'key';
}
export declare function classifyProviderError(err: unknown): ClassifiedProviderError;
export declare function canRetryProviderFailure(failure: ClassifiedProviderError, requestedModel?: string): boolean;
//# sourceMappingURL=provider-errors.d.ts.map
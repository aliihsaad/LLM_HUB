export function classifyProviderError(err) {
    const msg = err instanceof Error
        ? err.message.toLowerCase()
        : String(err?.message ?? err ?? '').toLowerCase();
    const isZeroQuotaLimit = /(?:quota|rate|request|token|capacity|free[_ -]?tier|limit).{0,200}\blimit\s*[:=]\s*0\b/s.test(msg)
        || /\blimit\s*[:=]\s*0\b.{0,200}(?:quota|rate|request|token|capacity|free[_ -]?tier)/s.test(msg);
    if (isZeroQuotaLimit) {
        return { category: 'zero_quota', retryable: true, skipModel: true, keyCooldownMs: 0 };
    }
    if (msg.includes('401')
        || msg.includes('unauthorized')
        || msg.includes('invalid api key')
        || msg.includes('invalid_api_key')) {
        return { category: 'auth', retryable: false, skipModel: false, keyCooldownMs: 0 };
    }
    if (msg.includes('404')
        || msg.includes('not found')
        || msg.includes('model does not exist')
        || msg.includes('unavailable_model')
        || msg.includes('no endpoints found')) {
        return { category: 'model_unavailable', retryable: true, skipModel: true, keyCooldownMs: 0 };
    }
    if (msg.includes('403')
        || msg.includes('forbidden')
        || msg.includes('subscription')
        || msg.includes('requires a paid')
        || msg.includes('do not have access')) {
        return { category: 'model_unavailable', retryable: true, skipModel: true, keyCooldownMs: 0 };
    }
    if (msg.includes('429')
        || msg.includes('rate limit')
        || msg.includes('too many requests')
        || msg.includes('quota')
        || msg.includes('resource_exhausted')) {
        return { category: 'rate_limit', retryable: true, skipModel: false, keyCooldownMs: 120_000 };
    }
    if (msg.includes('aborted')
        || msg.includes('timeout')
        || msg.includes('etimedout')
        || msg.includes('econnrefused')
        || msg.includes('econnreset')) {
        return { category: 'timeout', retryable: true, skipModel: true, keyCooldownMs: 120_000 };
    }
    if (msg.includes('503')
        || msg.includes('unavailable')
        || msg.includes('500')
        || msg.includes('internal server error')) {
        return { category: 'provider', retryable: true, skipModel: true, keyCooldownMs: 60_000 };
    }
    return { category: 'other', retryable: false, skipModel: false, keyCooldownMs: 0 };
}
export function canRetryProviderFailure(failure, requestedModel) {
    return failure.retryable && (!requestedModel || !failure.skipModel);
}
//# sourceMappingURL=provider-errors.js.map
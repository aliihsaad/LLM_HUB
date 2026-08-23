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

export function classifyProviderError(err: unknown): ClassifiedProviderError {
  const msg = err instanceof Error
    ? err.message.toLowerCase()
    : String((err as { message?: unknown })?.message ?? err ?? '').toLowerCase();
  const isZeroQuotaLimit = /(?:quota|rate|request|token|capacity|free[_ -]?tier|limit).{0,200}\blimit\s*[:=]\s*0\b/s.test(msg)
    || /\blimit\s*[:=]\s*0\b.{0,200}(?:quota|rate|request|token|capacity|free[_ -]?tier)/s.test(msg);

  if (isZeroQuotaLimit) {
    return { category: 'zero_quota', retryable: true, skipModel: true, keyCooldownMs: 0 };
  }

  // Account-level denials. These describe the credential's project or org, so
  // they repeat on every model it owns — a per-model cooldown would let the
  // router pick the same dead credential again for the next model. Matched
  // before the generic 403 branch, which would otherwise read them as
  // model_unavailable. Live example logged 50 times on the VPS:
  // "Google API error 403: Your project has been denied access."
  if (
    msg.includes('organization has been restricted')
    || msg.includes('organization is restricted')
    || msg.includes('project has been denied access')
    || msg.includes('has been denied access')
    || msg.includes('account has been suspended')
    || msg.includes('account is suspended')
  ) {
    return {
      category: 'auth',
      retryable: true,
      skipModel: false,
      keyCooldownMs: 24 * 60 * 60 * 1000,
      cooldownScope: 'key',
    };
  }

  if (
    msg.includes('401')
    || msg.includes('unauthorized')
    || msg.includes('invalid api key')
    || msg.includes('invalid_api_key')
  ) {
    return { category: 'auth', retryable: false, skipModel: false, keyCooldownMs: 0 };
  }

  if (
    msg.includes('404')
    || msg.includes('410')
    || msg.includes('not found')
    || msg.includes('model does not exist')
    || msg.includes('unavailable_model')
    || msg.includes('no endpoints found')
  ) {
    return { category: 'model_unavailable', retryable: true, skipModel: true, keyCooldownMs: 0 };
  }

  if (
    msg.includes('403')
    || msg.includes('forbidden')
    || msg.includes('subscription')
    || msg.includes('requires a paid')
    || msg.includes('do not have access')
    || msg.includes('requires terms acceptance')
    || msg.includes('accept the terms')
  ) {
    return { category: 'model_unavailable', retryable: true, skipModel: true, keyCooldownMs: 0 };
  }

  if (
    msg.includes('429')
    || msg.includes('rate limit')
    || msg.includes('too many requests')
    || msg.includes('quota')
    || msg.includes('resource_exhausted')
  ) {
    return { category: 'rate_limit', retryable: true, skipModel: false, keyCooldownMs: 120_000 };
  }

  if (
    msg.includes('aborted')
    || msg.includes('timeout')
    || msg.includes('etimedout')
    || msg.includes('econnrefused')
    || msg.includes('econnreset')
  ) {
    return { category: 'timeout', retryable: true, skipModel: true, keyCooldownMs: 120_000 };
  }

  if (
    msg.includes('503')
    || msg.includes('unavailable')
    || msg.includes('500')
    || msg.includes('internal server error')
  ) {
    return { category: 'provider', retryable: true, skipModel: true, keyCooldownMs: 60_000 };
  }

  return { category: 'other', retryable: false, skipModel: false, keyCooldownMs: 0 };
}

export function canRetryProviderFailure(failure: ClassifiedProviderError, requestedModel?: string): boolean {
  return failure.retryable && (!requestedModel || !failure.skipModel);
}

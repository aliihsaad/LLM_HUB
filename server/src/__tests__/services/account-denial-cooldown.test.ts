import { describe, it, expect } from 'vitest';
import { canRetryProviderFailure, classifyProviderError } from '../../services/provider-errors.js';
import { setCooldown, setKeyCooldown, isOnCooldown } from '../../services/ratelimit.js';

// Live-verified 2026-08-23 against 16 Google keys on the VPS: one project
// answers 403 "Your project has been denied access" on generateContent while
// GET /models and countTokens both return 200 — which is why its dashboard row
// read "healthy" while it failed 50 real requests.
describe('account-level denials', () => {
  const DENIAL = 'Google API error 403: Your project has been denied access. Please contact support.';

  it('classifies a project denial as an auth failure, not a model problem', () => {
    const f = classifyProviderError(new Error(DENIAL));
    expect(f.category).toBe('auth');
    // The model is fine — every other key serves it — so do not blacklist it.
    expect(f.skipModel).toBe(false);
    expect(f.keyCooldownMs).toBeGreaterThan(0);
  });

  it('scopes the denial cooldown to the credential, not one model', () => {
    expect(classifyProviderError(new Error(DENIAL)).cooldownScope).toBe('key');
    expect(
      classifyProviderError(new Error('Provider error: organization has been restricted')).cooldownScope,
    ).toBe('key');
  });

  it('still treats an ordinary 403 as a per-model problem', () => {
    const f = classifyProviderError(new Error('API error 403: model requires a paid subscription'));
    expect(f.category).toBe('model_unavailable');
    expect(f.cooldownScope).not.toBe('key');
  });

  it('does not mistake a rate limit for a denial', () => {
    expect(classifyProviderError(new Error('API error 429: rate limit')).category).toBe('rate_limit');
  });
});

// Live 2026-09-22 on the production Playground: Cerebras now answers 402 on
// chat completions for every model until the account adds a payment method,
// while GET /models still lists them. The 402 fell through to 'other'
// (retryable: false), so model:auto returned a 502 instead of trying the next
// model, and recorded nothing, so the next request picked Cerebras again.
describe('payment-required denials', () => {
  const CEREBRAS_402 = 'Cerebras API error 402: Payment required to access this resource. Visit your billing tab.';

  it('lets an auto-routed request fall through to the next model', () => {
    const f = classifyProviderError(new Error(CEREBRAS_402));
    expect(f.retryable).toBe(true);
    expect(canRetryProviderFailure(f)).toBe(true);
  });

  it('benches the credential across the platform instead of blaming the model', () => {
    const f = classifyProviderError(new Error(CEREBRAS_402));
    expect(f.category).toBe('auth');
    expect(f.skipModel).toBe(false);
    expect(f.cooldownScope).toBe('key');
    expect(f.keyCooldownMs).toBeGreaterThan(0);
  });

  it('wins over the quota wording some providers put in a 402 body', () => {
    // Chutes' 402 body — would otherwise read as a 2-minute rate limit.
    const f = classifyProviderError(
      new Error('Chutes API error 402: Quota exceeded and account balance is $0.0, please pay with fiat or send tao'),
    );
    expect(f.category).toBe('auth');
    expect(f.cooldownScope).toBe('key');
  });

  it('does not read 402 inside a larger number as a status code', () => {
    expect(classifyProviderError(new Error('context of 4020 tokens exceeded')).category).toBe('other');
  });
});

describe('key-scoped cooldowns', () => {
  it('benches a credential across every model on the platform', () => {
    const keyId = 90_101;
    expect(isOnCooldown('google', 'gemini-a', keyId)).toBe(false);

    setKeyCooldown('google', keyId, 60_000);

    // Every model on that platform is now unavailable for this credential.
    expect(isOnCooldown('google', 'gemini-a', keyId)).toBe(true);
    expect(isOnCooldown('google', 'gemini-b', keyId)).toBe(true);
    expect(isOnCooldown('google', 'anything-else', keyId)).toBe(true);
  });

  it('leaves other credentials and other platforms alone', () => {
    const keyId = 90_102;
    setKeyCooldown('google', keyId, 60_000);

    expect(isOnCooldown('google', 'gemini-a', 90_103)).toBe(false);
    expect(isOnCooldown('groq', 'gemini-a', keyId)).toBe(false);
  });

  it('expires, and does not disturb per-model cooldowns', () => {
    const keyId = 90_104;
    setKeyCooldown('google', keyId, -1);
    expect(isOnCooldown('google', 'gemini-a', keyId)).toBe(false);

    setCooldown('google', 'gemini-a', keyId, 60_000);
    expect(isOnCooldown('google', 'gemini-a', keyId)).toBe(true);
    expect(isOnCooldown('google', 'gemini-b', keyId)).toBe(false);
  });
});

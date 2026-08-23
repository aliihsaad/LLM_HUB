import { describe, it, expect } from 'vitest';
import { classifyProviderError } from '../../services/provider-errors.js';
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

import { describe, expect, it } from 'vitest';
import { canRetryProviderFailure, classifyProviderError } from '../../services/provider-errors.js';

describe('provider error classification', () => {
  it.each(['401', '402', '403', '404', '410'])('does not interpret decimal retry delay 0.%s as HTTP status', (digits) => {
    const failure = classifyProviderError(new Error(`Google API error 429: Retry in 0.${digits} seconds.`));
    expect(failure.category).toBe('rate_limit');
    expect(failure.cooldownScope).not.toBe('key');
  });

  it('accepts structured HTTP status without searching arbitrary response digits', () => {
    expect(classifyProviderError({ status: 401, message: 'Credential rejected' }).category).toBe('auth');
    expect(classifyProviderError({ status: 429, message: 'Retry in 0.401 seconds' }).category).toBe('rate_limit');
  });

  it('keeps ordinary auth terminal outside the Live handler', () => {
    expect(classifyProviderError(new Error('Google API error 401: Unauthorized'))).toMatchObject({
      category: 'auth', retryable: false, keyCooldownMs: 0,
    });
  });

  it('rotates to another key when a provider organization is restricted', () => {
    const failure = classifyProviderError(
      new Error('Groq API error 400: Organization has been restricted. Please reach out to support.'),
    );

    expect(failure).toMatchObject({
      category: 'auth',
      retryable: true,
      skipModel: false,
    });
    expect(failure.keyCooldownMs).toBeGreaterThan(0);
    expect(canRetryProviderFailure(failure, 'whisper-large-v3-turbo')).toBe(true);
  });

  it('treats HTTP 410 Gone as a model-level unavailable error so routing moves on', () => {
    const failure = classifyProviderError(
      new Error('Ollama Cloud API error 410: Gone'),
    );

    expect(failure).toMatchObject({
      category: 'model_unavailable',
      retryable: true,
      skipModel: true,
    });
    // auto-route: skip the retired model and continue down the chain
    expect(canRetryProviderFailure(failure)).toBe(true);
    // pinned request: fail honestly instead of silently switching models
    expect(canRetryProviderFailure(failure, 'qwen3-coder:480b')).toBe(false);
  });

  it('treats provider terms acceptance gates as model-level unavailable errors', () => {
    const failure = classifyProviderError(
      new Error('Groq API error 400: The model `canopylabs/orpheus-v1-english` requires terms acceptance. Please have the org admin accept the terms.'),
    );

    expect(failure).toMatchObject({
      category: 'model_unavailable',
      retryable: true,
      skipModel: true,
    });
    expect(canRetryProviderFailure(failure)).toBe(true);
    expect(canRetryProviderFailure(failure, 'canopylabs/orpheus-v1-english')).toBe(false);
  });
});

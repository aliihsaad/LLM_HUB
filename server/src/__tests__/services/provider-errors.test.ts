import { describe, expect, it } from 'vitest';
import { canRetryProviderFailure, classifyProviderError } from '../../services/provider-errors.js';

describe('provider error classification', () => {
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

import { describe, it, expect } from 'vitest';
import { classifyGoogleModel } from '../../services/model-scout.js';

describe('classifyGoogleModel', () => {
  it('auto-enables models confirmed free on the Gemini API', () => {
    for (const id of ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']) {
      const verdict = classifyGoogleModel(id);
      expect(verdict.include, `${id} should be discoverable`).toBe(true);
      if (!verdict.include) continue;
      expect(verdict.enabledByDefault, `${id} should be enabled`).toBe(true);
      expect(verdict.isFree, `${id} should be free`).toBe(true);
    }
  });

  it('still surfaces an unknown Gemini model, but disabled and paid so it can never auto-spend', () => {
    // The whole point: a model Google ships tomorrow must not be invisible.
    const verdict = classifyGoogleModel('gemini-4.0-ultra', 'Gemini 4.0 Ultra');
    expect(verdict.include).toBe(true);
    if (!verdict.include) return;
    expect(verdict.enabledByDefault).toBe(false);
    expect(verdict.isFree).toBe(false);
    expect(verdict.displayName).toBe('Gemini 4.0 Ultra');
  });

  it('skips non-chat model families that would only add catalog noise', () => {
    for (const id of [
      'gemini-embedding-001',
      'veo-3.1-generate-preview',
      'lyria-3-pro-preview',
      'imagen-4.0-generate',
      'gemini-robotics-er-1.6-preview',
      'gemini-2.5-computer-use-preview-10-2025',
      'deep-research-pro-preview-12-2025',
    ]) {
      expect(classifyGoogleModel(id).include, `${id} should be skipped`).toBe(false);
    }
  });

  it('falls back to the model id when Google reports no display name', () => {
    const verdict = classifyGoogleModel('gemini-9.9-experimental');
    expect(verdict.include).toBe(true);
    if (!verdict.include) return;
    expect(verdict.displayName).toBe('gemini-9.9-experimental');
  });
});

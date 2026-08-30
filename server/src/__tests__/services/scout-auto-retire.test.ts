import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { isGoneMessage, recordGoneStreak, GONE_STREAK_TO_RETIRE } from '../../services/model-scout.js';

/**
 * The scout probed every model every 30 minutes for months and never retired
 * anything, because the only function that disabled dead rows was gated to a
 * single platform (`if (platform === 'bazaarlink')`). That is why 4 end-of-lifed
 * NVIDIA models, 159 dead Hugging Face rows and 15 discontinued OpenRouter
 * `:free` routes all sat enabled until they were removed by hand.
 */
describe('isGoneMessage', () => {
  // Captured from live providers on 2026-08-23.
  const gone = [
    "NVIDIA NIM API error 410: Gone: The model 'minimaxai/minimax-m2.7' has reached its end of life on 2026-07-27",
    'OpenRouter API error 404: This model is unavailable for free. The paid version is available now',
    "LLM7 API error 400: Model 'gpt-oss-20b' is currently unavailable.",
    'Cerebras API error 404: Model does not exist or you do not have access to it.',
    'Google API error 404: This model models/gemini-2.5-pro is no longer available to new users',
    'NVIDIA NIM API error 404: Not Found',
  ];

  for (const msg of gone) {
    it(`treats as gone: ${msg.slice(0, 52)}…`, () => {
      expect(isGoneMessage(msg)).toBe(true);
    });
  }

  // A lapsed key answers 401/403 for EVERY model on a platform. Counting that
  // as "gone" would retire an entire provider three cycles after a key expired.
  const notGone = [
    'Groq API error 401: Invalid API Key',
    'Google API error 403: Your project has been denied access. Please contact support.',
    'Cohere API error 401: Unauthorized',
    'Hugging Face API error 402: Payment Required',
    'OpenRouter API error 429: Rate limit exceeded: free-models-per-day',
    'This operation was aborted',
    'Provider error 503: Service temporarily overloaded',
    undefined,
    '',
  ];

  for (const msg of notGone) {
    it(`does NOT treat as gone: ${String(msg).slice(0, 52) || '(empty)'}`, () => {
      expect(isGoneMessage(msg)).toBe(false);
    });
  }

  it('never calls a 404 gone when the text also shows an auth failure', () => {
    // Some gateways wrap an auth failure in a 404-ish envelope; auth wins.
    expect(isGoneMessage('API error 404: Not Found (401 Unauthorized upstream)')).toBe(false);
  });
});

describe('recordGoneStreak', () => {
  let modelId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM models WHERE model_id = 'streak-probe'").run();
    modelId = Number(db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, context_window, enabled, is_free)
      VALUES ('groq', 'streak-probe', 'Streak Probe', 5, 5, 'Medium', 131072, 1, 1)
    `).run().lastInsertRowid);
    db.prepare("INSERT INTO model_availability (model_db_id, status) VALUES (?, 'unknown')").run(modelId);
  });

  const enabledOf = (id: number) =>
    (getDb().prepare('SELECT enabled FROM models WHERE id = ?').get(id) as { enabled: number }).enabled;

  it('does not retire before the streak is reached', () => {
    const db = getDb();
    for (let i = 1; i < GONE_STREAK_TO_RETIRE; i++) {
      expect(recordGoneStreak(db, modelId, true)).toBeNull();
      expect(enabledOf(modelId)).toBe(1);
    }
  });

  it('retires exactly on the configured streak', () => {
    const db = getDb();
    let retired: string | null = null;
    for (let i = 0; i < GONE_STREAK_TO_RETIRE; i++) retired = recordGoneStreak(db, modelId, true);
    expect(retired).toBe('streak-probe');
    expect(enabledOf(modelId)).toBe(0);
  });

  it('resets the streak on any non-gone result, so blips never accumulate', () => {
    const db = getDb();
    for (let i = 0; i < GONE_STREAK_TO_RETIRE - 1; i++) recordGoneStreak(db, modelId, true);
    recordGoneStreak(db, modelId, false);          // one healthy check
    for (let i = 0; i < GONE_STREAK_TO_RETIRE - 1; i++) recordGoneStreak(db, modelId, true);

    expect(enabledOf(modelId), 'a reset must prevent retirement').toBe(1);
  });

  it('reports the retirement only once', () => {
    const db = getDb();
    for (let i = 0; i < GONE_STREAK_TO_RETIRE; i++) recordGoneStreak(db, modelId, true);
    // Already disabled — further gone probes must not re-announce it.
    expect(recordGoneStreak(db, modelId, true)).toBeNull();
  });
});

/**
 * Regression: the scout retired two working Gemini realtime models.
 *
 * It probes Google with generateContent, but realtime models only answer over
 * bidiGenerateContent, so Google returns a 404 that means "wrong endpoint",
 * not "model removed". isGoneMessage matched the 404 and three cycles later
 * both rows were disabled — while they were working perfectly in the app.
 */
describe('wrong-method 404s are not deprecation', () => {
  const wrongMethod = [
    'Google API error 404: models/gemini-3.1-flash-live-preview is not found for API version v1beta, or is not supported for generateContent. Call ModelService.ListModels to see the list of available models and their supported methods.',
    'Google API error 404: models/gemini-2.5-flash-native-audio-preview-12-2025 is not found for API version v1beta, or is not supported for generateContent.',
    'API error 404: this model is not supported by the completions endpoint',
  ];

  for (const msg of wrongMethod) {
    it(`keeps the model when the endpoint is wrong: ${msg.slice(30, 78)}…`, () => {
      expect(isGoneMessage(msg)).toBe(false);
    });
  }

  it('still retires a genuine Google removal', () => {
    // No "supported methods" clause — the model really is gone.
    expect(isGoneMessage(
      'Google API error 404: This model models/gemini-2.5-pro is no longer available to new users',
    )).toBe(true);
  });
});

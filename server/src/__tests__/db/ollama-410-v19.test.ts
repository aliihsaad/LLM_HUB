import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

// Live-verified 2026-07-22: Ollama Cloud answers `410 Gone` for
// qwen3-coder:480b — the hosted model was removed upstream. With
// intelligence_rank 2 the row sat at the top of the auto-route chain, so
// every `model: "auto"` request died on it before the 410 classifier fix.
const RETIRED_OLLAMA_MODELS = ['qwen3-coder:480b'];

// Probed the same day through /v1/chat/completions: these still answer 200.
const LIVE_OLLAMA_MODELS = ['gemma4:31b', 'gpt-oss:120b', 'gpt-oss:20b'];

describe('V19 Ollama Cloud retirement', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('disables the Ollama Cloud rows the upstream deleted (410 Gone)', () => {
    const db = getDb();
    for (const modelId of RETIRED_OLLAMA_MODELS) {
      const row = db
        .prepare("SELECT enabled FROM models WHERE platform = 'ollama' AND model_id = ?")
        .get(modelId) as { enabled: number } | undefined;
      expect(row, `${modelId} should exist in the catalog`).toBeDefined();
      expect(row!.enabled, `${modelId} must be disabled — upstream returns 410`).toBe(0);
    }
  });

  it('keeps the still-hosted Ollama Cloud models enabled', () => {
    const db = getDb();
    for (const modelId of LIVE_OLLAMA_MODELS) {
      const row = db
        .prepare("SELECT enabled FROM models WHERE platform = 'ollama' AND model_id = ?")
        .get(modelId) as { enabled: number } | undefined;
      expect(row, `${modelId} should exist in the catalog`).toBeDefined();
      expect(row!.enabled, `${modelId} should stay enabled`).toBe(1);
    }
  });
});

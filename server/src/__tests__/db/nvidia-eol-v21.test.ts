import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

// Live-probed 2026-08-23 against integrate.api.nvidia.com. NVIDIA resolves the
// model name before auth, so an unauthenticated POST to /v1/chat/completions
// separates the cases cleanly: 401/403 = route exists, 404 = never existed,
// 410 = retired. These four answered 410 and are gone from GET /v1/models.
const RETIRED_NVIDIA_MODELS = [
  'meta/llama-4-maverick-17b-128e-instruct',
  'deepseek-ai/deepseek-v4-pro',
  'mistralai/mistral-large-3-675b-instruct-2512',
  'minimaxai/minimax-m2.7',
];

// Probed the same day: still answer 401 (route alive, auth required).
const LIVE_NVIDIA_MODELS = [
  'meta/llama-3.1-70b-instruct',
  'meta/llama-3.3-70b-instruct',
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/nemotron-3-nano-30b-a3b',
  'google/gemma-4-31b-it',
  'moonshotai/kimi-k2.6',
];

// Replacements added by V21 — each probe-confirmed 401 on the same run.
const ADDED_NVIDIA_MODELS = [
  'deepseek-ai/deepseek-v4-flash-0731',
  'minimaxai/minimax-m3',
  'mistralai/mistral-nemotron',
  'meta/muse-glimmer-30b',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'moonshotai/kimi-k3',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'openai/gpt-oss-120b',
];

describe('V21 NVIDIA NIM end-of-life retirement', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('disables the NVIDIA rows the upstream end-of-lifed (410 Gone)', () => {
    const db = getDb();
    for (const modelId of RETIRED_NVIDIA_MODELS) {
      const row = db
        .prepare("SELECT enabled FROM models WHERE platform = 'nvidia' AND model_id = ?")
        .get(modelId) as { enabled: number } | undefined;
      expect(row, `${modelId} should exist in the catalog`).toBeDefined();
      expect(row!.enabled, `${modelId} must be disabled — upstream returns 410`).toBe(0);
    }
  });

  it('keeps the still-hosted NVIDIA models enabled', () => {
    const db = getDb();
    for (const modelId of LIVE_NVIDIA_MODELS) {
      const row = db
        .prepare("SELECT enabled FROM models WHERE platform = 'nvidia' AND model_id = ?")
        .get(modelId) as { enabled: number } | undefined;
      expect(row, `${modelId} should exist in the catalog`).toBeDefined();
      expect(row!.enabled, `${modelId} should stay enabled`).toBe(1);
    }
  });

  it('adds the current NVIDIA-hosted replacements as routable rows', () => {
    const db = getDb();
    for (const modelId of ADDED_NVIDIA_MODELS) {
      const row = db
        .prepare("SELECT id, enabled FROM models WHERE platform = 'nvidia' AND model_id = ?")
        .get(modelId) as { id: number; enabled: number } | undefined;
      expect(row, `${modelId} should have been added by V21`).toBeDefined();
      expect(row!.enabled, `${modelId} should be enabled`).toBe(1);

      const fb = db
        .prepare('SELECT id FROM fallback_config WHERE model_db_id = ?')
        .get(row!.id) as { id: number } | undefined;
      expect(fb, `${modelId} needs a fallback_config row to be routable`).toBeDefined();
    }
  });
});

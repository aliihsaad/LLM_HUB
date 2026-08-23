import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

// All verified 2026-08-23 against live endpoints and the production request
// log on the VPS (4618 requests, 2205 errors).

// 559 of Hugging Face's 563 logged failures are "402: Payment Required"; the
// GitHub Models service answers "github_models_retirement_brownout" on both
// its inference and catalog endpoints.
const DEAD_PLATFORMS = ['huggingface', 'github'];

// Present on openrouter.ai/api/v1/models only as paid slugs — the `:free`
// variants were discontinued. The bare slug still resolves, so leaving these
// enabled is a billing risk, not just a failure.
const RETIRED_OPENROUTER = [
  'inclusionai/ling-2.6-1t:free',
  'liquid/lfm-2.5-1.2b-instruct:free',
  'liquid/lfm-2.5-1.2b-thinking:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'minimax/minimax-m2.5:free',
  'nex-agi/nex-n2-pro:free',
  'openai/gpt-oss-120b:free',
  'openai/gpt-oss-20b:free',
  'poolside/laguna-m.1:free',
  'poolside/laguna-xs.2:free',
  'qwen/qwen3-coder:free',
  'qwen/qwen3-embedding-0.6b',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'tencent/hy3-preview:free',
  'z-ai/glm-4.5-air:free',
];

// Absent from api.llm7.io/v1/models; three are ID drift, ministral is gone.
const RETIRED_LLM7 = [
  'GLM-4.6V-Flash',
  'gpt-oss-20b',
  'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
  'ministral-8b-2512',
];

// Still listed upstream as `:free` on the same run.
const LIVE_OPENROUTER = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-nano-9b-v2:free',
  'google/gemma-4-31b-it:free',
];

// Regression guard. These are absent from the bulk /api/v1/models listing
// because that listing only returns chat models — but /models/{id}/endpoints
// reports 2, 2, 1, 1 and 1 serving endpoints respectively, so they are alive.
// An earlier pass retired them off the bulk list alone and broke embeddings
// and image routing; never trust the bulk list for non-chat models.
const LIVE_NON_CHAT_OPENROUTER = [
  'openai/text-embedding-3-small',
  'openai/text-embedding-3-large',
  'black-forest-labs/flux.2-klein-4b',
  'sourceful/riverflow-v2.5-fast',
  'sourceful/riverflow-v2.5-pro',
];

const ADDED_OPENROUTER = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'z-ai/glm-5.2:free',
  'thinkingmachines/inkling:free',
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
  'nvidia/nemotron-3.5-lightning:free',
  'thinkingmachines/inkling-small:free',
  'cohere/north-mini-code:free',
  'dots-studio/dots-3-note-preview:free',
  'liquid/lfm-2.5-2.6b:free',
];

// Probe-confirmed HTTP 200 anonymously against api.llm7.io.
const ADDED_LLM7 = [
  'DeepSeek-V4-Flash-0731',
  'gpt-oss:20b',
  'meta-Llama-3.1-8B-Instruct-Turbo',
];

describe('V22 provider retirement and free-tier drift', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('disables every model on the two dead providers', () => {
    const db = getDb();
    for (const platform of DEAD_PLATFORMS) {
      const rows = db
        .prepare('SELECT model_id, enabled FROM models WHERE platform = ?')
        .all(platform) as { model_id: string; enabled: number }[];
      expect(rows.length, `${platform} should still have catalog rows`).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.enabled, `${platform}/${row.model_id} must be disabled`).toBe(0);
      }
    }
  });

  it('disables OpenRouter rows whose :free variant was discontinued', () => {
    const db = getDb();
    for (const modelId of RETIRED_OPENROUTER) {
      const row = db
        .prepare("SELECT enabled FROM models WHERE platform = 'openrouter' AND model_id = ?")
        .get(modelId) as { enabled: number } | undefined;
      expect(row, `${modelId} should exist in the catalog`).toBeDefined();
      expect(row!.enabled, `${modelId} must be disabled — free tier ended`).toBe(0);
    }
  });

  it('disables the LLM7 rows that no longer resolve', () => {
    const db = getDb();
    for (const modelId of RETIRED_LLM7) {
      const row = db
        .prepare("SELECT enabled FROM models WHERE platform = 'llm7' AND model_id = ?")
        .get(modelId) as { enabled: number } | undefined;
      expect(row, `${modelId} should exist in the catalog`).toBeDefined();
      expect(row!.enabled, `${modelId} must be disabled`).toBe(0);
    }
  });

  it('leaves still-live OpenRouter free routes enabled', () => {
    const db = getDb();
    for (const modelId of LIVE_OPENROUTER) {
      const row = db
        .prepare("SELECT enabled FROM models WHERE platform = 'openrouter' AND model_id = ?")
        .get(modelId) as { enabled: number } | undefined;
      expect(row, `${modelId} should exist in the catalog`).toBeDefined();
      expect(row!.enabled, `${modelId} should stay enabled`).toBe(1);
    }
  });

  it('keeps live embedding and image rows enabled despite the bulk list omitting them', () => {
    const db = getDb();
    for (const modelId of LIVE_NON_CHAT_OPENROUTER) {
      const row = db
        .prepare("SELECT enabled FROM models WHERE platform = 'openrouter' AND model_id = ?")
        .get(modelId) as { enabled: number } | undefined;
      expect(row, `${modelId} should exist in the catalog`).toBeDefined();
      expect(
        row!.enabled,
        `${modelId} is live (has serving endpoints) and must NOT be retired`,
      ).toBe(1);
    }
  });

  it('adds the current free routes as enabled, routable rows', () => {
    const db = getDb();
    const cases: Array<[string, string[]]> = [
      ['openrouter', ADDED_OPENROUTER],
      ['llm7', ADDED_LLM7],
    ];
    for (const [platform, ids] of cases) {
      for (const modelId of ids) {
        const row = db
          .prepare('SELECT id, enabled, is_free FROM models WHERE platform = ? AND model_id = ?')
          .get(platform, modelId) as { id: number; enabled: number; is_free: number } | undefined;
        expect(row, `${platform}/${modelId} should have been added by V22`).toBeDefined();
        expect(row!.enabled, `${platform}/${modelId} should be enabled`).toBe(1);
        expect(row!.is_free, `${platform}/${modelId} should count as free`).toBe(1);

        const fb = db
          .prepare('SELECT id FROM fallback_config WHERE model_db_id = ?')
          .get(row!.id) as { id: number } | undefined;
        expect(fb, `${platform}/${modelId} needs a fallback_config row`).toBeDefined();
      }
    }
  });

  // Two deliberate exclusions. The content-safety model is a moderation
  // classifier that would return safety verdicts, not answers, if the router
  // ever picked it for chat. glm-5.3 answers 401 without a key on LLM7, so its
  // free-tier status is unconfirmed and it must not be seeded as a free route.
  it('does not add the deliberately excluded models', () => {
    const db = getDb();
    const excluded: Array<[string, string]> = [
      ['openrouter', 'nvidia/nemotron-3.5-content-safety:free'],
      ['llm7', 'glm-5.3'],
    ];
    for (const [platform, modelId] of excluded) {
      const row = db
        .prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
        .get(platform, modelId) as { id: number } | undefined;
      expect(row, `${platform}/${modelId} must not be in the catalog`).toBeUndefined();
    }
  });

  it('records that the retirements ran', () => {
    const flag = getDb()
      .prepare("SELECT value FROM settings WHERE key = 'v22_catalog_retirements_applied'")
      .get() as { value: string } | undefined;
    expect(flag, 'V22 should record that its retirements ran').toBeDefined();
  });
});

// Regression guard for the recovery path the migration documents: the
// retirement is one-time, so an operator who re-enables Hugging Face after
// topping the account up keeps that change across restarts. Needs a real file
// so the second initDb reopens the same database.
describe('V22 retirement is one-time', () => {
  it('does not re-disable a provider an operator re-enabled', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const dbPath = path.join(os.tmpdir(), `llmhub-v22-guard-${Date.now()}.db`);

    const first = await initDb(dbPath);
    const afterMigration = first
      .prepare("SELECT COUNT(*) AS c FROM models WHERE platform = 'huggingface' AND enabled = 1")
      .get() as { c: number };
    expect(afterMigration.c, 'V22 should disable Hugging Face on first run').toBe(0);

    // Operator tops the account up and re-enables the provider.
    first.prepare("UPDATE models SET enabled = 1 WHERE platform = 'huggingface'").run();
    first.close();

    const second = await initDb(dbPath);
    const afterRestart = second
      .prepare("SELECT COUNT(*) AS c FROM models WHERE platform = 'huggingface' AND enabled = 1")
      .get() as { c: number };
    second.close();
    fs.rmSync(dbPath, { force: true });

    expect(afterRestart.c, 'a manual re-enable must survive a restart').toBeGreaterThan(0);
  });
});

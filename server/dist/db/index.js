import crypto from 'crypto';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initEncryptionKey } from '../lib/crypto.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/freeapi.db');
let db;
export function getDb() {
    if (!db) {
        throw new Error('Database not initialized. Call initDb() first.');
    }
    return db;
}
export async function initDb(dbPath) {
    const resolvedPath = dbPath ?? DB_PATH;
    const isMemory = resolvedPath === ':memory:';
    if (!isMemory) {
        const dataDir = path.dirname(resolvedPath);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
    }
    db = new Database(resolvedPath);
    if (!isMemory)
        db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createTables(db);
    initEncryptionKey(db);
    seedModels(db);
    migrateModels(db);
    migrateModelsV2(db);
    migrateModelsV3Ranks(db);
    migrateModelsV4(db);
    migrateModelsV5(db);
    migrateModelsV6(db);
    migrateModelsV7(db);
    migrateModelsV8(db);
    migrateModelsV9(db);
    migrateModelsV10(db);
    migrateModelsV11(db);
    migrateModelsV12(db);
    migrateModelsV13(db);
    migrateModelsV14(db);
    migrateModelsV15(db);
    migrateModelsV16(db);
    migrateModelsV17(db);
    migrateModelsV18(db);
    migrateModelsV19(db);
    seedModelCapabilities(db);
    // Must follow seedModelCapabilities — that is where the image rows are seeded.
    flagPaidGoogleModels(db);
    purgeLegacyBazaarlinkDiscoveries(db);
    ensureUnifiedKey(db);
    // Auto-categorize all models on startup
    const { autoCategorizeAllModels } = await import('../services/model-categorizer.js');
    autoCategorizeAllModels();
    // Initialize knowledge base
    const { initKnowledgeBase, seedDefaultKnowledge } = await import('../services/knowledge-base.js');
    initKnowledgeBase(db);
    seedDefaultKnowledge();
    console.log(`Database initialized at ${resolvedPath}`);
    return db;
}
function createTables(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      intelligence_rank INTEGER NOT NULL,
      speed_rank INTEGER NOT NULL,
      size_label TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'general',
      specializations TEXT NOT NULL DEFAULT '',
      rpm_limit INTEGER,
      rpd_limit INTEGER,
      tpm_limit INTEGER,
      tpd_limit INTEGER,
      monthly_token_budget TEXT NOT NULL DEFAULT '',
      context_window INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(platform, model_id)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_checked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fallback_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_db_id INTEGER NOT NULL REFERENCES models(id),
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(model_db_id)
    );

    CREATE TABLE IF NOT EXISTS model_capabilities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_db_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      capability TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(model_db_id, capability)
    );

    CREATE TABLE IF NOT EXISTS model_runtime_health (
      model_db_id INTEGER PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'healthy',
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_error_category TEXT,
      last_error TEXT,
      last_failed_at TEXT,
      last_success_at TEXT,
      blocked_until TEXT
    );

    CREATE TABLE IF NOT EXISTS model_availability (
      model_db_id INTEGER PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_check_at TEXT,
      last_error TEXT,
      next_check_at TEXT,
      discovery_source TEXT,
      free_tier_confirmed INTEGER NOT NULL DEFAULT 0,
      CHECK (status IN ('free', 'rate_limited', 'deprecated', 'error', 'unknown'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_platform ON requests(platform);
    CREATE INDEX IF NOT EXISTS idx_api_keys_platform ON api_keys(platform);
    CREATE INDEX IF NOT EXISTS idx_model_capabilities_capability ON model_capabilities(capability, enabled);
    CREATE INDEX IF NOT EXISTS idx_model_runtime_health_blocked ON model_runtime_health(blocked_until);
  `);
}
function seedModels(db) {
    const count = db.prepare('SELECT COUNT(*) as cnt FROM models').get();
    if (count.cnt > 0)
        return;
    const insert = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    // NOTE: Limits current as of April 2026. See migrateModels() for in-place updates.
    const models = [
        // Google — gemini-2.5-flash free quotas were cut Dec 2025 (now ~20 RPD, budget much lower than before)
        ['google', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 1, 8, 'Frontier', 5, 100, 250000, null, '~12M', 1048576],
        ['google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 4, 5, 'Large', 10, 20, 250000, null, '~3M', 1048576],
        ['google', 'gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 8, 3, 'Medium', 15, 1000, 250000, null, '~120M', 1048576],
        // OpenRouter — upgraded DeepSeek R1 -> V3.1 (stronger reasoning); default RPD ~200
        ['openrouter', 'deepseek/deepseek-v3.1:free', 'DeepSeek V3.1 (free)', 2, 10, 'Frontier', 20, 200, null, null, '~6M', 131072],
        ['openrouter', 'moonshotai/kimi-k2:free', 'Kimi K2 (free)', 2, 9, 'Frontier', 20, 200, null, null, '~6M', 131072],
        ['openrouter', 'qwen/qwen3-coder:free', 'Qwen3 Coder (free)', 3, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
        ['openrouter', 'z-ai/glm-4.5-air:free', 'GLM-4.5 Air (free)', 4, 9, 'Large', 20, 200, null, null, '~6M', 131072],
        // Cerebras — same 30 RPM / 1M TPD free pool; adding frontier coder, Llama 4 Maverick, GPT-OSS
        ['cerebras', 'qwen-3-coder-480b', 'Qwen3-Coder 480B', 2, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
        ['cerebras', 'llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick', 3, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
        ['cerebras', 'qwen3-235b', 'Qwen3 235B', 3, 1, 'Large', 30, null, 60000, 1000000, '~30M', 8192],
        ['cerebras', 'gpt-oss-120b', 'GPT-OSS 120B', 3, 1, 'Large', 30, null, 60000, 1000000, '~30M', 131072],
        // GitHub Models — GPT-4o replaced with GPT-5 (same free tier key)
        ['github', 'openai/gpt-5', 'GPT-5 (GitHub)', 1, 7, 'Frontier', 10, 50, null, null, '~18M', 128000],
        // SambaNova — 70B RPM bumped to 20
        ['sambanova', 'Meta-Llama-3.3-70B-Instruct', 'Llama 3.3 70B', 6, 9, 'Large', 20, null, null, 200000, '~6M', 8192],
        // Mistral — Experiment pool ~1B tokens/mo shared across all models
        ['mistral', 'mistral-large-latest', 'Mistral Large 3', 7, 8, 'Large', 2, null, 500000, null, '~50-100M', 131072],
        ['mistral', 'magistral-medium-latest', 'Magistral Medium', 4, 8, 'Large', 2, null, 500000, null, '~50-100M', 40000],
        ['mistral', 'codestral-latest', 'Codestral', 6, 6, 'Medium', 2, null, 500000, null, '~50-100M', 32000],
        // Groq — scout TPM corrected to 6k (not 30k)
        ['groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', 9, 2, 'Medium', 30, 1000, 6000, 500000, '~15M', 131072],
        ['groq', 'llama-4-scout-17b-16e-instruct', 'Llama 4 Scout', 10, 2, 'Medium', 30, 1000, 6000, 1000000, '~30M', 131072],
        // NVIDIA NIM — moved to credit-based model in 2025; no longer truly recurring monthly. Disabled by default.
        ['nvidia', 'meta/llama-3.1-70b-instruct', 'Llama 3.1 70B (NV)', 11, 6, 'Large', 40, null, null, null, 'credits-based', 131072],
        // Cohere — trial tier is 1000 calls/mo total → realistic budget 1-2M
        ['cohere', 'command-r-plus-08-2024', 'Command R+ (08-2024)', 12, 11, 'Large', 20, 33, null, null, '~1-2M', 131072],
        ['cloudflare', '@cf/meta/llama-3.1-70b-instruct', 'Llama 3.1 70B (CF)', 13, 11, 'Medium', null, null, null, null, '~18-45M', 131072],
        // Hugging Face — free Inference credits are ~$0.10/mo → budget closer to 1-3M on a 70B model
        ['huggingface', 'accounts/fireworks/models/llama-v3p3-70b-instruct', 'Llama 3.3 70B (HF)', 14, 11, 'Medium', null, null, null, null, '~1-3M', 131072],
        // New providers — recurring monthly free tiers, no card required
        ['zhipu', 'glm-4.5-flash', 'GLM-4.5 Flash', 5, 4, 'Large', null, null, null, 1000000, '~30M', 131072],
        ['moonshot', 'kimi-latest', 'Kimi Latest', 4, 8, 'Large', 60, null, null, 500000, '~15M', 200000],
        ['minimax', 'MiniMax-M1', 'MiniMax M1', 5, 8, 'Large', 20, null, 1000000, null, '~30M', 200000],
    ];
    const insertMany = db.transaction(() => {
        for (const m of models) {
            insert.run(...m);
        }
    });
    insertMany();
    // Seed default fallback config from models
    const allModels = db.prepare('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC').all();
    const insertFallback = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
    const insertFallbacks = db.transaction(() => {
        for (let i = 0; i < allModels.length; i++) {
            insertFallback.run(allModels[i].id, i + 1);
        }
    });
    insertFallbacks();
    console.log(`Seeded ${models.length} models and fallback config`);
}
/**
 * Idempotent migration to bring existing DBs up to the April 2026 pool.
 * Covers: replaces outdated models (DeepSeek R1 → V3.1, GPT-4o → GPT-5),
 * corrects stale rate-limits / monthly budgets, adds new smarter models
 * and three new providers (Zhipu, Moonshot, MiniMax).
 */
function migrateModels(db) {
    // 1) Replace outdated models in-place (preserves fallback_config & any references)
    const renames = [
    // platform, oldModelId, newModelId, newDisplayName, intelligenceRank, monthlyBudget, rpdLimit, contextWindow, sizeLabelPriority(unused)
    ];
    const renameStmt = db.prepare(`
    UPDATE models
       SET model_id = ?, display_name = ?, intelligence_rank = ?,
           monthly_token_budget = ?, rpd_limit = COALESCE(?, rpd_limit),
           context_window = COALESCE(?, context_window),
           size_label = COALESCE(?, size_label)
     WHERE platform = ? AND model_id = ?
  `);
    // DeepSeek R1 (free) -> DeepSeek V3.1 (free)
    renameStmt.run('deepseek/deepseek-v3.1:free', 'DeepSeek V3.1 (free)', 2, '~6M', 200, 131072, 'Frontier', 'openrouter', 'deepseek/deepseek-r1:free');
    // GitHub GPT-4o -> GPT-5
    renameStmt.run('openai/gpt-5', 'GPT-5 (GitHub)', 1, '~18M', null, 128000, 'Frontier', 'github', 'gpt-4o');
    // 2) Correct stale limits / budgets on existing rows
    db.prepare(`UPDATE models SET rpd_limit = 20, monthly_token_budget = '~3M' WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'`).run();
    db.prepare(`UPDATE models SET rpm_limit = 20 WHERE platform = 'sambanova' AND model_id = 'Meta-Llama-3.3-70B-Instruct'`).run();
    db.prepare(`UPDATE models SET tpm_limit = 6000 WHERE platform = 'groq' AND model_id = 'llama-4-scout-17b-16e-instruct'`).run();
    db.prepare(`UPDATE models SET monthly_token_budget = '~1-2M' WHERE platform = 'cohere' AND model_id = 'command-r-plus-08-2024'`).run();
    db.prepare(`UPDATE models SET monthly_token_budget = '~1-3M' WHERE platform = 'huggingface' AND model_id = 'accounts/fireworks/models/llama-v3p3-70b-instruct'`).run();
    // NVIDIA moved to credit model — disable and label accordingly
    db.prepare(`UPDATE models SET monthly_token_budget = 'credits-based', enabled = 0 WHERE platform = 'nvidia' AND model_id = 'meta/llama-3.1-70b-instruct'`).run();
    // 3) Insert new models (UNIQUE(platform, model_id) makes this idempotent)
    const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const newModels = [
        // Cerebras — same free pool as qwen3-235b
        ['cerebras', 'qwen-3-coder-480b', 'Qwen3-Coder 480B', 2, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
        ['cerebras', 'llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick', 3, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
        ['cerebras', 'gpt-oss-120b', 'GPT-OSS 120B', 3, 1, 'Large', 30, null, 60000, 1000000, '~30M', 131072],
        // OpenRouter free tier
        ['openrouter', 'deepseek/deepseek-v3.1:free', 'DeepSeek V3.1 (free)', 2, 10, 'Frontier', 20, 200, null, null, '~6M', 131072],
        ['openrouter', 'moonshotai/kimi-k2:free', 'Kimi K2 (free)', 2, 9, 'Frontier', 20, 200, null, null, '~6M', 131072],
        ['openrouter', 'qwen/qwen3-coder:free', 'Qwen3 Coder (free)', 3, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
        ['openrouter', 'z-ai/glm-4.5-air:free', 'GLM-4.5 Air (free)', 4, 9, 'Large', 20, 200, null, null, '~6M', 131072],
        // Mistral Experiment pool — shared ~1B/mo across models
        ['mistral', 'magistral-medium-latest', 'Magistral Medium', 4, 8, 'Large', 2, null, 500000, null, '~50-100M', 40000],
        ['mistral', 'codestral-latest', 'Codestral', 6, 6, 'Medium', 2, null, 500000, null, '~50-100M', 32000],
        // New providers
        ['zhipu', 'glm-4.5-flash', 'GLM-4.5 Flash', 5, 4, 'Large', null, null, null, 1000000, '~30M', 131072],
        ['moonshot', 'kimi-latest', 'Kimi Latest', 4, 8, 'Large', 60, null, null, 500000, '~15M', 200000],
        ['minimax', 'MiniMax-M1', 'MiniMax M1', 5, 8, 'Large', 20, null, 1000000, null, '~30M', 200000],
    ];
    const apply = db.transaction(() => {
        for (const m of newModels)
            insert.run(...m);
        // Ensure every model has a fallback_config row (new inserts + any orphans)
        const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL
      ORDER BY m.intelligence_rank ASC
    `).all();
        if (missing.length > 0) {
            const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get().mx;
            const addFallback = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
            for (let i = 0; i < missing.length; i++) {
                addFallback.run(missing[i].id, maxPriority + i + 1);
            }
        }
    });
    apply();
}
/**
 * Second-pass migration after live-testing every model against its provider.
 * Corrects model IDs verified wrong, removes models not actually available on
 * the current free tier, and adds real :free OpenRouter models found in the
 * live catalog (April 2026).
 */
function migrateModelsV2(db) {
    // Helper: delete a model and its fallback_config entry (FK is RESTRICT-by-default)
    const deleteModel = db.prepare(`DELETE FROM models WHERE platform = ? AND model_id = ?`);
    const deleteFallback = db.prepare(`
    DELETE FROM fallback_config WHERE model_db_id IN (
      SELECT id FROM models WHERE platform = ? AND model_id = ?
    )
  `);
    const removals = [
        // GitHub free tier does NOT include GPT-5 (only catalog-listed). Revert handled below.
        // Cerebras: qwen-3-coder-480b and llama-4-maverick not on free tier; gpt-oss-120b is listed
        // but requires special access — our key gets 404. Remove all three.
        ['cerebras', 'qwen-3-coder-480b'],
        ['cerebras', 'llama-4-maverick-17b-128e-instruct'],
        ['cerebras', 'gpt-oss-120b'],
        // These OpenRouter :free variants do not exist in the live catalog (April 2026)
        ['openrouter', 'deepseek/deepseek-v3.1:free'],
        ['openrouter', 'moonshotai/kimi-k2:free'],
    ];
    const applyRemovals = db.transaction(() => {
        for (const [p, m] of removals) {
            deleteFallback.run(p, m);
            deleteModel.run(p, m);
        }
    });
    applyRemovals();
    // GitHub: gpt-5 is in the model catalog but returns "unavailable_model" on free tier
    // inference. Revert to gpt-4o which works. This only runs if the gpt-5 row exists.
    db.prepare(`
    UPDATE models
       SET model_id = 'gpt-4o', display_name = 'GPT-4o', intelligence_rank = 5,
           size_label = 'Large', context_window = 8000, monthly_token_budget = '~18M'
     WHERE platform = 'github' AND model_id = 'openai/gpt-5'
  `).run();
    // Groq: scout requires the meta-llama/ publisher prefix
    db.prepare(`
    UPDATE models SET model_id = 'meta-llama/llama-4-scout-17b-16e-instruct'
     WHERE platform = 'groq' AND model_id = 'llama-4-scout-17b-16e-instruct'
  `).run();
    // Add real OpenRouter :free models that exist in the live catalog
    const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const additions = [
        // Frontier-tier free models verified in OR catalog 2026-04
        ['openrouter', 'nvidia/nemotron-3-super-120b-a12b:free', 'Nemotron 3 Super 120B (free)', 2, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
        ['openrouter', 'qwen/qwen3-next-80b-a3b-instruct:free', 'Qwen3-Next 80B (free)', 3, 9, 'Large', 20, 200, null, null, '~6M', 262144],
        ['openrouter', 'minimax/minimax-m2.5:free', 'MiniMax M2.5 (free)', 3, 9, 'Large', 20, 200, null, null, '~6M', 196608],
        ['openrouter', 'google/gemma-4-31b-it:free', 'Gemma 4 31B (free)', 5, 9, 'Medium', 20, 200, null, null, '~6M', 262144],
    ];
    const applyAdditions = db.transaction(() => {
        for (const a of additions)
            insert.run(...a);
        // Fallback entries for new models
        const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all();
        if (missing.length > 0) {
            const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get().mx;
            const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
            for (let i = 0; i < missing.length; i++)
                addFb.run(missing[i].id, maxPriority + i + 1);
        }
    });
    applyAdditions();
}
/**
 * Re-rank intelligence based on April 2026 coding + agentic tool-use benchmarks:
 * SWE-bench Verified, Terminal-Bench 2, TAU-Bench, Aider Polyglot.
 * Higher rank = weaker. Ties are allowed (same weights across providers).
 */
function migrateModelsV3Ranks(db) {
    const setRank = db.prepare(`UPDATE models SET intelligence_rank = ? WHERE platform = ? AND model_id = ?`);
    const ranks = [
        // #1-10 frontier coders / agents
        [1, 'openrouter', 'minimax/minimax-m2.5:free'], // SWE-V ~80%, TB2 ~57%
        [2, 'openrouter', 'qwen/qwen3-coder:free'], // SWE-V ~70%
        [3, 'openrouter', 'qwen/qwen3-next-80b-a3b-instruct:free'], // SWE-V ~70.6%
        [4, 'moonshot', 'kimi-latest'], // K2: SWE-V ~71%
        [5, 'cerebras', 'qwen-3-235b-a22b-instruct-2507'], // SWE-V ~65-72%
        [6, 'google', 'gemini-2.5-pro'], // SWE-V 63.8%, Aider 83%
        [7, 'openrouter', 'z-ai/glm-4.5-air:free'], // ~58% SWE-V (distill of 4.5)
        [8, 'openrouter', 'openai/gpt-oss-120b:free'], // SWE-V 62.4%
        [9, 'openrouter', 'nvidia/nemotron-3-super-120b-a12b:free'], // SWE-V 53.7%
        [10, 'minimax', 'MiniMax-M1'], // M1 predecessor, ~45-55%
        // #11-15 mid-tier specialists
        [11, 'mistral', 'codestral-latest'], // HumanEval 86.6%
        [12, 'mistral', 'mistral-large-latest'],
        [13, 'mistral', 'magistral-medium-latest'], // reasoning, not code-tuned
        [14, 'google', 'gemini-2.5-flash'],
        [15, 'zhipu', 'glm-4.5-flash'],
        // #16 Llama 3.3 70B — identical weights across providers (tie)
        [16, 'groq', 'llama-3.3-70b-versatile'],
        [16, 'sambanova', 'Meta-Llama-3.3-70B-Instruct'],
        [16, 'openrouter', 'meta-llama/llama-3.3-70b-instruct:free'],
        [16, 'huggingface', 'accounts/fireworks/models/llama-v3p3-70b-instruct'],
        // #17-23 weaker
        [17, 'openrouter', 'nousresearch/hermes-3-llama-3.1-405b:free'], // L3.1 base with tool-use tune
        [18, 'groq', 'meta-llama/llama-4-scout-17b-16e-instruct'], // multimodal focus
        [19, 'openrouter', 'google/gemma-4-31b-it:free'],
        [20, 'google', 'gemini-2.5-flash-lite'],
        [21, 'github', 'gpt-4o'], // Aug 2024, SWE-V ~33%
        [22, 'nvidia', 'meta/llama-3.1-70b-instruct'], // older Llama 3.1 tune
        [22, 'cloudflare', '@cf/meta/llama-3.1-70b-instruct'], // same base weights
        [23, 'cohere', 'command-r-plus-08-2024'], // RAG-focused, weakest on code
    ];
    const apply = db.transaction(() => {
        for (const [rank, platform, modelId] of ranks) {
            setRank.run(rank, platform, modelId);
        }
    });
    apply();
}
/**
 * V4: Agentic-tool-use focus. Live-probed every candidate against real free-tier
 * keys (April 2026) with a weather-tool function-calling test. Keeps only models
 * that return a structured tool_calls response and are reachable on the free tier.
 *
 * Adds SambaNova DeepSeek/Llama-4/gpt-oss, Groq gpt-oss & qwen3-32b, OpenRouter
 * ling-2.6-flash + nemotron-nano + gpt-oss + trinity, Mistral devstral/medium,
 * GitHub gpt-4.1, Cohere command-a, Cloudflare llama-4/gpt-oss/glm-4.7. Removes
 * moonshot/kimi (paid-only now), minimax/M1 (superseded), HF/Fireworks route
 * (no structured tools), OR/gemma-4 (weak at tools). Renames CF llama-3.1 → 3.3
 * fp8-fast. Corrects stale limits.
 */
function migrateModelsV4(db) {
    // 1) Remove entries that are unavailable or fail agentic tool use
    const deleteModel = db.prepare(`DELETE FROM models WHERE platform = ? AND model_id = ?`);
    const deleteFallback = db.prepare(`
    DELETE FROM fallback_config WHERE model_db_id IN (
      SELECT id FROM models WHERE platform = ? AND model_id = ?
    )
  `);
    const removals = [
        ['moonshot', 'kimi-latest'], // paid-only now ($1 min deposit)
        ['minimax', 'MiniMax-M1'], // superseded; use OR minimax-m2.5:free
        ['openrouter', 'google/gemma-4-31b-it:free'], // weak at tool use
        ['huggingface', 'accounts/fireworks/models/llama-v3p3-70b-instruct'], // emits tool call as text content, not structured
    ];
    const applyRemovals = db.transaction(() => {
        for (const [p, m] of removals) {
            deleteFallback.run(p, m);
            deleteModel.run(p, m);
        }
    });
    applyRemovals();
    // 2) Cloudflare: replace Llama 3.1 70B with the current-gen 3.3 70B fp8-fast
    db.prepare(`
    UPDATE models
       SET model_id = '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
           display_name = 'Llama 3.3 70B fp8-fast (CF)',
           context_window = 131072
     WHERE platform = 'cloudflare' AND model_id = '@cf/meta/llama-3.1-70b-instruct'
  `).run();
    // 3) Field corrections verified via primary sources + live probe
    db.prepare(`UPDATE models SET tpm_limit = 12000 WHERE platform = 'groq' AND model_id = 'llama-3.3-70b-versatile'`).run();
    db.prepare(`UPDATE models SET rpd_limit = 20 WHERE platform = 'sambanova' AND model_id = 'Meta-Llama-3.3-70B-Instruct'`).run();
    db.prepare(`UPDATE models SET rpd_limit = 14400 WHERE platform = 'cerebras' AND model_id = 'qwen-3-235b-a22b-instruct-2507'`).run();
    db.prepare(`UPDATE models SET rpd_limit = 250, monthly_token_budget = '~25M' WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'`).run();
    // gemini-2.5-pro is at-risk: April 2026 Google moved Pro-class off free tier in practice.
    // Our live probe hit "quota exceeded" immediately. Cut rpd in half to reduce 429 blast radius.
    db.prepare(`UPDATE models SET rpd_limit = 50, monthly_token_budget = '~6M' WHERE platform = 'google' AND model_id = 'gemini-2.5-pro'`).run();
    // 4) Add live-probed, tool-capable models
    const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const additions = [
        // OpenRouter :free — shared 20 RPM / 200 RPD / ~6M tokens across :free pool
        ['openrouter', 'inclusionai/ling-2.6-flash:free', 'Ling 2.6 Flash (free)', 7, 9, 'Large', 20, 200, null, null, '~6M', 262144],
        ['openrouter', 'arcee-ai/trinity-large-preview:free', 'Trinity Large Preview (free)', 13, 9, 'Frontier', 20, 200, null, null, '~6M', 131072],
        ['openrouter', 'nvidia/nemotron-3-nano-30b-a3b:free', 'Nemotron 3 Nano 30B (free)', 22, 9, 'Medium', 20, 200, null, null, '~6M', 262144],
        ['openrouter', 'openai/gpt-oss-120b:free', 'GPT-OSS 120B (free)', 6, 9, 'Large', 20, 200, null, null, '~6M', 131072],
        ['openrouter', 'openai/gpt-oss-20b:free', 'GPT-OSS 20B (free)', 18, 9, 'Medium', 20, 200, null, null, '~6M', 131072],
        ['openrouter', 'meta-llama/llama-3.3-70b-instruct:free', 'Llama 3.3 70B (free)', 17, 9, 'Medium', 20, 200, null, null, '~6M', 131072],
        // SambaNova — 20 RPM / 20 RPD / 200K TPD shared free Developer tier
        ['sambanova', 'DeepSeek-V3.1', 'DeepSeek V3.1', 5, 9, 'Frontier', 20, 20, null, 200000, '~3M', 131072],
        ['sambanova', 'DeepSeek-V3.2', 'DeepSeek V3.2', 4, 9, 'Frontier', 20, 20, null, 200000, '~3M', 131072],
        ['sambanova', 'Llama-4-Maverick-17B-128E-Instruct', 'Llama 4 Maverick', 11, 9, 'Large', 20, 20, null, 200000, '~3M', 8192],
        ['sambanova', 'gpt-oss-120b', 'GPT-OSS 120B (SambaNova)', 6, 9, 'Large', 20, 20, null, 200000, '~3M', 131072],
        // Groq — very fast; 30 RPM per model, 1000 RPD on most, 14.4k on the 8B
        ['groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)', 6, 2, 'Large', 30, 1000, 8000, 200000, '~6M', 131072],
        ['groq', 'openai/gpt-oss-20b', 'GPT-OSS 20B (Groq)', 18, 2, 'Medium', 30, 1000, 8000, 200000, '~6M', 131072],
        ['groq', 'qwen/qwen3-32b', 'Qwen3 32B (Groq)', 19, 2, 'Medium', 60, 1000, 6000, 500000, '~15M', 131072],
        ['groq', 'llama-3.1-8b-instant', 'Llama 3.1 8B Instant', 28, 2, 'Small', 30, 14400, 6000, 500000, '~15M', 131072],
        // Mistral Experiment tier — shared 2 RPM / 500k TPM / 1B tokens/mo across all models
        ['mistral', 'devstral-latest', 'Devstral', 16, 8, 'Medium', 2, null, 500000, null, '~50-100M', 131072],
        ['mistral', 'mistral-medium-latest', 'Mistral Medium 3.5', 14, 8, 'Large', 2, null, 500000, null, '~50-100M', 131072],
        // GitHub Models — Low-tier category (15 RPM / 150 RPD, 8K in / 4K out per call)
        ['github', 'openai/gpt-4.1', 'GPT-4.1 (GitHub)', 20, 7, 'Large', 10, 50, null, null, '~9M', 128000],
        // Cohere — shared 1000 calls/mo trial pool, 20 RPM Chat
        ['cohere', 'command-a-03-2025', 'Command-A (03-2025)', 27, 11, 'Large', 20, 33, null, null, '~1-2M', 131072],
        // Cloudflare Workers AI — shared 10K Neurons/day free pool across all @cf/* models
        ['cloudflare', '@cf/openai/gpt-oss-120b', 'GPT-OSS 120B (CF)', 6, 11, 'Large', null, null, null, null, '~18-45M', 131072],
        ['cloudflare', '@cf/zai-org/glm-4.7-flash', 'GLM-4.7 Flash (CF)', 10, 11, 'Large', null, null, null, null, '~18-45M', 131072],
        ['cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout (CF)', 12, 11, 'Large', null, null, null, null, '~18-45M', 131072],
    ];
    const apply = db.transaction(() => {
        for (const a of additions)
            insert.run(...a);
        const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all();
        if (missing.length > 0) {
            const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get().mx;
            const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
            for (let i = 0; i < missing.length; i++)
                addFb.run(missing[i].id, maxPriority + i + 1);
        }
    });
    apply();
    // 5) Re-rank the live catalog by agentic tool-use capability (lower = smarter).
    //    Grounded in April 2026 SWE-Bench Verified + BFCL v3 + Tau-Bench numbers.
    const setRank = db.prepare(`UPDATE models SET intelligence_rank = ? WHERE platform = ? AND model_id = ?`);
    const ranks = [
        [1, 'openrouter', 'minimax/minimax-m2.5:free'],
        [2, 'openrouter', 'qwen/qwen3-coder:free'],
        [3, 'openrouter', 'qwen/qwen3-next-80b-a3b-instruct:free'],
        [4, 'sambanova', 'DeepSeek-V3.2'],
        [5, 'sambanova', 'DeepSeek-V3.1'],
        [6, 'cerebras', 'qwen-3-235b-a22b-instruct-2507'],
        [6, 'openrouter', 'openai/gpt-oss-120b:free'],
        [6, 'groq', 'openai/gpt-oss-120b'],
        [6, 'sambanova', 'gpt-oss-120b'],
        [6, 'cloudflare', '@cf/openai/gpt-oss-120b'],
        [7, 'openrouter', 'inclusionai/ling-2.6-flash:free'],
        [8, 'openrouter', 'z-ai/glm-4.5-air:free'],
        [10, 'cloudflare', '@cf/zai-org/glm-4.7-flash'],
        [11, 'sambanova', 'Llama-4-Maverick-17B-128E-Instruct'],
        [12, 'groq', 'meta-llama/llama-4-scout-17b-16e-instruct'],
        [12, 'cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct'],
        [13, 'openrouter', 'arcee-ai/trinity-large-preview:free'],
        [14, 'google', 'gemini-2.5-pro'],
        [14, 'mistral', 'mistral-large-latest'],
        [14, 'mistral', 'mistral-medium-latest'],
        [16, 'mistral', 'devstral-latest'],
        [16, 'mistral', 'codestral-latest'],
        [17, 'groq', 'llama-3.3-70b-versatile'],
        [17, 'sambanova', 'Meta-Llama-3.3-70B-Instruct'],
        [17, 'cloudflare', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
        [17, 'openrouter', 'meta-llama/llama-3.3-70b-instruct:free'],
        [17, 'nvidia', 'meta/llama-3.1-70b-instruct'],
        [18, 'openrouter', 'openai/gpt-oss-20b:free'],
        [18, 'groq', 'openai/gpt-oss-20b'],
        [19, 'groq', 'qwen/qwen3-32b'],
        [20, 'google', 'gemini-2.5-flash'],
        [20, 'github', 'openai/gpt-4.1'],
        [21, 'mistral', 'magistral-medium-latest'],
        [22, 'openrouter', 'nvidia/nemotron-3-super-120b-a12b:free'],
        [23, 'openrouter', 'nvidia/nemotron-3-nano-30b-a3b:free'],
        [24, 'zhipu', 'glm-4.5-flash'],
        [25, 'github', 'gpt-4o'],
        [26, 'google', 'gemini-2.5-flash-lite'],
        [27, 'cohere', 'command-a-03-2025'],
        [27, 'cohere', 'command-r-plus-08-2024'],
        [28, 'groq', 'llama-3.1-8b-instant'],
    ];
    const applyRanks = db.transaction(() => {
        for (const [r, p, m] of ranks)
            setRank.run(r, p, m);
    });
    applyRanks();
}
/**
 * V5: Google moved all Pro-tier Gemini off the free tier on 2026-04-01 — disable
 * gemini-2.5-pro. Add Cerebras `zai-glm-4.7` (355B z.ai GLM preview, newly on
 * free tier but throttled to 10 RPM / 100 RPD due to high demand; context capped
 * at 8192 on free tier).
 */
function migrateModelsV5(db) {
    db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'google' AND model_id = 'gemini-2.5-pro'`).run();
    const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const apply = db.transaction(() => {
        insert.run('cerebras', 'zai-glm-4.7', 'GLM-4.7 (Cerebras)', 7, 1, 'Frontier', 10, 100, null, null, '~3M', 8192);
        const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all();
        if (missing.length > 0) {
            const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get().mx;
            const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
            for (let i = 0; i < missing.length; i++)
                addFb.run(missing[i].id, maxPriority + i + 1);
        }
    });
    apply();
}
/**
 * V6: Live-probed against real free-tier keys on 2026-04-25.
 *
 * Corrections (Google free-tier RPD): the documented "250" / "1000" RPD numbers
 * for gemini-2.5-flash and gemini-2.5-flash-lite are stale — both share a 20
 * RPD per-model-per-project free pool now. Confirmed by the
 * `generate_content_free_tier_requests` quota error, limit 20.
 *
 * Removals: arcee-ai/trinity-large-preview:free returns 404 "No endpoints found"
 * — pulled from OpenRouter's free pool. (Other previously-suspected dead OR :free
 * IDs are still live in /api/v1/models, so they stay.)
 *
 * Additions (all probe-verified to return 200 with content on the user's keys):
 *   - 3 Cloudflare Workers AI reasoning models
 *   - 3 Google preview models, including Pro (which returned a free-tier 429
 *     against the same 20 RPD pool, confirming free-tier eligibility)
 *   - 2 OpenRouter :free models with no expiration_date
 */
function migrateModelsV6(db) {
    // 1) Remove confirmed-dead OR route
    const deleteModel = db.prepare(`DELETE FROM models WHERE platform = ? AND model_id = ?`);
    const deleteFallback = db.prepare(`
    DELETE FROM fallback_config WHERE model_db_id IN (
      SELECT id FROM models WHERE platform = ? AND model_id = ?
    )
  `);
    const removals = [
        ['openrouter', 'arcee-ai/trinity-large-preview:free'],
    ];
    const applyRemovals = db.transaction(() => {
        for (const [p, m] of removals) {
            deleteFallback.run(p, m);
            deleteModel.run(p, m);
        }
    });
    applyRemovals();
    // 2) Correct stale Google free-tier RPD numbers
    db.prepare(`
    UPDATE models SET rpd_limit = 20, monthly_token_budget = '~3M'
     WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'
  `).run();
    db.prepare(`
    UPDATE models SET rpd_limit = 20, monthly_token_budget = '~3M'
     WHERE platform = 'google' AND model_id = 'gemini-2.5-flash-lite'
  `).run();
    // 3) Add live-probed models
    const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const additions = [
        // Cloudflare Workers AI — 10K Neurons/day shared free pool. Reasoning traces
        // burn output tokens fast, so per-call effective budget is small. Estimates
        // assume 1K-in/500-out typical: kimi-k2.5 ≈ 50/day, qwen3-30b ≈ 200/day,
        // r1-distill ≈ 5/day on the reasoning-heavy path.
        ['cloudflare', '@cf/moonshotai/kimi-k2.5', 'Kimi K2.5 (CF)', 3, 11, 'Frontier', null, null, null, null, '~10-20M', 262144],
        ['cloudflare', '@cf/qwen/qwen3-30b-a3b-fp8', 'Qwen3 30B-A3B fp8 (CF)', 7, 11, 'Large', null, null, null, null, '~18-45M', 131072],
        ['cloudflare', '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', 'DeepSeek R1 Distill Qwen 32B (CF)', 9, 11, 'Large', null, null, null, null, '~3-5M', 131072],
        // Google preview tier — shares the 20 RPD per-model free pool. Pro confirmed
        // free-tier-eligible by the `free_tier_requests` quota metric in 429 errors.
        ['google', 'gemini-3.1-flash-lite-preview', 'Gemini 3.1 Flash-Lite Preview', 18, 3, 'Medium', 15, 20, 250000, null, '~3M', 1048576],
        ['google', 'gemini-3-flash-preview', 'Gemini 3 Flash Preview', 11, 5, 'Large', 10, 20, 250000, null, '~3M', 1048576],
        ['google', 'gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', 1, 8, 'Frontier', 5, 20, 250000, null, '~3M', 1048576],
        // OpenRouter :free pool — 20 RPM / 50 RPD (1000 once $10 credits bought).
        ['openrouter', 'google/gemma-4-31b-it:free', 'Gemma 4 31B (free)', 19, 9, 'Medium', 20, 200, null, null, '~6M', 262144],
        ['openrouter', 'liquid/lfm-2.5-1.2b-instruct:free', 'Liquid LFM 2.5 1.2B (free)', 30, 10, 'Small', 20, 200, null, null, '~6M', 32768],
    ];
    const apply = db.transaction(() => {
        for (const a of additions)
            insert.run(...a);
        const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all();
        if (missing.length > 0) {
            const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get().mx;
            const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
            for (let i = 0; i < missing.length; i++)
                addFb.run(missing[i].id, maxPriority + i + 1);
        }
    });
    apply();
}
/**
 * V7 (April 2026): live-probed delta against OpenRouter's free pool + Z.ai.
 * - Removes inclusionai/ling-2.6-flash:free (transitioned to paid, 404 on chat).
 * - Adds 8 new :free routes confirmed via /v1/models + chat-completion probe.
 * - Adds zhipu/glm-4.7-flash (probe: 429 "overloaded" — free-pool throttle, not
 *   "insufficient balance" which paid models return). Same baseUrl works for both
 *   api.z.ai and open.bigmodel.cn keys.
 * HF and NVIDIA left as-is: HF still serves chat with current key; NVIDIA already disabled.
 */
function migrateModelsV7(db) {
    const deleteModel = db.prepare(`DELETE FROM models WHERE platform = ? AND model_id = ?`);
    const deleteFallback = db.prepare(`
    DELETE FROM fallback_config WHERE model_db_id IN (
      SELECT id FROM models WHERE platform = ? AND model_id = ?
    )
  `);
    const removals = [
        ['openrouter', 'inclusionai/ling-2.6-flash:free'],
    ];
    const applyRemovals = db.transaction(() => {
        for (const [p, m] of removals) {
            deleteFallback.run(p, m);
            deleteModel.run(p, m);
        }
    });
    applyRemovals();
    const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    // OpenRouter :free quotas: 20 RPM / 50 RPD without credits, 1000 RPD with $10 lifetime topup.
    // Catalog convention is rpd=200 (matches existing rows).
    const additions = [
        ['openrouter', 'inclusionai/ling-2.6-1t:free', 'Ling 2.6 1T (free)', 4, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
        ['openrouter', 'tencent/hy3-preview:free', 'Tencent HY3 Preview (free)', 7, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
        ['openrouter', 'poolside/laguna-m.1:free', 'Poolside Laguna M.1 (free)', 13, 9, 'Large', 20, 200, null, null, '~6M', 131072],
        ['openrouter', 'google/gemma-4-26b-a4b-it:free', 'Gemma 4 26B-A4B (free)', 22, 9, 'Medium', 20, 200, null, null, '~6M', 262144],
        ['openrouter', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'Nemotron 3 Nano 30B Reasoning (free)', 23, 9, 'Medium', 20, 200, null, null, '~6M', 262144],
        ['openrouter', 'poolside/laguna-xs.2:free', 'Poolside Laguna XS.2 (free)', 26, 10, 'Medium', 20, 200, null, null, '~6M', 131072],
        ['openrouter', 'nvidia/nemotron-nano-9b-v2:free', 'Nemotron Nano 9B v2 (free)', 28, 10, 'Medium', 20, 200, null, null, '~6M', 128000],
        ['openrouter', 'liquid/lfm-2.5-1.2b-thinking:free', 'Liquid LFM 2.5 1.2B Thinking (free)', 30, 10, 'Small', 20, 200, null, null, '~6M', 32768],
        // Zhipu (Z.ai) — free pool. glm-4.7-flash quotas unpublished; mirror glm-4.5-flash row shape.
        ['zhipu', 'glm-4.7-flash', 'GLM-4.7 Flash', 18, 4, 'Large', null, null, null, 1000000, '~30M', 131072],
    ];
    const apply = db.transaction(() => {
        for (const a of additions)
            insert.run(...a);
        const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all();
        if (missing.length > 0) {
            const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get().mx;
            const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
            for (let i = 0; i < missing.length; i++)
                addFb.run(missing[i].id, maxPriority + i + 1);
        }
    });
    apply();
}
/**
 * V8 (May 2026): 3-day delta. SambaNova's /v1/models added two free-tier models;
 * Cloudflare's @cf catalog added two new text models. All four probe-verified 200
 * with the user's keys. SambaNova's paid-only MiniMax-M2.5 explicitly returns 422
 * "Couldn't find valid service tier", so the 200s on these rows confirm free-tier
 * access. Cloudflare's @cf/* models share the 10K Neurons/day free pool.
 */
function migrateModelsV8(db) {
    const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const additions = [
        // SambaNova free pool: 20 RPM / 20 RPD / 200K TPD shared across all free models.
        ['sambanova', 'DeepSeek-V3.1-cb', 'DeepSeek V3.1 (CB)', 5, 9, 'Frontier', 20, 20, null, 200000, '~3M', 131072],
        ['sambanova', 'gemma-3-12b-it', 'Gemma 3 12B (SambaNova)', 22, 9, 'Medium', 20, 20, null, 200000, '~3M', 131072],
        // Cloudflare @cf — 10K Neurons/day shared pool.
        ['cloudflare', '@cf/moonshotai/kimi-k2.6', 'Kimi K2.6 (CF)', 2, 11, 'Frontier', null, null, null, null, '~10-20M', 262144],
        ['cloudflare', '@cf/ibm-granite/granite-4.0-h-micro', 'Granite 4.0 H Micro (CF)', 29, 11, 'Small', null, null, null, null, '~5-10M', 131072],
    ];
    const apply = db.transaction(() => {
        for (const a of additions)
            insert.run(...a);
        const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all();
        if (missing.length > 0) {
            const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get().mx;
            const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
            for (let i = 0; i < missing.length; i++)
                addFb.run(missing[i].id, maxPriority + i + 1);
        }
    });
    apply();
}
/**
 * V9 (May 2026): disable cerebras/zai-glm-4.7. The model still appears in
 * Cerebras's /v1/models listing but the chat-completions endpoint returns
 * 404 "Model does not exist or you do not have access" for free-tier keys —
 * matches their docs note about temporarily reducing free-tier access on
 * zai-glm-4.7 due to high demand. Row kept (not deleted) so it can be
 * re-enabled later without losing fallback_config history.
 */
function migrateModelsV9(db) {
    db.prepare("UPDATE models SET enabled = 0 WHERE platform = 'cerebras' AND model_id = 'zai-glm-4.7'").run();
}
/**
 * V10 (May 2026): Ollama Cloud — first new platform since Z.ai/Zhipu in V7.
 * Free plan: GPU-time-based quota (not per-token), 1 concurrent model,
 * 5h session caps, no card required. /v1/models lists 39 SKUs but only 28
 * respond on the Free tier — paid models return 403 with an explicit
 * "this model requires a subscription" message.
 *
 * Curated to ~10 representative free models that either (a) aren't reachable
 * elsewhere in the catalog or (b) provide a useful alternate route through
 * Ollama's independent rate-limit pool. Probe-verified May 2 2026.
 *
 * Quota shape: GPU-time, not tokens. monthly_token_budget reflects rough
 * Free-tier "session" capacity rather than a hard token cap.
 */
function migrateModelsV10(db) {
    const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const additions = [
        // Budget strings are estimates: Ollama publishes no token cap (quota is GPU-time +
        // 7-day rolling). Frontier ~5-10M, Large ~10-20M, Medium ~20-30M reflect that
        // heavier models burn quota faster. Numeric limits stay null — real provider
        // throttling is the source of truth, not these display strings.
        ['ollama', 'qwen3-coder:480b', 'Qwen3-Coder 480B (Ollama)', 2, 9, 'Frontier', null, null, null, null, '~5-10M', 262144],
        ['ollama', 'mistral-large-3:675b', 'Mistral Large 3 675B (Ollama)', 3, 9, 'Frontier', null, null, null, null, '~5-10M', 131072],
        ['ollama', 'deepseek-v3.2', 'DeepSeek V3.2 (Ollama)', 4, 9, 'Frontier', null, null, null, null, '~5-10M', 131072],
        ['ollama', 'cogito-2.1:671b', 'Cogito 2.1 671B (Ollama)', 4, 9, 'Frontier', null, null, null, null, '~5-10M', 131072],
        ['ollama', 'kimi-k2-thinking', 'Kimi K2 Thinking (Ollama)', 5, 9, 'Frontier', null, null, null, null, '~5-10M', 131072],
        ['ollama', 'glm-4.7', 'GLM-4.7 (Ollama)', 6, 9, 'Frontier', null, null, null, null, '~5-10M', 131072],
        ['ollama', 'gpt-oss:120b', 'GPT-OSS 120B (Ollama)', 6, 9, 'Large', null, null, null, null, '~10-20M', 131072],
        ['ollama', 'devstral-2:123b', 'Devstral 2 123B (Ollama)', 8, 10, 'Large', null, null, null, null, '~10-20M', 131072],
        ['ollama', 'gpt-oss:20b', 'GPT-OSS 20B (Ollama)', 18, 10, 'Medium', null, null, null, null, '~20-30M', 131072],
        ['ollama', 'gemma4:31b', 'Gemma 4 31B (Ollama)', 22, 10, 'Medium', null, null, null, null, '~20-30M', 131072],
    ];
    const apply = db.transaction(() => {
        for (const a of additions)
            insert.run(...a);
        const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all();
        if (missing.length > 0) {
            const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get().mx;
            const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
            for (let i = 0; i < missing.length; i++)
                addFb.run(missing[i].id, maxPriority + i + 1);
        }
    });
    apply();
}
/**
 * V11 (May 2026):
 * 1. Fix long-standing bug: Cerebras `qwen3-235b` was inserted with the
 *    wrong model_id in the original seed (real id is
 *    `qwen-3-235b-a22b-instruct-2507`). Subsequent rank/limit updates that
 *    target the correct id have been silent no-ops since V0 on fresh deploys.
 * 2. Re-enable NVIDIA NIM — `meta/llama-3.1-70b-instruct` was disabled in V2
 *    when NIM moved to credits. Per May 2026 audit it's free again (~1,000
 *    starter credits never expire, 40 RPM/model).
 * 3. Add three new aggregator/anon-friendly platforms confirmed live May 2026:
 *    Kilo Gateway, Pollinations, LLM7.io — all three accept anonymous
 *    requests on at least one model.
 *    - The user still needs a placeholder key entry (any non-empty string
 *      works) because the router filters on `keys.length === 0` to decide
 *      whether a platform is routable.
 *    Chutes was evaluated and dropped: probe with a free-tier key returned
 *    402 on every model — "Quota exceeded and account balance is $0.0,
 *    please pay with fiat or send tao". The "free" tier requires a paid
 *    balance, which conflicts with the no-card criterion.
 */
function migrateModelsV11(db) {
    // 1) Rename cerebras qwen3-235b → qwen-3-235b-a22b-instruct-2507 if the
    //    old id still exists on this DB. Safe to re-run because of the WHERE.
    db.prepare(`
    UPDATE models SET model_id = 'qwen-3-235b-a22b-instruct-2507'
     WHERE platform = 'cerebras' AND model_id = 'qwen3-235b'
  `).run();
    // 2) Re-enable NVIDIA NIM (still has 1,000+ starter credits free-tier).
    db.prepare(`
    UPDATE models SET enabled = 1, monthly_token_budget = '~3M (1k credits)'
     WHERE platform = 'nvidia' AND model_id = 'meta/llama-3.1-70b-instruct'
  `).run();
    // 3) Add catalog rows for the four new platforms. Numeric limits are
    //    conservative — provider docs publish best-effort bounds that fluctuate.
    const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const additions = [
        // NVIDIA NIM — live-probed May 2026 with a free-tier key. All 8 returned
        // 200 + content. Limits are per-model: 40 RPM, shared 1k starter credits
        // (never-expire) used for the rough budget estimate. The existing
        // meta/llama-3.1-70b-instruct row stays (re-enabled above).
        ['nvidia', 'meta/llama-3.3-70b-instruct', 'Llama 3.3 70B (NV)', 17, 6, 'Large', 40, null, null, null, '~3M (credits)', 131072],
        ['nvidia', 'meta/llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick (NV)', 11, 6, 'Large', 40, null, null, null, '~3M (credits)', 131072],
        ['nvidia', 'deepseek-ai/deepseek-v4-pro', 'DeepSeek V4 Pro (NV)', 3, 9, 'Frontier', 40, null, null, null, '~2M (credits)', 131072],
        ['nvidia', 'mistralai/mistral-large-3-675b-instruct-2512', 'Mistral Large 3 675B (NV)', 3, 9, 'Frontier', 40, null, null, null, '~2M (credits)', 131072],
        ['nvidia', 'minimaxai/minimax-m2.7', 'MiniMax M2.7 (NV)', 3, 9, 'Frontier', 40, null, null, null, '~2M (credits)', 196608],
        ['nvidia', 'nvidia/nemotron-3-super-120b-a12b', 'Nemotron 3 Super 120B (NV)', 22, 9, 'Frontier', 40, null, null, null, '~2M (credits)', 262144],
        ['nvidia', 'nvidia/nemotron-3-nano-30b-a3b', 'Nemotron 3 Nano 30B (NV)', 22, 9, 'Medium', 40, null, null, null, '~3M (credits)', 262144],
        ['nvidia', 'google/gemma-4-31b-it', 'Gemma 4 31B (NV)', 19, 9, 'Medium', 40, null, null, null, '~3M (credits)', 262144],
        ['nvidia', 'moonshotai/kimi-k2.6', 'Kimi K2.6 (NV)', 3, 9, 'Frontier', 40, null, null, null, '~2M (credits)', 131072],
        // Cerebras — live-probed May 2026 with a free-tier key. Both 200 + content.
        // gpt-oss-120b was removed in V2 ("requires special access, 404 on our
        // key") but is reachable on the current free tier — re-add. llama3.1-8b
        // is the fast small-model alternative (no hyphen, distinct from Groq's
        // llama-3.1-8b-instant id). Free-pool limits match qwen-3-235b row.
        ['cerebras', 'gpt-oss-120b', 'GPT-OSS 120B (Cerebras)', 6, 1, 'Large', 30, 1000, 60000, 1000000, '~30M', 131072],
        ['cerebras', 'llama3.1-8b', 'Llama 3.1 8B (Cerebras)', 28, 1, 'Small', 30, 1000, 60000, 1000000, '~30M', 131072],
        // Groq compound — agent system that internally routes through gpt-oss
        // models and exposes the trace in usage metadata. Standard chat-completions
        // shape works (200 + content). Same free-tier limits as other Groq rows.
        ['groq', 'groq/compound', 'Compound (Groq)', 6, 2, 'Large', 30, 1000, 8000, 200000, '~6M', 131072],
        ['groq', 'groq/compound-mini', 'Compound Mini (Groq)', 18, 2, 'Medium', 30, 1000, 8000, 200000, '~6M', 131072],
        // Kilo Gateway — 200 req/hr per IP anon. Most named :free routes have
        // transitioned to paid ("free period ended"); probe-confirmed live:
        ['kilo', 'nvidia/nemotron-3-super-120b-a12b:free', 'Nemotron 3 Super 120B (Kilo)', 22, 9, 'Frontier', null, null, null, null, '~2-3M (200/hr)', 262144],
        // Pollinations — anonymous /openai endpoint. Public model list returns
        // just one anonymous-tier entry. Tool calls supported per their metadata.
        ['pollinations', 'openai-fast', 'GPT-OSS 20B (Pollinations)', 18, 10, 'Medium', null, null, null, null, '~? (anon)', 131072],
        // LLM7.io — 100 req/hr free (anonymous works). Probe-confirmed list:
        ['llm7', 'gpt-oss-20b', 'GPT-OSS 20B (LLM7)', 18, 10, 'Medium', 100, null, null, null, '~2-3M (100/hr)', 131072],
        ['llm7', 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', 'Llama 3.1 8B Turbo (LLM7)', 28, 10, 'Small', 100, null, null, null, '~2-3M (100/hr)', 131072],
        ['llm7', 'codestral-latest', 'Codestral (LLM7)', 16, 8, 'Medium', 100, null, null, null, '~2-3M (100/hr)', 32000],
        ['llm7', 'ministral-8b-2512', 'Ministral 8B (LLM7)', 28, 10, 'Small', 100, null, null, null, '~2-3M (100/hr)', 131072],
        ['llm7', 'GLM-4.6V-Flash', 'GLM-4.6V Flash (LLM7)', 15, 9, 'Large', 100, null, null, null, '~2-3M (100/hr)', 131072],
    ];
    const apply = db.transaction(() => {
        for (const a of additions)
            insert.run(...a);
        const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all();
        if (missing.length > 0) {
            const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get().mx;
            const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
            for (let i = 0; i < missing.length; i++)
                addFb.run(missing[i].id, maxPriority + i + 1);
        }
    });
    apply();
}
function seedModelCapabilities(db) {
    const addCapability = db.prepare(`
    INSERT OR IGNORE INTO model_capabilities (model_db_id, capability, priority, enabled)
    VALUES (?, ?, ?, ?)
  `);
    const chatModels = db.prepare(`
    SELECT id, intelligence_rank, enabled
    FROM models
    WHERE lower(model_id) NOT LIKE '%embedding%'
      AND lower(model_id) NOT LIKE '%embed%'
      AND lower(model_id) NOT LIKE '%image%'
      AND lower(model_id) NOT LIKE '%tts%'
      AND lower(model_id) NOT LIKE '%whisper%'
      AND lower(model_id) NOT LIKE '%live%'
      AND lower(model_id) NOT LIKE '%native-audio%'
  `).all();
    const visionModels = db.prepare(`
    SELECT id, intelligence_rank, enabled
    FROM models
    WHERE platform = 'google'
      AND lower(model_id) LIKE 'gemini-%'
      AND lower(model_id) NOT LIKE '%embedding%'
      AND lower(model_id) NOT LIKE '%embed%'
      AND lower(model_id) NOT LIKE '%image%'
      AND lower(model_id) NOT LIKE '%tts%'
      AND lower(model_id) NOT LIKE '%live%'
      AND lower(model_id) NOT LIKE '%native-audio%'
  `).all();
    const insertCapabilityModel = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
    const getModelId = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?');
    const maxFallbackPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config');
    const addFallback = db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled)
    VALUES (?, ?, 0)
  `);
    const embeddingModels = [
        // OpenRouter exposes /api/v1/embeddings and documents OpenAI embedding
        // models with provider-prefixed IDs.
        ['openrouter', 'openai/text-embedding-3-small', 'Text Embedding 3 Small (OpenRouter)', 90, 4, 'Embedding', null, null, null, null, 'embedding', 8191],
        ['openrouter', 'openai/text-embedding-3-large', 'Text Embedding 3 Large (OpenRouter)', 91, 5, 'Embedding', null, null, null, null, 'embedding', 8191],
        ['openrouter', 'qwen/qwen3-embedding-0.6b', 'Qwen3 Embedding 0.6B (OpenRouter)', 95, 4, 'Embedding', null, null, null, null, 'embedding', 32768],
        // Mistral's /v1/embeddings endpoint supports mistral-embed.
        ['mistral', 'mistral-embed', 'Mistral Embed', 92, 5, 'Embedding', null, null, null, null, 'embedding', 8192],
    ];
    const imageModels = [
        ['google', 'gemini-3.1-flash-image', 'Gemini 3.1 Flash Image', 40, 5, 'Image', null, null, 250000, null, 'image', 1048576],
        ['google', 'gemini-2.5-flash-image', 'Gemini 2.5 Flash Image', 45, 5, 'Image', null, null, 250000, null, 'image', 1048576],
        ['openrouter', 'sourceful/riverflow-v2.5-fast', 'Sourceful Riverflow V2.5 Fast (OpenRouter)', 60, 6, 'Image', null, null, null, null, 'image', 0],
        ['openrouter', 'black-forest-labs/flux.2-klein-4b', 'FLUX.2 Klein 4B (OpenRouter)', 61, 6, 'Image', null, null, null, null, 'image', 0],
        ['openrouter', 'sourceful/riverflow-v2.5-pro', 'Sourceful Riverflow V2.5 Pro (OpenRouter)', 62, 5, 'Image', null, null, null, null, 'image', 0],
    ];
    const openRouterVisionModels = [
        ['openrouter', 'nex-agi/nex-n2-pro:free', 'Nex N2 Pro Vision (free)', 24, 9, 'Vision', 20, 200, null, null, '~6M', 131072],
        ['openrouter', 'google/gemma-4-26b-a4b-it:free', 'Gemma 4 26B Vision (free)', 25, 9, 'Vision', 20, 200, null, null, '~6M', 262144],
        ['openrouter', 'google/gemma-4-31b-it:free', 'Gemma 4 31B Vision (free)', 26, 9, 'Vision', 20, 200, null, null, '~6M', 262144],
        ['openrouter', 'nvidia/nemotron-nano-12b-v2-vl:free', 'Nemotron Nano 12B VL (free)', 27, 9, 'Vision', 20, 200, null, null, '~6M', 131072],
        ['openrouter', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'Nemotron 3 Nano Omni 30B (free)', 28, 9, 'Vision', 20, 200, null, null, '~6M', 262144],
        ['openrouter', 'openrouter/free', 'OpenRouter Free Vision Router', 29, 9, 'Vision', 20, 200, null, null, '~6M', null],
    ];
    const openRouterVideoModels = [
        ['openrouter', 'minimax/minimax-m3', 'MiniMax M3 Video (OpenRouter)', 35, 7, 'Video', null, null, null, null, 'video', 262144],
        ['openrouter', 'stepfun/step-3.7-flash', 'Step 3.7 Flash Video (OpenRouter)', 36, 7, 'Video', null, null, null, null, 'video', 262144],
    ];
    const audioModels = [
        ['google', 'gemini-2.5-flash-preview-tts', 'Gemini 2.5 Flash TTS', 50, 5, 'Audio', 5, 20, 250000, null, 'audio', 8192],
        ['google', 'gemini-3.1-flash-tts-preview', 'Gemini 3.1 Flash TTS Preview', 50, 5, 'Audio', 5, 20, 250000, null, 'audio', 8192],
        ['google', 'gemini-3.1-flash-live-preview', 'Gemini 3.1 Flash Live Preview', 45, 2, 'Realtime Audio', 5, 20, 250000, null, 'audio', 32768],
        ['google', 'gemini-2.5-flash-native-audio-preview-12-2025', 'Gemini 2.5 Flash Native Audio Preview', 45, 2, 'Realtime Audio', 5, 20, 250000, null, 'audio', 32768],
        ['groq', 'canopylabs/orpheus-v1-english', 'Orpheus TTS English (Groq)', 50, 2, 'Speech', null, null, null, null, 'audio', 0],
        ['groq', 'canopylabs/orpheus-arabic-saudi', 'Orpheus TTS Arabic Saudi (Groq)', 51, 2, 'Speech', null, null, null, null, 'audio', 0],
        ['groq', 'whisper-large-v3-turbo', 'Whisper Large V3 Turbo (Groq)', 51, 4, 'Audio', null, null, null, null, 'audio', 0],
        ['groq', 'whisper-large-v3', 'Whisper Large V3 (Groq)', 52, 5, 'Audio', null, null, null, null, 'audio', 0],
    ];
    const audioRouteCapabilities = [
        ['google', 'gemini-2.5-flash-preview-tts', 'speech', 1],
        ['google', 'gemini-3.1-flash-tts-preview', 'speech', 1],
        ['groq', 'canopylabs/orpheus-v1-english', 'speech', 2],
        ['groq', 'canopylabs/orpheus-arabic-saudi', 'speech', 3],
        ['google', 'gemini-2.5-flash-native-audio-preview-12-2025', 'realtime_audio', 1],
        ['google', 'gemini-3.1-flash-live-preview', 'realtime_audio', 2],
        ['groq', 'whisper-large-v3-turbo', 'transcription', 1],
        ['google', 'gemini-2.5-flash', 'transcription', 2],
        ['groq', 'whisper-large-v3-turbo', 'translation', 1],
        ['groq', 'whisper-large-v3', 'transcription', 2],
        ['groq', 'whisper-large-v3', 'translation', 2],
    ];
    const apply = db.transaction(() => {
        const updateCapabilityPriority = db.prepare(`
      UPDATE model_capabilities
         SET priority = ?, enabled = ?
       WHERE model_db_id = ? AND capability = ?
    `);
        const disableLegacyGoogleImagePreview = db.prepare(`
      UPDATE models
         SET enabled = 0
       WHERE platform = 'google' AND model_id = 'gemini-3.1-flash-image-preview'
    `);
        const disableLegacyGoogleImagePreviewCapabilities = db.prepare(`
      UPDATE model_capabilities
         SET enabled = 0
       WHERE model_db_id IN (
         SELECT id FROM models
          WHERE platform = 'google' AND model_id = 'gemini-3.1-flash-image-preview'
       )
    `);
        const disableImageOnlyOpenRouterChatCapabilities = db.prepare(`
      UPDATE model_capabilities
         SET enabled = 0
       WHERE capability = 'chat'
         AND model_db_id IN (
           SELECT id FROM models
            WHERE platform = 'openrouter'
              AND model_id IN (
                'sourceful/riverflow-v2.5-fast',
                'black-forest-labs/flux.2-klein-4b',
                'sourceful/riverflow-v2.5-pro'
              )
         )
    `);
        const clearStaleOpenRouterImageModalityBlocks = db.prepare(`
      DELETE FROM model_runtime_health
       WHERE last_error_category = 'model_unavailable'
         AND last_error LIKE '%requested output modalities: image, text%'
         AND model_db_id IN (
           SELECT id FROM models
            WHERE platform = 'openrouter'
              AND model_id IN (
                'sourceful/riverflow-v2.5-fast',
                'black-forest-labs/flux.2-klein-4b',
                'sourceful/riverflow-v2.5-pro'
              )
         )
    `);
        for (const model of chatModels) {
            addCapability.run(model.id, 'chat', model.intelligence_rank, model.enabled);
        }
        for (const model of visionModels) {
            addCapability.run(model.id, 'vision', model.intelligence_rank, model.enabled);
            addCapability.run(model.id, 'video', model.intelligence_rank, model.enabled);
        }
        const fallbackBase = maxFallbackPriority.get().mx;
        for (let i = 0; i < embeddingModels.length; i++) {
            const model = embeddingModels[i];
            insertCapabilityModel.run(...model);
            const row = getModelId.get(model[0], model[1]);
            if (row) {
                addCapability.run(row.id, 'embeddings', i + 1, 1);
                addFallback.run(row.id, fallbackBase + i + 1);
            }
        }
        for (let i = 0; i < imageModels.length; i++) {
            const model = imageModels[i];
            insertCapabilityModel.run(...model);
            const row = getModelId.get(model[0], model[1]);
            if (row) {
                addCapability.run(row.id, 'images', i + 1, 1);
                addCapability.run(row.id, 'image_generation', i + 1, 1);
                addCapability.run(row.id, 'image_edit', i + 1, 1);
                addCapability.run(row.id, 'image_variation', i + 1, 1);
                addFallback.run(row.id, fallbackBase + embeddingModels.length + i + 1);
            }
        }
        for (let i = 0; i < openRouterVisionModels.length; i++) {
            const model = openRouterVisionModels[i];
            insertCapabilityModel.run(...model);
            const row = getModelId.get(model[0], model[1]);
            if (row) {
                addCapability.run(row.id, 'chat', model[3], 1);
                addCapability.run(row.id, 'vision', i + 1, 1);
                addFallback.run(row.id, fallbackBase + embeddingModels.length + imageModels.length + i + 1);
            }
        }
        for (let i = 0; i < openRouterVideoModels.length; i++) {
            const model = openRouterVideoModels[i];
            insertCapabilityModel.run(...model);
            const row = getModelId.get(model[0], model[1]);
            if (row) {
                addCapability.run(row.id, 'chat', model[3], 1);
                addCapability.run(row.id, 'video', i + 1, 1);
                addFallback.run(row.id, fallbackBase + embeddingModels.length + imageModels.length + openRouterVisionModels.length + i + 1);
            }
        }
        for (let i = 0; i < audioModels.length; i++) {
            const model = audioModels[i];
            insertCapabilityModel.run(...model);
            const row = getModelId.get(model[0], model[1]);
            if (row) {
                addCapability.run(row.id, 'audio', i + 1, 1);
                addFallback.run(row.id, fallbackBase + embeddingModels.length + imageModels.length + openRouterVisionModels.length + openRouterVideoModels.length + i + 1);
            }
        }
        for (const [platform, modelId, capability, priority] of audioRouteCapabilities) {
            const row = getModelId.get(platform, modelId);
            if (row) {
                addCapability.run(row.id, capability, priority, 1);
                updateCapabilityPriority.run(priority, 1, row.id, capability);
            }
        }
        disableLegacyGoogleImagePreview.run();
        disableLegacyGoogleImagePreviewCapabilities.run();
        disableImageOnlyOpenRouterChatCapabilities.run();
        clearStaleOpenRouterImageModalityBlocks.run();
    });
    apply();
}
/**
 * V12 (June 2026): LLM-Hub Pro Max upgrade.
 * Add category and specializations columns for intelligent model routing.
 */
function migrateModelsV12(db) {
    // Check if category column already exists (SQLite doesn't have ADD COLUMN IF NOT EXISTS)
    const hasCategory = db.prepare(`
    SELECT 1 FROM pragma_table_info('models') WHERE name = 'category'
  `).get();
    if (!hasCategory) {
        db.prepare(`ALTER TABLE models ADD COLUMN category TEXT NOT NULL DEFAULT 'general'`).run();
        db.prepare(`ALTER TABLE models ADD COLUMN specializations TEXT NOT NULL DEFAULT ''`).run();
        console.log('[Migration V12] Added category and specializations columns to models table');
    }
}
/**
 * V13 (June 2026): add additional free/credit-limited provider candidates.
 *
 * These platforms are OpenAI-compatible and have either recurring free credits,
 * free API-inference quotas, or rate-limited free models. Some catalogs are
 * intentionally sparse here because the provider's /models endpoint is the
 * source of truth and may change faster than this local seed.
 */
function migrateModelsV13(db) {
    const insert = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
    const starterModels = [
        ['huggingface', 'openai/gpt-oss-120b:fireworks-ai', 'GPT-OSS 120B (HF Fireworks)', 24, 8, 'Large', null, null, null, null, 'monthly credits', 131072],
        ['huggingface', 'deepseek-ai/DeepSeek-R1:fastest', 'DeepSeek R1 (HF fastest)', 25, 9, 'Large', null, null, null, null, 'monthly credits', 131072],
        ['vercel', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Vercel Gateway)', 26, 8, 'Large', null, null, null, null, '$5/mo credits', 131072],
        ['modelscope', 'Qwen/Qwen3.5-35B-A3B', 'Qwen3.5 35B A3B (ModelScope)', 27, 8, 'Large', null, 20, null, null, 'free API inference', 131072],
        ['qwen', 'qwen-plus', 'Qwen Plus', 28, 7, 'Large', null, null, null, null, '90-day free quota', 131072],
        ['qwen', 'qwen-flash', 'Qwen Flash', 29, 5, 'Medium', null, null, null, null, '90-day free quota', 1048576],
        ['siliconflow', 'Qwen/Qwen3.5-35B-A3B', 'Qwen3.5 35B A3B (SiliconFlow)', 30, 7, 'Large', null, null, null, null, 'free model limits', 131072],
        ['siliconflow', 'deepseek-ai/DeepSeek-OCR', 'DeepSeek OCR (SiliconFlow)', 31, 7, 'Medium', null, null, null, null, 'free model limits', 32768],
        ['ovhcloud', 'gpt-oss-20b', 'GPT-OSS 20B (OVHcloud)', 32, 6, 'Medium', 400, null, null, null, 'sandbox/free testing', 131072],
        ['ovhcloud', 'Mistral-Nemo-Instruct-2407', 'Mistral Nemo (OVHcloud)', 33, 6, 'Medium', 400, null, null, null, 'sandbox/free testing', 128000],
    ];
    const addFallback = db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled)
    VALUES (?, ?, 1)
  `);
    const getModel = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?');
    const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get().mx;
    let priority = maxPriority + 1;
    const apply = db.transaction(() => {
        for (const model of starterModels) {
            insert.run(...model);
            const row = getModel.get(model[0], model[1]);
            if (row)
                addFallback.run(row.id, priority++);
        }
    });
    apply();
}
/**
 * V14 (June 2026): refresh Google Gemini free-tier catalog from the current
 * Gemini Developer API pricing/model docs.
 *
 * Google's public /models endpoint does not expose free-tier flags, so keep
 * paid-only media and Pro-preview rows out of default chat routing. The model
 * scout still probes availability after startup and marks each row free,
 * rate-limited, deprecated, or error based on the configured API key.
 */
function migrateModelsV14(db) {
    const insert = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const currentGoogleFreeModels = [
        ['google', 'gemini-3.5-flash', 'Gemini 3.5 Flash', 1, 5, 'Frontier', 10, 20, 250000, null, '~3M', 1048576, 1],
        ['google', 'gemini-3-flash-preview', 'Gemini 3 Flash Preview', 2, 5, 'Frontier', 10, 20, 250000, null, '~3M', 1048576, 1],
        ['google', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 3, 8, 'Frontier', 5, 20, 250000, null, '~3M', 1048576, 1],
        ['google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 4, 5, 'Large', 10, 20, 250000, null, '~3M', 1048576, 1],
        ['google', 'gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', 8, 3, 'Medium', 15, 20, 250000, null, '~3M', 1048576, 1],
        ['google', 'gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 9, 3, 'Medium', 15, 20, 250000, null, '~3M', 1048576, 1],
        ['google', 'gemini-3.1-flash-live-preview', 'Gemini 3.1 Flash Live Preview', 46, 2, 'Realtime Audio', 5, 20, 250000, null, 'audio', 32768, 1],
        ['google', 'gemini-3.1-flash-tts-preview', 'Gemini 3.1 Flash TTS Preview', 50, 5, 'Audio', 5, 20, 250000, null, 'audio', 8192, 1],
        ['google', 'gemini-2.5-flash-preview-tts', 'Gemini 2.5 Flash TTS', 51, 5, 'Audio', 5, 20, 250000, null, 'audio', 8192, 1],
        ['google', 'gemini-2.5-flash-native-audio-preview-12-2025', 'Gemini 2.5 Flash Native Audio Preview', 45, 2, 'Realtime Audio', 5, 20, 250000, null, 'audio', 32768, 1],
    ];
    const upsertMetadata = db.prepare(`
    UPDATE models
       SET display_name = ?,
           intelligence_rank = ?,
           speed_rank = ?,
           size_label = ?,
           rpm_limit = ?,
           rpd_limit = ?,
           tpm_limit = ?,
           tpd_limit = ?,
           monthly_token_budget = ?,
           context_window = ?,
           enabled = ?
     WHERE platform = ? AND model_id = ?
  `);
    const disablePaidOrSuperseded = db.prepare(`
    UPDATE models
       SET enabled = 0
     WHERE platform = 'google'
       AND model_id IN (
         'gemini-3.1-pro-preview',
         'gemini-3.1-pro-preview-customtools',
         'gemini-3.1-flash-lite-preview'
       )
  `);
    const addFallback = db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled)
    VALUES (?, ?, ?)
  `);
    const syncFallbackEnabled = db.prepare(`
    UPDATE fallback_config
       SET enabled = (SELECT enabled FROM models WHERE models.id = fallback_config.model_db_id)
     WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'google')
  `);
    const getModel = db.prepare('SELECT id, enabled FROM models WHERE platform = ? AND model_id = ?');
    const apply = db.transaction(() => {
        for (const model of currentGoogleFreeModels) {
            insert.run(...model);
            upsertMetadata.run(model[2], model[3], model[4], model[5], model[6], model[7], model[8], model[9], model[10], model[11], model[12], model[0], model[1]);
        }
        disablePaidOrSuperseded.run();
        const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get().mx;
        let priority = maxPriority + 1;
        for (const model of currentGoogleFreeModels) {
            const row = getModel.get(model[0], model[1]);
            if (row)
                addFallback.run(row.id, priority++, row.enabled);
        }
        syncFallbackEnabled.run();
    });
    apply();
}
/**
 * V15 (July 2026):
 * Add BazaarLink — OpenAI-compatible aggregator at https://bazaarlink.ai/api/v1.
 * Keys start with sk-bl-; `auto:free` routes to zero-cost inference (4M
 * tokens/day per account), every other catalog row bills the key's credit.
 * All 13 rows live-probed 2026-07-20 against /api/v1/models: bare ids are
 * canonical (`provider/model` aliases also resolve), context windows are the
 * values the catalog reported. Rate-limit columns stay null — BazaarLink does
 * not publish numeric RPM/TPM bounds.
 */
function migrateModelsV15(db) {
    const insert = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const bazaarlinkModels = [
        ['bazaarlink', 'auto:free', 'Auto Free (BZL)', 12, 7, 'Large', null, null, null, null, '4M/day free', null, 1],
        ['bazaarlink', 'claude-opus-4.7', 'Claude Opus 4.7 (BZL)', 1, 9, 'Frontier', null, null, null, null, 'per-key credit', 1000000, 1],
        ['bazaarlink', 'gpt-5.5', 'GPT-5.5 (BZL)', 1, 8, 'Frontier', null, null, null, null, 'per-key credit', 1050000, 1],
        ['bazaarlink', 'claude-sonnet-4.6', 'Claude Sonnet 4.6 (BZL)', 2, 7, 'Frontier', null, null, null, null, 'per-key credit', 1000000, 1],
        ['bazaarlink', 'gemini-3-flash-preview', 'Gemini 3 Flash (BZL)', 2, 5, 'Frontier', null, null, null, null, 'per-key credit', 1048576, 1],
        ['bazaarlink', 'gpt-5.4', 'GPT-5.4 (BZL)', 3, 7, 'Frontier', null, null, null, null, 'per-key credit', 1050000, 1],
        ['bazaarlink', 'kimi-k2.6', 'Kimi K2.6 (BZL)', 3, 8, 'Frontier', null, null, null, null, 'per-key credit', 262144, 1],
        ['bazaarlink', 'minimax-m3', 'MiniMax M3 (BZL)', 3, 8, 'Frontier', null, null, null, null, 'per-key credit', 1048576, 1],
        ['bazaarlink', 'glm-5.1', 'GLM 5.1 (BZL)', 4, 7, 'Frontier', null, null, null, null, 'per-key credit', 202752, 1],
        ['bazaarlink', 'deepseek-v3.2', 'DeepSeek V3.2 (BZL)', 5, 7, 'Large', null, null, null, null, 'per-key credit', 163840, 1],
        ['bazaarlink', 'qwen3.6-plus', 'Qwen 3.6 Plus (BZL)', 6, 7, 'Large', null, null, null, null, 'per-key credit', 1000000, 1],
        ['bazaarlink', 'gpt-5.4-mini', 'GPT-5.4 Mini (BZL)', 8, 5, 'Medium', null, null, null, null, 'per-key credit', 400000, 1],
        ['bazaarlink', 'claude-haiku-4.5', 'Claude Haiku 4.5 (BZL)', 10, 4, 'Medium', null, null, null, null, 'per-key credit', 200000, 1],
    ];
    const addFallback = db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled)
    VALUES (?, ?, ?)
  `);
    const getModel = db.prepare('SELECT id, enabled FROM models WHERE platform = ? AND model_id = ?');
    const apply = db.transaction(() => {
        for (const model of bazaarlinkModels)
            insert.run(...model);
        const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get().mx;
        let priority = maxPriority + 1;
        for (const model of bazaarlinkModels) {
            const row = getModel.get(model[0], model[1]);
            if (row)
                addFallback.run(row.id, priority++, row.enabled);
        }
    });
    apply();
}
/**
 * V16 (July 2026): free-tier enforcement groundwork.
 * Adds models.is_free (1 = free-tier, 0 = bills key credit) and flags the 12
 * paid BazaarLink rows seeded by V15. `auto:free` and
 * `deepseek/deepseek-v4-flash:free` stay free. Idempotent: the ALTER is
 * guarded by PRAGMA table_info and the UPDATE re-applies harmlessly.
 */
function migrateModelsV16(db) {
    const cols = db.prepare('PRAGMA table_info(models)').all();
    if (!cols.some(c => c.name === 'is_free')) {
        db.prepare('ALTER TABLE models ADD COLUMN is_free INTEGER NOT NULL DEFAULT 1').run();
    }
    const paidBazaarlink = [
        'claude-opus-4.7', 'gpt-5.5', 'claude-sonnet-4.6', 'gemini-3-flash-preview',
        'gpt-5.4', 'kimi-k2.6', 'minimax-m3', 'glm-5.1', 'deepseek-v3.2',
        'qwen3.6-plus', 'gpt-5.4-mini', 'claude-haiku-4.5',
    ];
    const flag = db.prepare("UPDATE models SET is_free = 0 WHERE platform = 'bazaarlink' AND model_id = ?");
    const tx = db.transaction(() => {
        for (const id of paidBazaarlink)
            flag.run(id);
    });
    tx();
}
/**
 * V17 (July 2026): Google catalog refresh.
 *
 * Verified 2026-07-22 against ai.google.dev/gemini-api/docs/pricing (the
 * "Free Tier" column reads "Free of charge" vs "Not available") and a live
 * generateContent probe with a real key:
 *
 * 1. New free-tier models the hardcoded scout allowlist could never discover:
 *    gemini-3.6-flash (newest stable Flash), gemini-3.5-flash-lite, and the
 *    Gemma 4 pair. All four answered a live probe. Gemma is ranked below the
 *    Gemini models because it emits verbose/thinking-style output, so
 *    auto-routing prefers the cleaner Gemini rows first.
 * 2. Image-generation models are NOT free ("Not available" on the free tier)
 *    but were seeded enabled with the is_free default of 1, so free-only mode
 *    would have happily routed paid image traffic. Flag them paid.
 *
 * Rate limits mirror the V14 free-tier estimates (Google publishes per-model
 * RPM only in the AI Studio widget). Gemma context windows are conservative.
 */
function migrateModelsV17(db) {
    const insert = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, is_free
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const newFreeModels = [
        ['google', 'gemini-3.6-flash', 'Gemini 3.6 Flash', 1, 5, 'Frontier', 10, 20, 250000, null, '~3M', 1048576, 1, 1],
        ['google', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 7, 3, 'Medium', 15, 20, 250000, null, '~3M', 1048576, 1, 1],
        // Gemma 4 (gemma-4-31b-it / gemma-4-26b-a4b-it) is also free on the Gemini
        // API and answers a live probe, but it is deliberately NOT seeded here:
        // BazaarLink's scout already auto-discovered rows with the same model_id
        // (disabled), and resolveRoutableModel matches on model_id without a
        // platform filter, so the disabled row wins and the model is unreachable.
        // Add Gemma once that cross-provider id collision is fixed.
    ];
    const addFallback = db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled)
    VALUES (?, ?, ?)
  `);
    const getModel = db.prepare('SELECT id, enabled FROM models WHERE platform = ? AND model_id = ?');
    const apply = db.transaction(() => {
        for (const model of newFreeModels)
            insert.run(...model);
        const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get().mx;
        let priority = maxPriority + 1;
        for (const model of newFreeModels) {
            const row = getModel.get(model[0], model[1]);
            if (row)
                addFallback.run(row.id, priority++, row.enabled);
        }
    });
    apply();
}
/**
 * One-time cleanup: remove the BazaarLink rows imported before the scout's
 * chat filter existed.
 *
 * On 2026-07-20 the scout pulled BazaarLink's entire ~260-model catalog in
 * batches of MAX_DISCOVERED_PER_PLATFORM, including ~245 text-to-image and
 * text-to-video models (wan2.1-t2i, happyhorse, Z-Image-Turbo) and paid chat
 * models that can never serve /v1/chat/completions. They landed disabled — so
 * nothing could route to them — but they clutter the catalog and inflate the
 * "unknown / never scanned" counters on Model Status.
 *
 * isBazaarlinkFreeChatEntry now rejects all of them at discovery (verified
 * against the live catalog: 2 of 260 pass), so this only clears the historical
 * residue. Scoped deliberately narrowly:
 *   - platform bazaarlink only (other providers import catalogs by design)
 *   - disabled only (never touch something in use)
 *   - auto-discovered only (seeded/curated rows have no discovery_source)
 *   - discovered before the cutoff, so a later legitimate discovery that an
 *     operator chooses to disable is never swept up
 *
 * fallback_config is ON DELETE NO ACTION and must be cleared first;
 * model_availability / model_capabilities / model_runtime_health cascade.
 */
export function purgeLegacyBazaarlinkDiscoveries(db) {
    const PRE_FILTER_CUTOFF = 'model-scout:2026-07-21';
    const targets = db.prepare(`
    SELECT m.id
      FROM models m
      JOIN model_availability ma ON ma.model_db_id = m.id
     WHERE m.platform = 'bazaarlink'
       AND m.enabled = 0
       AND ma.discovery_source IS NOT NULL
       AND ma.discovery_source < ?
  `).all(PRE_FILTER_CUTOFF).map(r => r.id);
    if (targets.length === 0)
        return;
    const deleteFallback = db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?');
    const deleteModel = db.prepare('DELETE FROM models WHERE id = ?');
    const apply = db.transaction(() => {
        for (const id of targets) {
            deleteFallback.run(id);
            deleteModel.run(id);
        }
    });
    apply();
    console.log(`[Cleanup] Removed ${targets.length} legacy BazaarLink rows imported before the chat filter existed.`);
}
/**
 * V18 (July 2026): retire the Google Gemma rows.
 *
 * Gemma 4 is free on the Gemini API and — now that the cross-provider model_id
 * collision in resolveRoutableModel is fixed — genuinely reachable. It is still
 * disabled by default because it answers by emitting raw chain-of-thought
 * ("The user said 'say ok'. The user wants me to output...") rather than the
 * answer, which is poor behaviour for a model sitting in the auto-route
 * fallback chain. Operators can enable it from the dashboard.
 *
 * Rows are disabled, never deleted. A fresh install never seeds them, so this
 * only affects databases that briefly had them enabled.
 */
function migrateModelsV18(db) {
    const disable = db.prepare("UPDATE models SET enabled = 0 WHERE platform = 'google' AND model_id IN ('gemma-4-31b-it', 'gemma-4-26b-a4b-it')");
    disable.run();
}
/**
 * V19 (July 2026): retire the Ollama Cloud rows the upstream deleted.
 *
 * Ollama Cloud answers `410 Gone` for qwen3-coder:480b — the hosted model was
 * removed outright (live-verified 2026-07-22). With intelligence_rank 2 the
 * row sat at the top of the auto-route chain, so before the 410 classifier
 * fix every `model: "auto"` request died on it with a 502. Disabled, never
 * deleted, per V18 precedent; a future migration can re-enable it if Ollama
 * brings the model back.
 */
function migrateModelsV19(db) {
    db.prepare("UPDATE models SET enabled = 0 WHERE platform = 'ollama' AND model_id = 'qwen3-coder:480b'").run();
}
/**
 * Mark Google models that have no free tier (verified 2026-07-22 against
 * ai.google.dev pricing — image generation reads "Not available" in the Free
 * Tier column). Runs AFTER seedModelCapabilities because that function is what
 * seeds the image/audio rows; flagging earlier would silently no-op.
 * Idempotent.
 */
function flagPaidGoogleModels(db) {
    const markPaid = db.prepare("UPDATE models SET is_free = 0 WHERE platform = 'google' AND model_id = ?");
    const paidGoogleModels = [
        'gemini-2.5-flash-image',
        'gemini-3.1-flash-image',
        'gemini-3.1-flash-image-preview',
        'gemini-3.1-pro-preview',
    ];
    const apply = db.transaction(() => {
        for (const modelId of paidGoogleModels)
            markPaid.run(modelId);
    });
    apply();
}
function ensureUnifiedKey(db) {
    const existing = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get();
    if (!existing) {
        const key = `llmhub-${crypto.randomBytes(24).toString('hex')}`;
        db.prepare("INSERT INTO settings (key, value) VALUES ('unified_api_key', ?)").run(key);
        console.log(`\n  Your unified API key: ${key}\n`);
    }
}
export function getUnifiedApiKey() {
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get();
    return row.value;
}
export function regenerateUnifiedKey() {
    const db = getDb();
    const key = `llmhub-${crypto.randomBytes(24).toString('hex')}`;
    db.prepare("UPDATE settings SET value = ? WHERE key = 'unified_api_key'").run(key);
    return key;
}
//# sourceMappingURL=index.js.map
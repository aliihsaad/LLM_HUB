import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeCapabilityRequest, routeRequest } from '../../services/router.js';

describe('Router', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    // Reset fallback order to intelligence ranking
    const models = db.prepare('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC').all() as any[];
    const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].id);
    }
  });

  it('should throw when no keys are configured', () => {
    expect(() => routeRequest()).toThrow(/exhausted/i);
  });

  it('should route to highest priority model with available key', () => {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', encrypted, iv, authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
    expect(result.apiKey).toBe('test-groq-key');
  });

  it('should prefer higher-priority model when keys exist for multiple platforms', () => {
    const db = getDb();

    const googleKey = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'test', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 1);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    // Post-V6: Google's gemini-3.1-pro-preview (rank 1, free-tier-eligible per
    // probe on 2026-04-25) outranks Groq's best free-tier model openai/gpt-oss-120b
    // (rank 6). With keys for both platforms, Google wins.
    const result = routeRequest();
    expect(result.platform).toBe('google');
  });

  it('should skip disabled keys', () => {
    const db = getDb();

    const googleKey = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'disabled', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 0);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
  });

  it('should honor explicit platform filter when routing', () => {
    const db = getDb();
    const googleKey = encrypt('google-filter-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'google-filter', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 1);

    const groqKey = encrypt('groq-filter-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'groq-filter', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    expect(routeRequest(undefined, undefined, undefined, undefined, undefined, 'google').platform).toBe('google');
    expect(routeRequest(undefined, undefined, undefined, undefined, undefined, 'groq').platform).toBe('groq');
  });

  it('should skip invalid keys', () => {
    const db = getDb();

    const invalidKey = encrypt('invalid-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'invalid', invalidKey.encrypted, invalidKey.iv, invalidKey.authTag, 'invalid', 1);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
  });

  it('should route embeddings to an embedding-capable model with an available key', () => {
    const db = getDb();
    const key = encrypt('test-openrouter-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('openrouter', 'test', key.encrypted, key.iv, key.authTag, 'healthy', 1);

    const result = routeCapabilityRequest('embeddings');
    expect(result.platform).toBe('openrouter');
    expect(result.modelId).toMatch(/embedding/i);
    expect(result.apiKey).toBe('test-openrouter-key');
  });

  it('should not route embeddings to chat-only models', () => {
    const db = getDb();
    const key = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', key.encrypted, key.iv, key.authTag, 'healthy', 1);

    expect(() => routeCapabilityRequest('embeddings')).toThrow(/embeddings|exhausted/i);
  });

  it('should skip chat models whose context window is smaller than the request', () => {
    const db = getDb();
    const key = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'context-test', key.encrypted, key.iv, key.authTag, 'healthy', 1);

    db.prepare('UPDATE fallback_config SET enabled = 0').run();
    const insertModel = db.prepare(`
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank,
        speed_rank, size_label, context_window, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const small = insertModel.run(
      'groq', 'test-small-context', 'Test Small Context', 1, 1, 'Small', 32768,
    );
    const large = insertModel.run(
      'groq', 'test-large-context', 'Test Large Context', 2, 1, 'Large', 131072,
    );
    const addFallback = db.prepare(
      'INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)',
    );
    addFallback.run(Number(small.lastInsertRowid), 1);
    addFallback.run(Number(large.lastInsertRowid), 2);

    expect(routeRequest(81_000).modelId).toBe('test-large-context');
  });

  it('should use SambaNova DeepSeek V3.2 provider-enforced context window', () => {
    const row = getDb().prepare(`
      SELECT context_window
      FROM models
      WHERE platform = 'sambanova' AND model_id = 'DeepSeek-V3.2'
    `).get() as { context_window: number };

    expect(row.context_window).toBe(32768);
  });
});

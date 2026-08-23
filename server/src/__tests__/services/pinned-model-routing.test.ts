import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest } from '../../services/router.js';

/**
 * `fallback_config.enabled` governs participation in AUTOMATIC fallback. It was
 * also vetoing explicitly pinned models, so naming a model that happened to be
 * switched off in the Fallback Chain UI quietly served a different one instead.
 *
 * Observed live: 47 enabled models on the production VPS had their fallback row
 * disabled — including groq/llama-3.1-8b-instant, both Groq compound models and
 * both Whisper models — so pinning any of them silently returned another model.
 */
describe('explicitly pinned models', () => {
  let pinnedId: number;
  let otherId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare("DELETE FROM models WHERE model_id IN ('pin-target', 'pin-other')").run();

    const { encrypted, iv, authTag } = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', encrypted, iv, authTag, 'healthy', 1);

    const insert = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, context_window, enabled, is_free)
      VALUES ('groq', ?, ?, ?, 1, 'Medium', 131072, 1, 1)
    `);
    pinnedId = Number(insert.run('pin-target', 'Pin Target', 5).lastInsertRowid);
    otherId = Number(insert.run('pin-other', 'Pin Other', 1).lastInsertRowid);

    // The pinned model is switched OFF in the chain; the other is on and ranks
    // ahead of it, so auto-routing would always choose the other one.
    const fb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, ?)');
    fb.run(pinnedId, 2, 0);
    fb.run(otherId, 1, 1);
  });

  it('serves a pinned model even when its fallback entry is disabled', () => {
    const result = routeRequest(1000, undefined, pinnedId, undefined, undefined, undefined, pinnedId);
    expect(result.modelId).toBe('pin-target');
    expect(result.modelDbId).toBe(pinnedId);
  });

  it('still skips that model for automatic routing', () => {
    const result = routeRequest();
    expect(result.modelId).toBe('pin-other');
  });

  it('does not let a sticky-session preference bypass the toggle', () => {
    // preferredModelDbId carries the implicit sticky choice — no pin argument,
    // so the disabled entry must stay skipped.
    const result = routeRequest(1000, undefined, pinnedId);
    expect(result.modelId).toBe('pin-other');
  });

  it('does not resurrect a model disabled in the catalog itself', () => {
    const db = getDb();
    db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(pinnedId);

    // models.enabled is a different, stronger switch: a retired row must stay
    // unreachable even when pinned.
    const result = routeRequest(1000, undefined, pinnedId, undefined, undefined, undefined, pinnedId);
    expect(result.modelId).toBe('pin-other');
  });
});

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setFreeOnlyMode } from '../../lib/app-settings.js';
import { listSweepTargets } from '../../services/model-sweeps.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

function addKey(platform: string, key: string) {
  const encrypted = encrypt(key);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, encrypted.encrypted, encrypted.iv, encrypted.authTag);
}

function addSweepModel(platform: string, modelId: string, priority: number) {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank,
      size_label, monthly_token_budget, context_window, enabled
    )
    VALUES (?, ?, ?, ?, 1, 'Test', '~1M', 8192, 1)
  `).run(platform, modelId, `${platform} ${modelId}`, priority);

  const row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { id: number };
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)')
    .run(row.id, priority);
  db.prepare(`
    INSERT INTO model_capabilities (model_db_id, capability, priority, enabled)
    VALUES (?, 'chat', ?, 1)
  `).run(row.id, priority);
  return row.id;
}

async function waitForSweep(app: Express, id: string) {
  for (let i = 0; i < 40; i++) {
    const response = await request(app, 'GET', `/api/model-sweeps/${id}`);
    if (response.body?.status === 'completed') return response.body;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Sweep ${id} did not complete`);
}

describe('Model sweep API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM model_runtime_health').run();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM model_capabilities').run();
    db.prepare('DELETE FROM models').run();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tests duplicate model IDs on different providers separately and quarantines failures', async () => {
    const groqModelDbId = addSweepModel('groq', 'shared-chat-model', 1);
    const openRouterModelDbId = addSweepModel('openrouter', 'shared-chat-model', 2);
    addKey('groq', 'gsk-test');
    addKey('openrouter', 'sk-or-test');

    const calls: string[] = [];
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        calls.push(`groq:${JSON.parse((init as any).body).model}`);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-sweep-groq',
            object: 'chat.completion',
            created: 123,
            model: 'shared-chat-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          }),
        } as any;
      }
      if (urlStr.includes('openrouter.ai/api/v1/chat/completions')) {
        calls.push(`openrouter:${JSON.parse((init as any).body).model}`);
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: () => Promise.resolve({ error: { message: 'Provider returned error' } }),
        } as any;
      }
      return origFetch(url, init);
    });

    const started = await request(app, 'POST', '/api/model-sweeps');
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({
      status: 'running',
      total: 2,
      completed: 0,
    });

    const done = await waitForSweep(app, started.body.id);
    expect(done).toMatchObject({
      status: 'completed',
      total: 2,
      completed: 2,
      passed: 1,
      failed: 1,
      quarantined: 1,
    });

    expect(calls).toEqual([
      'groq:shared-chat-model',
      'openrouter:shared-chat-model',
    ]);
    expect(done.results).toEqual([
      expect.objectContaining({ modelDbId: groqModelDbId, platform: 'groq', status: 'passed' }),
      expect.objectContaining({
        modelDbId: openRouterModelDbId,
        platform: 'openrouter',
        status: 'failed',
        errorCategory: 'model_unavailable',
      }),
    ]);

    const health = getDb().prepare(`
      SELECT status, last_error_category, blocked_until
      FROM model_runtime_health
      WHERE model_db_id = ?
    `).get(openRouterModelDbId) as { status: string; last_error_category: string; blocked_until: string | null };
    expect(health).toMatchObject({
      status: 'unavailable',
      last_error_category: 'model_unavailable',
    });
    expect(health.blocked_until).toBeTruthy();
  });

  it('marks zero-quota failures as confirmation-required quarantine', async () => {
    const modelDbId = addSweepModel('google', 'gemini-zero-quota-test', 1);
    addKey('google', 'google-test-key');

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('generativelanguage.googleapis.com/v1beta/models/')) {
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          json: () => Promise.resolve({
            error: {
              message: 'Quota exceeded for metric generate_content_free_tier_requests, limit: 0, model: gemini-zero-quota-test',
            },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const started = await request(app, 'POST', '/api/model-sweeps');
    expect(started.status).toBe(202);

    const done = await waitForSweep(app, started.body.id);
    expect(done).toMatchObject({
      status: 'completed',
      total: 1,
      failed: 1,
      quarantined: 1,
    });
    expect(done.results[0]).toMatchObject({
      modelDbId,
      platform: 'google',
      status: 'failed',
      errorCategory: 'zero_quota',
    });

    const fallback = await request(app, 'GET', '/api/fallback');
    expect(fallback.body.find((entry: any) => entry.modelDbId === modelDbId)).toMatchObject({
      runtimeStatus: 'unavailable',
      lastErrorCategory: 'zero_quota',
      requiresConfirmation: true,
    });
  });

  describe('free-only gating on sweep targets', () => {
    afterEach(() => {
      // Restore the default so later tests/files see the pristine ON state.
      setFreeOnlyMode(getDb(), true);
    });

    it('excludes paid rows from the sweep candidate list when free-only is ON and includes them when OFF', () => {
      const db = getDb();
      const freeModelDbId = addSweepModel('groq', 'free-sweep-model', 1);
      const paidModelDbId = addSweepModel('openrouter', 'paid-sweep-model', 2);
      db.prepare('UPDATE models SET is_free = 0 WHERE id = ?').run(paidModelDbId);
      addKey('groq', 'gsk-test');
      addKey('openrouter', 'sk-or-test');

      setFreeOnlyMode(db, true);
      const onIds = listSweepTargets().map(t => t.modelDbId);
      expect(onIds).toContain(freeModelDbId);
      expect(onIds).not.toContain(paidModelDbId);

      setFreeOnlyMode(db, false);
      const offIds = listSweepTargets().map(t => t.modelDbId);
      expect(offIds).toContain(freeModelDbId);
      expect(offIds).toContain(paidModelDbId);
    });
  });
});

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

function addKey(platform: string, key: string) {
  const db = getDb();
  const encrypted = encrypt(key);
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, encrypted.encrypted, encrypted.iv, encrypted.authTag);
}

function enableOnlyFallback(models: Array<{ platform: string; modelId: string; priority: number }>) {
  const db = getDb();
  db.prepare('UPDATE fallback_config SET enabled = 0, priority = 1000').run();

  for (const model of models) {
    const row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
      .get(model.platform, model.modelId) as { id: number } | undefined;
    expect(row, `${model.platform}/${model.modelId} must exist in test catalog`).toBeDefined();
    db.prepare('UPDATE models SET enabled = 1 WHERE id = ?').run(row!.id);
    db.prepare('UPDATE fallback_config SET enabled = 1, priority = ? WHERE model_db_id = ?')
      .run(model.priority, row!.id);
  }
}

describe('Proxy model hardening', () => {
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
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('auto-route quarantines unavailable catalog models and falls back', async () => {
    const staleModel = 'minimax/minimax-m2.5:free';
    const fallbackModel = 'llama-3.3-70b-versatile';
    enableOnlyFallback([
      { platform: 'openrouter', modelId: staleModel, priority: 1 },
      { platform: 'groq', modelId: fallbackModel, priority: 2 },
    ]);
    addKey('openrouter', 'sk-or-test');
    addKey('groq', 'gsk-test');

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('openrouter.ai/api/v1/chat/completions')) {
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: () => Promise.resolve({ error: { message: 'Provider returned error' } }),
        } as any;
      }
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        const providerBody = JSON.parse((init as any).body);
        expect(providerBody.model).toBe(fallbackModel);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-hardening',
            object: 'chat.completion',
            created: 123,
            model: fallbackModel,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(status).toBe(200);
    expect(headers.get('x-routed-via')).toBe(`groq/${fallbackModel}`);
    expect(body.choices[0].message.content).toBe('ok');

    const db = getDb();
    const stale = db.prepare(`
      SELECT h.status, h.last_error_category, h.blocked_until
      FROM model_runtime_health h
      JOIN models m ON m.id = h.model_db_id
      WHERE m.platform = 'openrouter' AND m.model_id = ?
    `).get(staleModel) as { status: string; last_error_category: string; blocked_until: string | null } | undefined;
    expect(stale).toMatchObject({
      status: 'unavailable',
      last_error_category: 'model_unavailable',
    });
    expect(stale?.blocked_until).toBeTruthy();

    const logs = db.prepare('SELECT platform, model_id, status FROM requests ORDER BY id ASC').all() as any[];
    expect(logs).toMatchObject([
      { platform: 'openrouter', model_id: staleModel, status: 'error' },
      { platform: 'groq', model_id: fallbackModel, status: 'success' },
    ]);
  });

  it('does not treat a 2xx provider error body as a successful completion', async () => {
    const bodyErrorModel = 'qwen/qwen3-coder:free';
    const fallbackModel = 'llama-3.3-70b-versatile';
    enableOnlyFallback([
      { platform: 'openrouter', modelId: bodyErrorModel, priority: 1 },
      { platform: 'groq', modelId: fallbackModel, priority: 2 },
    ]);
    addKey('openrouter', 'sk-or-test');
    addKey('groq', 'gsk-test');

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('openrouter.ai/api/v1/chat/completions')) {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            error: { message: 'Provider returned error', code: 429 },
          }),
        } as any;
      }
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        const providerBody = JSON.parse((init as any).body);
        expect(providerBody.model).toBe(fallbackModel);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-body-error-fallback',
            object: 'chat.completion',
            created: 123,
            model: fallbackModel,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(status).toBe(200);
    expect(headers.get('x-routed-via')).toBe(`groq/${fallbackModel}`);
    expect(body.choices[0].message.content).toBe('ok');

    const logs = getDb().prepare('SELECT platform, model_id, status, error FROM requests ORDER BY id ASC').all() as any[];
    expect(logs).toMatchObject([
      { platform: 'openrouter', model_id: bodyErrorModel, status: 'error' },
      { platform: 'groq', model_id: fallbackModel, status: 'success' },
    ]);
    expect(logs[0].error).toContain('Provider returned error');
  });

  it('treats chat model auto as an omitted model for SDK compatibility', async () => {
    const fallbackModel = 'llama-3.3-70b-versatile';
    enableOnlyFallback([
      { platform: 'groq', modelId: fallbackModel, priority: 1 },
    ]);
    addKey('groq', 'gsk-test');

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        const providerBody = JSON.parse((init as any).body);
        expect(providerBody.model).toBe(fallbackModel);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-auto-model',
            object: 'chat.completion',
            created: 123,
            model: fallbackModel,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(status).toBe(200);
    expect(headers.get('x-routed-via')).toBe(`groq/${fallbackModel}`);
    expect(body.choices[0].message.content).toBe('ok');
  });

  it('does not try every key for a model after the model times out', async () => {
    const slowModel = '@cf/moonshotai/kimi-k2.6';
    const fallbackModel = 'llama-3.3-70b-versatile';
    enableOnlyFallback([
      { platform: 'cloudflare', modelId: slowModel, priority: 1 },
      { platform: 'groq', modelId: fallbackModel, priority: 2 },
    ]);
    addKey('cloudflare', 'account_a:token_a');
    addKey('cloudflare', 'account_b:token_b');
    addKey('groq', 'gsk-test');

    const origFetch = global.fetch;
    let cloudflareCalls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.cloudflare.com/client/v4/accounts/')) {
        cloudflareCalls += 1;
        throw new Error('This operation was aborted');
      }
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        const providerBody = JSON.parse((init as any).body);
        expect(providerBody.model).toBe(fallbackModel);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-hardening-timeout',
            object: 'chat.completion',
            created: 123,
            model: fallbackModel,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, headers } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(status).toBe(200);
    expect(headers.get('x-routed-via')).toBe(`groq/${fallbackModel}`);
    expect(cloudflareCalls).toBe(1);

    const health = getDb().prepare(`
      SELECT h.status, h.last_error_category, h.blocked_until
      FROM model_runtime_health h
      JOIN models m ON m.id = h.model_db_id
      WHERE m.platform = 'cloudflare' AND m.model_id = ?
    `).get(slowModel) as { status: string; last_error_category: string; blocked_until: string | null } | undefined;
    expect(health).toMatchObject({
      status: 'degraded',
      last_error_category: 'timeout',
    });
    expect(health?.blocked_until).toBeTruthy();
  });

  it('treats provider zero-quota errors as confirmation-required model quarantine', async () => {
    const blockedModel = 'gemini-3.1-pro-preview';
    const fallbackModel = 'llama-3.3-70b-versatile';
    enableOnlyFallback([
      { platform: 'google', modelId: blockedModel, priority: 1 },
      { platform: 'groq', modelId: fallbackModel, priority: 2 },
    ]);
    for (let i = 0; i < 9; i++) addKey('google', `google-key-${i}`);
    addKey('groq', 'gsk-test');

    const origFetch = global.fetch;
    let googleCalls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('generativelanguage.googleapis.com/v1beta/models/')) {
        googleCalls += 1;
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          json: () => Promise.resolve({
            error: {
              message: [
                'You exceeded your current quota, please check your plan and billing details.',
                '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro',
                '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro',
                'Please retry in 33s.',
              ].join('\n'),
            },
          }),
        } as any;
      }
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        const providerBody = JSON.parse((init as any).body);
        expect(providerBody.model).toBe(fallbackModel);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-google-zero-limit',
            object: 'chat.completion',
            created: 123,
            model: fallbackModel,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, headers } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(status).toBe(200);
    expect(headers.get('x-routed-via')).toBe(`groq/${fallbackModel}`);
    expect(googleCalls).toBe(1);

    const health = getDb().prepare(`
      SELECT h.status, h.last_error_category, h.blocked_until
      FROM model_runtime_health h
      JOIN models m ON m.id = h.model_db_id
      WHERE m.platform = 'google' AND m.model_id = ?
    `).get(blockedModel) as { status: string; last_error_category: string; blocked_until: string | null } | undefined;
    expect(health).toMatchObject({
      status: 'unavailable',
      last_error_category: 'zero_quota',
    });
    expect(health?.blocked_until).toBeTruthy();
  });
});

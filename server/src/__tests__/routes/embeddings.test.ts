import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';

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

describe('Embeddings proxy route', () => {
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes embeddings to a capable provider and returns OpenAI-compatible response', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'openrouter',
      key: 'or_embedding_test_key',
      label: 'embedding-test',
    });

    const origFetch = global.fetch;
    let providerBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('openrouter.ai/api/v1/embeddings')) {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            object: 'list',
            data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
            model: providerBody.model,
            usage: { prompt_tokens: 2, total_tokens: 2 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/embeddings', {
      model: 'auto',
      input: 'hello world',
      encoding_format: 'float',
    });

    expect(status).toBe(200);
    expect(providerBody.input).toBe('hello world');
    expect(providerBody.encoding_format).toBe('float');
    expect(providerBody.model).toMatch(/embedding/i);
    expect(headers.get('X-Routed-Via')).toContain('openrouter/');
    expect(body.object).toBe('list');
    expect(body.data[0].object).toBe('embedding');
    expect(body._routed_via.platform).toBe('openrouter');
  });

  it('returns model_not_found for explicit unknown embedding model', async () => {
    const { status, body } = await request(app, 'POST', '/v1/embeddings', {
      model: 'definitely-not-an-embedding-model',
      input: 'hello',
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toContain('not in the catalog');
  });

  it('returns a routing error when no embedding-capable keys are configured', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_chat_only_key',
      label: 'chat-only',
    });

    const { status, body } = await request(app, 'POST', '/v1/embeddings', {
      input: 'hello',
    });

    expect(status).toBe(429);
    expect(body.error.type).toBe('routing_error');
    expect(body.error.message).toMatch(/embeddings/i);
  });
});

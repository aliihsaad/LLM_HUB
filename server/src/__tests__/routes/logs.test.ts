import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';

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

function insertRequest(row: {
  platform: string;
  modelId: string;
  status: 'success' | 'error';
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  error?: string | null;
  createdAt?: string;
}) {
  getDb().prepare(`
    INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.platform,
    row.modelId,
    row.status,
    row.inputTokens ?? 0,
    row.outputTokens ?? 0,
    row.latencyMs ?? 0,
    row.error ?? null,
    row.createdAt ?? '2026-05-21 12:00:00',
  );
}

describe('Logs diagnostics API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();

    await request(app, 'POST', '/api/keys', { platform: 'google', key: 'google_a', label: 'a' });
    await request(app, 'POST', '/api/keys', { platform: 'google', key: 'google_b', label: 'b' });
    await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'groq_a', label: 'a' });
    const { body: mistralKey } = await request(app, 'POST', '/api/keys', { platform: 'mistral', key: 'mistral_bad', label: 'bad' });
    db.prepare("UPDATE api_keys SET status = 'healthy' WHERE platform IN ('google', 'groq')").run();
    db.prepare("UPDATE api_keys SET status = 'invalid' WHERE id = ?").run(mistralKey.id);

    insertRequest({ platform: 'google', modelId: 'gemini-2.5-flash', status: 'success', inputTokens: 100, outputTokens: 50, latencyMs: 140, createdAt: '2026-05-21 12:00:00' });
    insertRequest({ platform: 'google', modelId: 'gemini-2.5-flash', status: 'success', inputTokens: 80, outputTokens: 40, latencyMs: 160, createdAt: '2026-05-21 12:01:00' });
    insertRequest({ platform: 'google', modelId: 'gemini-2.5-flash', status: 'error', latencyMs: 300, error: 'Google API error 429: quota exceeded', createdAt: '2026-05-21 12:02:00' });
    insertRequest({ platform: 'groq', modelId: 'llama-3.3-70b-versatile', status: 'success', inputTokens: 120, outputTokens: 60, latencyMs: 80, createdAt: '2026-05-21 12:03:00' });
    insertRequest({ platform: 'mistral', modelId: 'mistral-large-latest', status: 'error', latencyMs: 90, error: '401 invalid api key', createdAt: '2026-05-21 12:04:00' });
    insertRequest({ platform: 'openrouter', modelId: 'openai/text-embedding-3-small', status: 'error', latencyMs: 10, error: 'All embeddings models exhausted. Add more API keys or wait for rate limits to reset.', createdAt: '2026-05-21 12:05:00' });
  });

  it('returns summary, diagnosis flags, provider rankings, and recent logs', async () => {
    const { status, body } = await request(app, 'GET', '/api/logs?range=30d');

    expect(status).toBe(200);
    expect(body.summary).toMatchObject({
      totalRequests: 6,
      errorCount: 3,
      successRate: 50,
      activeProviders: 4,
      totalTokens: 450,
    });

    expect(body.rankings[0].platform).toBe('groq');
    const google = body.rankings.find((r: any) => r.platform === 'google');
    expect(google).toMatchObject({
      platform: 'google',
      requests: 3,
      errors: 1,
      keyCount: 2,
      healthyKeys: 2,
      topFlag: 'rate_limit',
    });
    expect(google.successRate).toBeCloseTo(66.7, 1);

    const flagCategories = body.flags.map((flag: any) => flag.category);
    expect(flagCategories).toContain('rate_limit');
    expect(flagCategories).toContain('auth');
    expect(flagCategories).toContain('routing');
    expect(body.flags.find((flag: any) => flag.category === 'auth')).toMatchObject({
      severity: 'critical',
      count: 1,
      platform: 'mistral',
    });

    const rateLimitLog = body.recent.find((entry: any) => entry.errorCategory === 'rate_limit');
    expect(rateLimitLog).toMatchObject({
      platform: 'google',
      status: 'error',
      severity: 'warning',
    });
    expect(rateLimitLog.suggestion).toContain('key');
  });

  it('filters recent logs and aggregates by status, platform, and limit', async () => {
    const { status, body } = await request(app, 'GET', '/api/logs?range=30d&status=error&platform=google&limit=1');

    expect(status).toBe(200);
    expect(body.summary).toMatchObject({
      totalRequests: 1,
      errorCount: 1,
      successRate: 0,
      activeProviders: 1,
    });
    expect(body.recent).toHaveLength(1);
    expect(body.recent[0]).toMatchObject({
      platform: 'google',
      status: 'error',
      errorCategory: 'rate_limit',
    });
    expect(body.rankings).toHaveLength(1);
    expect(body.rankings[0].platform).toBe('google');
  });

  it('classifies zero-quota model errors as confirmation-required quarantine', async () => {
    const db = getDb();
    db.prepare('DELETE FROM requests').run();
    insertRequest({
      platform: 'google',
      modelId: 'gemini-3.1-pro-preview',
      status: 'error',
      latencyMs: 2724,
      error: [
        'Google API error 429: You exceeded your current quota, please check your plan and billing details.',
        '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro',
        '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro',
        'Please retry in 33.3s.',
      ].join('\n'),
      createdAt: '2026-05-21 12:10:00',
    });

    const { status, body } = await request(app, 'GET', '/api/logs?range=30d&status=error&platform=google&limit=1');

    expect(status).toBe(200);
    expect(body.recent[0]).toMatchObject({
      platform: 'google',
      modelId: 'gemini-3.1-pro-preview',
      errorCategory: 'zero_quota',
      severity: 'critical',
    });
    expect(body.recent[0].suggestion).toContain('explicit confirmation');
    expect(body.flags[0]).toMatchObject({
      category: 'zero_quota',
      title: 'Zero-quota model quarantine',
    });
  });
});

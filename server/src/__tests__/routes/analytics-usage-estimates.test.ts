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

describe('Analytics usage estimates API', () => {
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
    db.prepare("UPDATE models SET monthly_token_budget = '0' WHERE platform = 'google'").run();
    db.prepare(`
      UPDATE models
      SET monthly_token_budget = '~1K'
      WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'
    `).run();
  });

  it('returns text-ready estimated token usage by provider and model', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google_account_a_key',
      label: 'account-a',
    });
    await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google_account_b_key',
      label: 'account-b',
    });

    getDb().prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, created_at)
      VALUES ('google', 'gemini-2.5-flash', 'success', 700, 500, 100, datetime('now'))
    `).run();

    const { status, body } = await request(app, 'GET', '/api/analytics/usage-estimates?range=30d');

    expect(status).toBe(200);
    expect(body.total).toMatchObject({
      usedTokens: 1200,
      estimatedMonthlyBudget: 2000,
      usagePercent: 60,
      pressure: 'medium',
    });
    expect(body.total.usageText).toBe('1.2K used of 2.0K est/mo (60%)');
    expect(body.note).toContain('Estimated from requests routed through this app');

    const google = body.providers.find((row: any) => row.platform === 'google');
    expect(google).toMatchObject({
      platform: 'google',
      activeKeyCount: 2,
      usedTokens: 1200,
      estimatedMonthlyBudget: 2000,
      usagePercent: 60,
      usageText: '1.2K used of 2.0K est/mo (60%)',
      pressure: 'medium',
    });
    expect(google.topModels[0]).toMatchObject({
      modelId: 'gemini-2.5-flash',
      usedTokens: 1200,
      estimatedMonthlyBudget: 2000,
      usagePercent: 60,
    });
  });

  it('includes every used model even when realtime audio has low logged usage', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'google_account_a_key',
      label: 'account-a',
    });

    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, created_at)
      VALUES ('google', ?, 'success', ?, 0, 100, datetime('now'))
    `);

    for (let index = 0; index < 6; index += 1) {
      insert.run(`used-chat-model-${index}`, 100 - index);
    }
    insert.run('gemini-2.5-flash-native-audio-preview-12-2025', 1);

    const { body } = await request(app, 'GET', '/api/analytics/usage-estimates?range=30d');
    const google = body.providers.find((row: any) => row.platform === 'google');

    expect(google.topModels.map((model: any) => model.modelId)).toContain('gemini-2.5-flash-native-audio-preview-12-2025');
    expect(google.topModels.length).toBe(7);
    expect(google.topModels.find((model: any) => model.modelId.includes('native-audio'))).toMatchObject({
      usedTokens: 1,
      usageText: '1 used; no estimate configured',
      usageSource: 'session_mint',
    });
  });
});

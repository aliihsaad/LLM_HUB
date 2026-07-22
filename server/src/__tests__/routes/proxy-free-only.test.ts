import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { setFreeOnlyMode } from '../../lib/app-settings.js';

async function request(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('free-only enforcement in the proxy', () => {
  let app: Express;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    // BazaarLink key so the platform is routable/listable.
    await request(app, 'POST', '/api/keys', {
      platform: 'bazaarlink', key: 'sk-bl-test', label: 'free-only-test',
    });
  });

  beforeEach(() => setFreeOnlyMode(getDb(), true));

  it('hides paid models from /v1/models when ON, shows them when OFF', async () => {
    const on = await request(app, 'GET', '/v1/models');
    const onIds = on.body.data.map((m: { id: string }) => m.id);
    expect(onIds).toContain('auto:free');
    expect(onIds).not.toContain('claude-opus-4.7');

    setFreeOnlyMode(getDb(), false);
    const off = await request(app, 'GET', '/v1/models');
    const offIds = off.body.data.map((m: { id: string }) => m.id);
    expect(offIds).toContain('claude-opus-4.7');
  });

  it('blocks an explicitly requested paid model with 403 paid_model_blocked', async () => {
    const res = await request(app, 'POST', '/v1/chat/completions', {
      model: 'claude-opus-4.7',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('paid_model_blocked');
    expect(res.body.error.message).toContain('free-tier');
  });

  it('does not block the same model when the mode is OFF', async () => {
    setFreeOnlyMode(getDb(), false);
    const res = await request(app, 'POST', '/v1/chat/completions', {
      model: 'claude-opus-4.7',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // Upstream call fails in tests (fake key) — the point is it is NOT the 403 gate.
    expect(res.status).not.toBe(403);
  });
});
